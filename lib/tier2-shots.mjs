#!/usr/bin/env node
/**
 * Tier 2 — Enhanced Shot Metadata Analysis
 *
 * Per-scene batching with multi-frame images + audio clips + compressed output.
 *
 * Enhancements over v1:
 * - Per-SCENE batching (not fixed 30-shot batches) — clean retry boundary
 * - Multi-frame: 1 frame every 3s (all frames if shot <4s)
 * - Audio clips extracted from original video for speaker attribution
 * - Enumerated SRT dialogue — Gemini returns "Speaker|lineNum" instead of full text
 * - Compressed JSON output — short keys, ~60% fewer output tokens
 * - Billing labels: tier=tier2, episode=ID
 *
 * Usage:
 *   node tier2-shots.mjs S02E05                     # All shots
 *   node tier2-shots.mjs S02E05 --scene 5           # One scene
 *   node tier2-shots.mjs S02E05 --shot 5.3          # One shot
 *   node tier2-shots.mjs S02E05 --force             # Re-analyze even if already Tier 2
 *   node tier2-shots.mjs S02E05 --region us-east1
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env ────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

// ── Config ───────────────────────────────────────────────────────────

const PROJECT = process.env.GCP_PROJECT;
if (!PROJECT) { console.error('❌ GCP_PROJECT env var required'); process.exit(1); }

const MODEL = 'gemini-2.5-pro';
const MAX_OUTPUT_TOKENS = 65536;
const TEMPERATURE = 0.1;
const MAX_RETRIES = parseInt(process.argv.find(a => a.startsWith('--retries='))?.split('=')[1] || '0');
const FRAME_INTERVAL = 3; // Extract a frame every N seconds
const AUDIO_BITRATE = '8k'; // 8kbps mono audio for speaker identification
const CURL_TIMEOUT = 3600; // 60 minutes
const NODE_TIMEOUT = CURL_TIMEOUT * 1000 + 60000; // curl timeout + 60s buffer

const GCLOUD_PATH = process.env.GCLOUD_PATH ||
  'C:/Users/steve/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin';

const MEDIA_DIR = process.env.MEDIA_DIR || 'C:\\Star Trek';
const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');

// ── ffmpeg ───────────────────────────────────────────────────────────
const ffmpegDir = path.join(__dirname, 'ffmpeg');
const ffmpegSubs = fs.readdirSync(ffmpegDir).filter(d => d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory());
const FFMPEG = path.join(ffmpegDir, ffmpegSubs[0], 'bin', 'ffmpeg.exe');

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const EPISODE_ID = args[0];
const SCENE_FILTER = args.find(a => a === '--scene') ? parseInt(args[args.indexOf('--scene') + 1]) : null;
const SHOT_FILTER = args.find(a => a === '--shot') ? args[args.indexOf('--shot') + 1] : null;
const FORCE = args.includes('--force');
const REGION = (args.find(a => a === '--region') ? args[args.indexOf('--region') + 1] : null) || 'us-east1';

if (!EPISODE_ID) {
  console.error('Usage: node tier2-shots.mjs EPISODE_ID [--scene N] [--shot N.N] [--force] [--region R]');
  process.exit(1);
}

const OUT_DIR = path.join(ANALYSIS_DIR, EPISODE_ID);
const FRAMES_DIR = path.join(OUT_DIR, 'frames');
const TIER2_FRAMES_DIR = path.join(OUT_DIR, 'tier2-media');
const COST_LEDGER = path.join(OUT_DIR, 'cost-ledger.json');
const STATUS_FILE = path.join(OUT_DIR, '_tier2-status.json');
const LOG_FILE = path.join(OUT_DIR, 'tier2.log');

// ── Helpers ──────────────────────────────────────────────────────────

function fmtTs(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

function parseTs(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const [minStr, secStr] = ts.split(':');
  if (!secStr) return 0;
  return parseInt(minStr) * 60 + parseFloat(secStr);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getToken() {
  const gcloudBin = path.join(GCLOUD_PATH, process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud');
  return execSync(`"${gcloudBin}" auth print-access-token`, { encoding: 'utf-8' }).trim();
}

function log(msg) {
  console.log(msg);
  fs.appendFileSync(LOG_FILE, msg + '\n');
}

function writeStatus(data) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({
    ...data,
    episodeId: EPISODE_ID,
    heartbeat: new Date().toISOString()
  }));
}

function logCost(label, usage) {
  const prompt = usage.promptTokenCount || 0;
  const output = usage.candidatesTokenCount || 0;
  const thinking = usage.thoughtsTokenCount || 0;
  const inputRate = 1.25;
  const outputRate = 10.00;
  const cost = prompt * inputRate / 1e6 + (output + thinking) * outputRate / 1e6;

  let ledger = [];
  try { ledger = JSON.parse(fs.readFileSync(COST_LEDGER, 'utf-8')); } catch {}
  ledger.push({
    label, tier: 2,
    promptTokens: prompt, outputTokens: output, thinkingTokens: thinking,
    cost, timestamp: new Date().toISOString()
  });
  fs.writeFileSync(COST_LEDGER, JSON.stringify(ledger, null, 2));
  return cost;
}

// ── Find video file ─────────────────────────────────────────────────

function findVideoFile() {
  // Priority 1: Check settings.json for stored video path
  const settingsPath = path.join(OUT_DIR, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.videoPath && fs.existsSync(settings.videoPath)) return settings.videoPath;
      // Also try with forward slashes
      const fwd = settings.videoPath?.replace(/\\/g, '/');
      if (fwd && fs.existsSync(fwd)) return fwd;
    } catch {}
  }

  // Priority 2: Search MEDIA_DIR by episode pattern
  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (epMatch) {
    const s = parseInt(epMatch[1]), e = parseInt(epMatch[2]);
    const files = fs.readdirSync(MEDIA_DIR);
    const match = files.find(f => {
      const fm = f.match(/[Ss]0*(\d+)[Ee]0*(\d+)/);
      return fm && parseInt(fm[1]) === s && parseInt(fm[2]) === e && f.endsWith('.mp4');
    });
    if (match) return path.join(MEDIA_DIR, match);
  }

  // Priority 3: Search MEDIA_DIR for any file containing the episode ID
  try {
    const files = fs.readdirSync(MEDIA_DIR);
    const match = files.find(f => f.toLowerCase().includes(EPISODE_ID.toLowerCase()) && f.endsWith('.mp4'));
    if (match) return path.join(MEDIA_DIR, match);
  } catch {}

  return null;
}

// ── Load SRT subtitles ──────────────────────────────────────────────

function loadSrt() {
  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (!epMatch) return [];

  const files = fs.readdirSync(MEDIA_DIR).filter(f => f.toLowerCase().endsWith('.srt'));
  const srtFile = files.find(f => {
    if (new RegExp('s0?' + epMatch[1] + 'e0?' + epMatch[2], 'i').test(f)) return true;
    const altMatch = f.match(/(\d+)x(\d+)/i);
    if (altMatch && parseInt(altMatch[1]) === parseInt(epMatch[1]) && parseInt(altMatch[2]) === parseInt(epMatch[2])) return true;
    return false;
  });

  if (!srtFile) return [];

  const content = fs.readFileSync(path.join(MEDIA_DIR, srtFile), 'utf-8');
  const entries = [];
  const blocks = content.replace(/\r\n/g, '\n').split('\n\n').filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const tm = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!tm) continue;
    const start = parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseInt(tm[3]) + parseInt(tm[4]) / 1000;
    const end = parseInt(tm[5]) * 3600 + parseInt(tm[6]) * 60 + parseInt(tm[7]) + parseInt(tm[8]) / 1000;
    const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
    if (text) entries.push({ start, end, text, index: entries.length });
  }
  return entries;
}

// ── Extract multi-frame images for a shot ────────────────────────────

function extractFrames(videoPath, startSec, endSec, shotId) {
  const duration = endSec - startSec;
  const frames = [];

  if (duration < 4) {
    // Short shot: extract every second
    for (let t = startSec; t <= endSec; t += 1) {
      frames.push(t);
    }
  } else {
    // Every FRAME_INTERVAL seconds + start + end
    frames.push(startSec);
    for (let t = startSec + FRAME_INTERVAL; t < endSec; t += FRAME_INTERVAL) {
      frames.push(t);
    }
    if (frames[frames.length - 1] < endSec - 0.5) {
      frames.push(endSec);
    }
  }

  const paths = [];
  for (let i = 0; i < frames.length; i++) {
    const outFile = path.join(TIER2_FRAMES_DIR, `${shotId}_f${i}.jpg`);
    if (!fs.existsSync(outFile)) {
      try {
        execSync(
          `"${FFMPEG}" -ss ${frames[i].toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 5 -vf "scale=320:-1" "${outFile}" -y`,
          { stdio: 'pipe', timeout: 10000 }
        );
      } catch {}
    }
    if (fs.existsSync(outFile)) paths.push(outFile);
  }

  return paths;
}

// ── Extract audio clip for a shot ────────────────────────────────────

function extractAudio(videoPath, startSec, endSec, shotId) {
  const outFile = path.join(TIER2_FRAMES_DIR, `${shotId}_audio.mp3`);
  if (fs.existsSync(outFile)) return outFile;

  const duration = endSec - startSec;
  try {
    execSync(
      `"${FFMPEG}" -ss ${startSec.toFixed(3)} -i "${videoPath}" -t ${duration.toFixed(3)} -ac 1 -ab ${AUDIO_BITRATE} -ar 16000 "${outFile}" -y`,
      { stdio: 'pipe', timeout: 15000 }
    );
  } catch {}

  return fs.existsSync(outFile) ? outFile : null;
}

// ── Build and send per-scene Tier 2 request ──────────────────────────

async function analyzeScene(scene, shots, videoPath, srtEntries) {
  const sceneNum = scene.sceneNumber;
  const sceneStart = parseTs(scene.startTimestamp);
  const sceneEnd = parseTs(scene.endTimestamp);

  // Get SRT lines for this scene
  const sceneSrt = srtEntries.filter(s => s.start >= sceneStart - 0.5 && s.start < sceneEnd + 0.5);

  // Build enumerated dialogue
  let srtSection = '';
  if (sceneSrt.length > 0) {
    // Number lines 0, 1, 2... (scene-relative) — NOT global SRT index
    srtSection = '\nDIALOGUE (identify who speaks each line):\n' +
      sceneSrt.map((s, i) => `[${i}] "${s.text}"`).join('\n');
  }

  // Build parts: text + images + audio interleaved
  const parts = [];
  let promptText = `Scene ${sceneNum}: ${scene.location || '?'} | Characters: ${(scene.characters || []).join(', ')} | Mood: ${scene.mood || '?'}\n`;
  promptText += `${scene.plotSignificance || ''}\n\n`;

  // Add each shot's media
  for (const shot of shots) {
    const startSec = parseTs(shot.startTimestamp);
    const endSec = parseTs(shot.endTimestamp);
    const dur = (endSec - startSec).toFixed(1);
    const shotId = `sc${sceneNum}_sh${shot.shotNumber}`;

    promptText += `Shot ${shot.shotNumber} (${shot.startTimestamp} → ${shot.endTimestamp}, ${dur}s):\n`;

    // Flush text before media
    parts.push({ text: promptText });
    promptText = '';

    // Extract and add frame images
    const framePaths = extractFrames(videoPath, startSec, endSec, shotId);
    for (const fp of framePaths) {
      const b64 = fs.readFileSync(fp).toString('base64');
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
    }

    // Extract and add audio clip
    const audioPath = extractAudio(videoPath, startSec, endSec, shotId);
    if (audioPath) {
      const audioB64 = fs.readFileSync(audioPath).toString('base64');
      parts.push({ inlineData: { mimeType: 'audio/mp3', data: audioB64 } });
    }

    promptText = `[${framePaths.length} frames + ${audioPath ? 'audio' : 'no audio'}]\n\n`;
  }

  // Add the analysis instructions with compressed output format
  promptText += `\nAnalyze each shot above. Use COMPRESSED format:
{
  "n": shotNumber,
  "t": "cu" (shot type: w=wide, m=medium, cu=close-up, xcu=extreme-close-up, os=over-shoulder, 2s=two-shot, ins=insert, est=establishing, fx=effect),
  "s": "subject name",
  "a": "action description (1-2 sentences)",
  "e": "Character1:expression,Character2:expression",
  "c": "camera movement (static/pan/tilt/track/zoom/dolly)",
  "k": "tag1,tag2,tag3,...",
  "p": "category1,category2,...",
  "d": "Speaker1|lineNum,Speaker2|lineNum,..." (match dialogue lines to speakers by listening to audio)
}
${srtSection}

RULES:
- Data for EVERY shot ${shots[0].shotNumber}-${shots[shots.length - 1].shotNumber}
- Use compressed keys (n,t,s,a,e,c,k,p,d)
- For "d" field: use SRT line numbers from above, format "SpeakerName|lineNum" per line
- If no dialogue in a shot, omit "d" field
- Output ONLY a JSON array [ ... ]`;

  parts.push({ text: promptText });

  const body = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    labels: {
      tier: 'tier2',
      episode: EPISODE_ID.toLowerCase(),
      scene: String(sceneNum)
    }
  });

  const tmpReq = path.join(OUT_DIR, `_req_tier2_sc${sceneNum}.json`);
  fs.writeFileSync(tmpReq, body);

  const reqSize = (fs.statSync(tmpReq).size / 1024).toFixed(0);
  log(`   Request: ${reqSize}KB | ${shots.length} shots | ${parts.filter(p => p.inlineData?.mimeType?.startsWith('image')).length} images | ${parts.filter(p => p.inlineData?.mimeType?.startsWith('audio')).length} audio clips`);

  const totalAttempts = MAX_RETRIES + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    log(`   🔄 Attempt ${attempt}/${totalAttempts}...`);
    writeStatus({
      phase: 'running',
      scene: sceneNum,
      totalScenes: null,
      attempt,
      totalAttempts,
      shotsInScene: shots.length
    });

    try {
      const token = getToken();
      const baseUrl = REGION === 'global'
        ? `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global`
        : `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}`;
      const url = `${baseUrl}/publishers/google/models/${MODEL}:generateContent`;

      const curlReqPath = tmpReq.replace(/\\/g, '/');
      const result = execSync(
        `curl -s --max-time ${CURL_TIMEOUT} "${url}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${curlReqPath}"`,
        { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: NODE_TIMEOUT }
      );

      const response = JSON.parse(result);

      if (response.error) {
        log(`   ⚠️  API error: ${response.error.message?.slice(0, 100)}`);
        if (attempt < totalAttempts) { await sleep(15000 * attempt); continue; }
        return null;
      }

      const usage = response.usageMetadata || {};
      const cost = logCost(`tier2-scene${sceneNum}-${shots.length}shots`, usage);
      log(`   ✅ $${cost.toFixed(4)} | ${(usage.promptTokenCount / 1000).toFixed(0)}K in | ${((usage.candidatesTokenCount || 0) / 1000).toFixed(0)}K out | ${((usage.thoughtsTokenCount || 0) / 1000).toFixed(0)}K think`);

      let text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      text = text.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) {
        log(`   ⚠️  No JSON array found in response`);
        if (attempt < totalAttempts) { await sleep(10000); continue; }
        return null;
      }

      // Save raw response for debugging
      fs.writeFileSync(path.join(OUT_DIR, `_tier2_raw_sc${sceneNum}.json`), JSON.stringify(response, null, 2));
      log(`   📋 Raw response saved to _tier2_raw_sc${sceneNum}.json`);

      if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);
      const parsed = JSON.parse(match[0]);
      // Log what Gemini actually returned for dialogue
      for (const r of parsed) {
        if (r.d) log(`   🗣️  Shot ${r.n}: d="${r.d}"`);
      }
      return { results: parsed, sceneSrt };

    } catch (err) {
      log(`   ⚠️  Failed: ${err.message?.slice(0, 100)}`);
      if (attempt < totalAttempts) await sleep(15000 * attempt);
    }
  }

  if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);
  return null;
}

// ── Decompress Gemini output ─────────────────────────────────────────

function decompressShot(compressed, srtEntries, sceneSrt) {
  const shotTypeMap = {
    'w': 'wide', 'm': 'medium', 'cu': 'close-up', 'xcu': 'extreme-close-up',
    'os': 'over-shoulder', '2s': 'two-shot', 'ins': 'insert', 'est': 'establishing', 'fx': 'effect'
  };

  const result = {
    shotNumber: compressed.n,
    shotType: shotTypeMap[compressed.t] || compressed.t,
    subject: compressed.s,
    action: compressed.a,
    cameraMovement: compressed.c,
  };

  // Helper: ensure value is a string (Gemini sometimes returns arrays instead of comma-separated strings)
  const toStr = (v) => Array.isArray(v) ? v.join(',') : (typeof v === 'object' ? JSON.stringify(v) : String(v || ''));

  // Decompress expressions: "Picard:stern,Riker:amused" or {"Picard":"stern","Riker":"amused"}
  if (compressed.e) {
    if (typeof compressed.e === 'object' && !Array.isArray(compressed.e)) {
      result.characterExpressions = compressed.e; // already an object
    } else {
      result.characterExpressions = {};
      for (const pair of toStr(compressed.e).split(',')) {
        const colonIdx = pair.indexOf(':');
        if (colonIdx > 0) {
          const char = pair.slice(0, colonIdx).trim();
          const expr = pair.slice(colonIdx + 1).trim();
          if (char && expr) result.characterExpressions[char] = expr;
        }
      }
    }
  }

  // Decompress tags: "picard,bridge,command" or ["picard","bridge","command"]
  if (compressed.k) {
    result.tags = Array.isArray(compressed.k) ? compressed.k : toStr(compressed.k).split(',').map(t => t.trim()).filter(Boolean);
  }

  // Decompress supercut: "Picard Leadership,Command" or ["Picard Leadership","Command"]
  if (compressed.p) {
    result.supercutPotential = Array.isArray(compressed.p) ? compressed.p : toStr(compressed.p).split(',').map(t => t.trim()).filter(Boolean);
  }

  // Decompress dialogue: "Picard|47,Data|48" or ["Picard|47","Data|48"]
  // Gemini receives scene-relative numbered lines [0], [1], [2]...
  // So line numbers in the 'd' field are scene-relative, NOT global SRT indices.
  // We MUST use sceneSrt (the subset Gemini was given) to resolve them.
  if (compressed.d) {
    result.dialogue = [];
    const entries = Array.isArray(compressed.d) ? compressed.d : toStr(compressed.d).split(',');
    for (const entry of entries) {
      const entryStr = String(entry).trim();
      const [speaker, lineNumStr] = entryStr.split('|').map(s => s.trim());
      const lineNum = parseInt(lineNumStr);
      if (isNaN(lineNum)) continue;

      let srtLine = null;

      // Try 1: scene-relative (0-based) — this is what Gemini received in the prompt
      if (sceneSrt && lineNum >= 0 && lineNum < sceneSrt.length) {
        srtLine = sceneSrt[lineNum];
      }

      // Try 2: scene-relative (1-based) — Gemini sometimes counts from 1
      if (!srtLine && sceneSrt && lineNum >= 1 && lineNum <= sceneSrt.length) {
        srtLine = sceneSrt[lineNum - 1];
      }

      // Try 3: global SRT index (fallback — least likely to be correct)
      if (!srtLine) {
        srtLine = srtEntries.find(s => s.index === lineNum);
      }

      if (srtLine) {
        result.dialogue.push({
          speaker: speaker || 'Unknown',
          text: srtLine.text,
          start: fmtTs(srtLine.start),
          end: fmtTs(srtLine.end)
        });
      } else if (speaker && lineNumStr) {
        result.dialogue.push({ speaker, text: `[line ${lineNumStr}]`, start: '', end: '' });
      }
    }
  }

  return result;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // Clear log
  fs.writeFileSync(LOG_FILE, '');

  log(`${'═'.repeat(60)}`);
  log(`  Tier 2 — Enhanced Shot Analysis`);
  log(`  ${EPISODE_ID} | Model: ${MODEL} | Region: ${REGION}`);
  log(`  Per-scene batching | Multi-frame (every ${FRAME_INTERVAL}s) | Audio | Compressed output`);
  if (SCENE_FILTER) log(`  Filter: Scene ${SCENE_FILTER}`);
  if (SHOT_FILTER) log(`  Filter: Shot ${SHOT_FILTER}`);
  if (FORCE) log(`  Force: re-analyzing all shots`);
  log(`${'═'.repeat(60)}\n`);

  const scenes = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'scenes.json'), 'utf-8'));
  const videoPath = findVideoFile();
  if (!videoPath) { log(`❌ Video file not found for ${EPISODE_ID}`); process.exit(1); }
  log(`🎬 Video: ${path.basename(videoPath)}`);

  const srtEntries = loadSrt();
  log(`📝 SRT: ${srtEntries.length} subtitle lines`);

  // Create media directory for extracted frames/audio
  fs.mkdirSync(TIER2_FRAMES_DIR, { recursive: true });

  // Determine which scenes to process
  const scenesToProcess = scenes.filter(sc => {
    if (SCENE_FILTER && sc.sceneNumber !== SCENE_FILTER) return false;
    if (SHOT_FILTER) {
      const [s] = SHOT_FILTER.split('.');
      if (parseInt(s) !== sc.sceneNumber) return false;
    }
    return true;
  });

  let totalAnalyzed = 0;
  let totalCost = 0;
  let totalDialogue = 0;
  const startTime = Date.now();

  log(`\n📊 ${scenesToProcess.length} scenes to process\n`);

  for (let i = 0; i < scenesToProcess.length; i++) {
    const scene = scenesToProcess[i];

    // Get shots to analyze in this scene
    let shots = scene.shots || [];
    if (SHOT_FILTER) {
      const [, sh] = SHOT_FILTER.split('.');
      shots = shots.filter(s => s.shotNumber === parseInt(sh));
    } else if (!FORCE) {
      shots = shots.filter(s => s._tier !== 2);
    }

    if (shots.length === 0) {
      log(`Scene ${scene.sceneNumber}: skipped (${FORCE ? 'no shots' : 'all already Tier 2'})`);
      continue;
    }

    log(`\n🎬 Scene ${scene.sceneNumber}/${scenesToProcess.length}: ${scene.location || '?'} (${shots.length} shots)`);
    writeStatus({
      phase: 'running',
      totalScenes: scenesToProcess.length,
      currentSceneIndex: i + 1,
      scene: scene.sceneNumber,
      shotsInScene: shots.length,
      totalShotsAnalyzed: totalAnalyzed
    });

    const result = await analyzeScene(scene, shots, videoPath, srtEntries);

    if (result) {
      const { results, sceneSrt } = result;

      // Merge decompressed results back into scenes.json
      for (const compressed of results) {
        const shotNum = compressed.n || compressed.shotNumber;
        const shot = scene.shots?.find(s => s.shotNumber === shotNum);
        if (!shot) continue;

        const decompressed = decompressShot(compressed, srtEntries, result.sceneSrt);
        shot.shotType = decompressed.shotType || shot.shotType;
        shot.subject = decompressed.subject || shot.subject;
        shot.action = decompressed.action || shot.action;
        shot.characterExpressions = decompressed.characterExpressions || shot.characterExpressions;
        shot.cameraMovement = decompressed.cameraMovement || shot.cameraMovement;
        shot.tags = decompressed.tags || shot.tags;
        shot.supercutPotential = decompressed.supercutPotential || shot.supercutPotential;
        if (decompressed.dialogue?.length) {
          shot.dialogue = decompressed.dialogue;
          totalDialogue += decompressed.dialogue.length;
        }
        shot._tier = 2;
        totalAnalyzed++;
      }

      log(`   📊 ${results.length} shots enriched | ${result.results.filter(r => r.d).length} with dialogue`);

      // Save after each scene (resume-safe)
      fs.writeFileSync(path.join(OUT_DIR, 'scenes.json'), JSON.stringify(scenes, null, 2));
    } else {
      log(`   ❌ Scene ${scene.sceneNumber} failed`);
    }

    // Cooldown between scenes
    if (i < scenesToProcess.length - 1) {
      log(`   ⏳ Cooldown 5s...`);
      await sleep(5000);
    }
  }

  // Final save
  fs.writeFileSync(path.join(OUT_DIR, 'scenes.json'), JSON.stringify(scenes, null, 2));

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  let tier2Cost = 0;
  try {
    const ledger = JSON.parse(fs.readFileSync(COST_LEDGER, 'utf-8'));
    tier2Cost = ledger.filter(e => e.tier === 2).reduce((s, e) => s + e.cost, 0);
  } catch {}

  log(`\n${'═'.repeat(60)}`);
  log(`  ✅ Tier 2 Complete!`);
  log(`  ${totalAnalyzed} shots enriched | ${totalDialogue} dialogue lines attributed`);
  log(`  Tier 2 cost: $${tier2Cost.toFixed(4)} | Time: ${elapsed}min`);
  log(`${'═'.repeat(60)}\n`);

  writeStatus({
    phase: 'complete',
    totalShotsAnalyzed: totalAnalyzed,
    totalDialogue,
    cost: tier2Cost,
    elapsed: elapsed + 'min'
  });

  // Rebuild report + DB
  log(`📝 Rebuilding report + database...`);
  try {
    execSync(`node "${path.join(__dirname, 'rebuild-report.mjs')}" "${EPISODE_ID}" "${videoPath}"`, {
      cwd: __dirname, stdio: 'pipe', timeout: 60000,
      env: { ...process.env, VSTACK_NO_OPEN: '1' }
    });
    log(`✅ Report rebuilt`);
  } catch (e) {
    log(`⚠️  Report rebuild: ${e.message?.slice(0, 60)}`);
  }

  try {
    execSync(`node "${path.join(__dirname, 'db.mjs')}" --rebuild ${EPISODE_ID}`, {
      cwd: __dirname, stdio: 'pipe', timeout: 30000
    });
    log(`✅ Database updated`);
  } catch (e) {
    log(`⚠️  DB rebuild: ${e.message?.slice(0, 60)}`);
  }
}

main().catch(err => {
  log(`\n❌ Fatal: ${err.message}`);
  writeStatus({ phase: 'failed', error: err.message?.slice(0, 200) });
  process.exit(1);
});
