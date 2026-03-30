#!/usr/bin/env node
/**
 * Episode Analyzer v2 — Cost-optimized pipeline
 *
 * 1. PySceneDetect (local, FREE) → exact shot boundaries
 * 2. ffmpeg → 240p no-audio version (~44MB vs ~700MB)
 * 3. Single Gemini API call with shot markers → rich metadata for ALL shots
 * 4. SRT subtitles → speaker-attributed dialogue (FREE)
 * 5. ffmpeg → frame extraction from ORIGINAL video (full quality)
 *
 * Cost: ~$0.83/episode vs ~$7+/episode (old approach)
 *
 * Usage:
 *   node analyze-episode-v2.mjs S02E01 "C:\Star Trek\episode.mp4" [--region us-east1] [--skip-upload]
 */

import fs from 'fs';
import path from 'path';
import { execSync, exec } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────

const GCS_BUCKET = process.env.GCS_BUCKET;
const PROJECT = process.env.GCP_PROJECT;
if (!GCS_BUCKET) { console.error('❌ GCS_BUCKET env var required (e.g. gs://vstack-media-east)'); process.exit(1); }
if (!PROJECT) { console.error('❌ GCP_PROJECT env var required (e.g. vstack-pipleline-v2)'); process.exit(1); }
const MODEL = 'gemini-2.5-pro';
const MEDIA_RESOLUTION = 'MEDIA_RESOLUTION_LOW';
const MAX_OUTPUT_TOKENS = 65536;
const TEMPERATURE = 0.1;
const MAX_RETRIES = parseInt(process.argv.find(a => a.startsWith('--retries='))?.split('=')[1] || '2');
const RETRY_BASE_MS = 30000;
const LOWRES_HEIGHT = 240;
const MIN_SHOT_DURATION = 1.7; // seconds
const FRAME_OFFSET_START = 0.7;  // +700ms for start frames
const FRAME_OFFSET_END = -0.7;   // -700ms for end frames

const GCLOUD_PATH = process.env.GCLOUD_PATH ||
  'C:\\Users\\steve\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin';

const ffmpegDir = path.join(__dirname, 'ffmpeg');
const ffmpegSubs = fs.readdirSync(ffmpegDir).filter(d =>
  d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory()
);
const FFMPEG = path.join(ffmpegDir, ffmpegSubs[0], 'bin', 'ffmpeg.exe');
const FFPROBE = path.join(ffmpegDir, ffmpegSubs[0], 'bin', 'ffprobe.exe');

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const EPISODE_ID = args[0];
const LOCAL_FILE = args[1];
const SKIP_UPLOAD = args.includes('--skip-upload');
const REGION = (args.find(a => a === '--region') ? args[args.indexOf('--region') + 1] : null) || 'us-east1';

if (!EPISODE_ID || !LOCAL_FILE) {
  console.error('Usage: node analyze-episode-v2.mjs EPISODE_ID "path/to/episode.mp4" [--region R] [--skip-upload]');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, 'gemini-analysis', EPISODE_ID);
fs.mkdirSync(path.join(OUT_DIR, 'frames'), { recursive: true });

const LOG_FILE = path.join(OUT_DIR, `analysis-${new Date().toISOString().slice(0, 10)}.log`);
const COST_LEDGER = path.join(OUT_DIR, 'cost-ledger.json');

// ── Logging ──────────────────────────────────────────────────────────

const origLog = console.log;
const origError = console.error;
function log(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  origLog(msg);
  try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch {}
}
function logError(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  origError(msg);
  try { fs.appendFileSync(LOG_FILE, 'ERROR: ' + msg + '\n'); } catch {}
}
console.log = log;
console.error = logError;

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

function fmtBytes(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes > 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
  return bytes + ' B';
}

function getFileSize(filePath) {
  return fs.statSync(filePath).size;
}

function getToken() {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return execSync(`"${path.join(GCLOUD_PATH, 'gcloud' + ext)}" auth print-access-token`,
    { encoding: 'utf-8' }).trim();
}

function getDuration() {
  return parseFloat(execSync(
    `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${LOCAL_FILE}"`,
    { encoding: 'utf-8' }).trim());
}

function writeStatus(data) {
  const statusFile = path.join(OUT_DIR, '_analysis-status.json');
  const existing = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf-8')) : {};
  fs.writeFileSync(statusFile, JSON.stringify({
    ...existing, ...data,
    episodeId: EPISODE_ID,
    heartbeat: new Date().toISOString(),
    pid: process.pid,
  }, null, 2));
}

function logCost(label, usage) {
  const promptTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  const thinkingTokens = usage.thoughtsTokenCount || 0;
  const cachedTokens = usage.cachedContentTokenCount || 0;

  // Correct Gemini 2.5 Pro pricing
  const inputRate = promptTokens > 200000 ? 2.50 : 1.25;
  const cachedRate = cachedTokens > 200000 ? 0.25 : 0.13;
  const outputRate = 10.00; // includes thinking tokens

  const uncachedInput = promptTokens - cachedTokens;
  const inputCost = uncachedInput * inputRate / 1e6 + cachedTokens * cachedRate / 1e6;
  const outputCost = (outputTokens + thinkingTokens) * outputRate / 1e6;
  const totalCost = inputCost + outputCost;

  const entry = {
    label, timestamp: new Date().toISOString(),
    promptTokens, outputTokens, thinkingTokens, cachedTokens,
    inputCost: Math.round(inputCost * 10000) / 10000,
    outputCost: Math.round(outputCost * 10000) / 10000,
    cost: Math.round(totalCost * 10000) / 10000,
  };

  let ledger = [];
  try { ledger = JSON.parse(fs.readFileSync(COST_LEDGER, 'utf-8')); } catch {}
  ledger.push(entry);
  fs.writeFileSync(COST_LEDGER, JSON.stringify(ledger, null, 2));

  return totalCost;
}

// ── Step 1: PySceneDetect (local, FREE) ──────────────────────────────

function detectShots() {
  console.log(`\n🎬 Step 1: Shot detection (PySceneDetect — local, FREE)`);
  console.log(`   Source: ${path.basename(LOCAL_FILE)} (${fmtBytes(getFileSize(LOCAL_FILE))})`);
  writeStatus({ phase: 'detecting-shots', step: 'PySceneDetect' });

  // Use low-res version if it exists (much faster to scan), otherwise original
  const lowResPath = path.join(OUT_DIR, `${EPISODE_ID}_${LOWRES_HEIGHT}p.mp4`);
  const scanFile = fs.existsSync(lowResPath) ? lowResPath : LOCAL_FILE;
  console.log(`   Scanning: ${path.basename(scanFile)} (${fmtBytes(getFileSize(scanFile))})`);

  // Run PySceneDetect with output dir set to our analysis directory
  const result = execSync(
    `scenedetect -i "${scanFile}" -o "${OUT_DIR}" detect-adaptive list-scenes -q`,
    { encoding: 'utf-8', timeout: 900000, maxBuffer: 50 * 1024 * 1024 }
  );

  // PySceneDetect creates CSV based on input filename — check multiple locations
  const csvBaseName = path.basename(scanFile).replace(/\.[^.]+$/, '-Scenes.csv');
  const csvCandidates = [
    path.join(OUT_DIR, csvBaseName),                          // -o flag output dir
    path.join(path.dirname(scanFile), csvBaseName),           // next to input file
    csvBaseName,                                               // CWD
    path.join(process.cwd(), csvBaseName),                    // explicit CWD
  ];
  const csvFile = csvCandidates.find(f => fs.existsSync(f));
  let shots = [];

  if (csvFile) {
    console.log(`   📄 CSV found: ${path.basename(csvFile)}`);
  } else {
    console.log(`   ⚠️  No CSV found (checked: ${csvCandidates.map(f => path.basename(f)).join(', ')})`);
  }

  if (csvFile) {
    const csv = fs.readFileSync(csvFile, 'utf-8');
    const lines = csv.split('\n').filter(l => l.trim() && !l.startsWith('Scene'));
    // Skip header line(s)
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 4) continue;
      const num = parseInt(parts[0]);
      if (isNaN(num)) continue;

      // PySceneDetect CSV: Scene Number, Start Frame, Start Timecode, Start Time (seconds), ...
      const startSec = parseFloat(parts[3]) || 0;
      const endSec = parseFloat(parts[6]) || 0;
      if (endSec > startSec) {
        shots.push({ shotNumber: num, startSec, endSec, duration: endSec - startSec });
      }
    }
    // Clean up CSV file
    fs.unlinkSync(csvFile);
  }

  if (shots.length === 0) {
    // Fallback: parse from stdout
    console.log('   ⚠️  No CSV output, falling back to ffmpeg scene detection');
    const ffResult = execSync(
      `"${FFMPEG}" -i "${LOCAL_FILE}" -vf "select='gt(scene,0.3)',showinfo" -vsync vfr -f null - 2>&1`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );
    const cuts = [0];
    for (const line of ffResult.split('\n')) {
      const m = line.match(/pts_time:(\d+\.?\d*)/);
      if (m) cuts.push(parseFloat(m[1]));
    }
    const duration = getDuration();
    cuts.push(duration);
    for (let i = 0; i < cuts.length - 1; i++) {
      shots.push({ shotNumber: i + 1, startSec: cuts[i], endSec: cuts[i + 1], duration: cuts[i + 1] - cuts[i] });
    }
  }

  // Merge shots shorter than MIN_SHOT_DURATION
  const merged = [];
  for (const shot of shots) {
    if (merged.length > 0 && shot.duration < MIN_SHOT_DURATION) {
      // Merge into previous shot
      merged[merged.length - 1].endSec = shot.endSec;
      merged[merged.length - 1].duration = merged[merged.length - 1].endSec - merged[merged.length - 1].startSec;
    } else {
      merged.push({ ...shot });
    }
  }
  // Renumber
  merged.forEach((s, i) => { s.shotNumber = i + 1; });

  console.log(`   ✅ ${shots.length} shots detected → ${merged.length} after merging (min ${MIN_SHOT_DURATION}s)`);
  return merged;
}

// ── Step 2: Create low-res version ───────────────────────────────────

function createLowRes() {
  const lowResPath = path.join(OUT_DIR, `${EPISODE_ID}_${LOWRES_HEIGHT}p.mp4`);

  // Also check for old no-audio version and reuse if exists
  const oldPath = path.join(OUT_DIR, `${EPISODE_ID}_${LOWRES_HEIGHT}p.mp4`);

  if (fs.existsSync(lowResPath)) {
    const size = getFileSize(lowResPath);
    console.log(`\n📐 Step 1: Low-res version exists (${fmtBytes(size)})`);
    return lowResPath;
  }

  console.log(`\n📐 Step 1: Creating ${LOWRES_HEIGHT}p with 16k mono audio`);
  console.log(`   Source: ${fmtBytes(getFileSize(LOCAL_FILE))}`);
  writeStatus({ phase: 'creating-lowres', step: `${LOWRES_HEIGHT}p + 16k audio` });

  execSync(
    `"${FFMPEG}" -i "${LOCAL_FILE}" -vf "scale=-2:${LOWRES_HEIGHT}" -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 16k -ac 1 "${lowResPath}" -y`,
    { stdio: 'pipe', timeout: 300000 }
  );

  const size = getFileSize(lowResPath);
  console.log(`   ✅ Created: ${fmtBytes(size)} (${((1 - size / getFileSize(LOCAL_FILE)) * 100).toFixed(0)}% smaller)`);
  return lowResPath;
}

// ── Step 3: Upload low-res to GCS ────────────────────────────────────

function uploadToGCS(lowResPath) {
  const gcsUri = `${GCS_BUCKET}/${EPISODE_ID}_lowres.mp4`;

  if (SKIP_UPLOAD) {
    console.log(`\n📤 Step 3: Skip upload — using ${gcsUri}`);
    console.log(`   Local file: ${fmtBytes(getFileSize(lowResPath))}`);
    return gcsUri;
  }

  const size = getFileSize(lowResPath);
  console.log(`\n📤 Step 3: Uploading low-res version (${fmtBytes(size)})`);
  writeStatus({ phase: 'uploading', step: `Uploading ${fmtBytes(size)}` });

  const ext = process.platform === 'win32' ? '.cmd' : '';
  execSync(`"${path.join(GCLOUD_PATH, 'gsutil' + ext)}" cp "${lowResPath}" "${gcsUri}"`,
    { stdio: 'inherit', timeout: 600000 });

  console.log(`   ✅ Uploaded: ${gcsUri} (${fmtBytes(size)})`);
  return gcsUri;
}

// ── Step 4: Load SRT subtitles ───────────────────────────────────────

function loadSRT() {
  const videoDir = path.dirname(LOCAL_FILE);
  const files = fs.readdirSync(videoDir).filter(f => f.toLowerCase().endsWith('.srt'));
  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (!epMatch) return [];

  const srtFile = files.find(f => {
    const s = f.toLowerCase();
    const sMatch = s.match(/s0?(\d+)e0?(\d+)/i) || s.match(/(\d+)x0?(\d+)/i);
    if (sMatch && parseInt(sMatch[1]) === parseInt(epMatch[1]) && parseInt(sMatch[2]) === parseInt(epMatch[2])) return true;
    return false;
  });

  if (!srtFile) {
    console.log(`\n📝 Step 4: No SRT subtitle file found`);
    return [];
  }

  const content = fs.readFileSync(path.join(videoDir, srtFile), 'utf-8');
  const blocks = content.replace(/\r\n/g, '\n').split('\n\n').filter(b => b.trim());
  const entries = [];

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const tm = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!tm) continue;
    const start = parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseInt(tm[3]) + parseInt(tm[4]) / 1000;
    const end = parseInt(tm[5]) * 3600 + parseInt(tm[6]) * 60 + parseInt(tm[7]) + parseInt(tm[8]) / 1000;
    const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
    if (text) entries.push({ start, end, text });
  }

  console.log(`\n📝 Step 4: SRT loaded — ${entries.length} subtitle entries from ${srtFile}`);
  return entries;
}

// ── Step 5: Single Gemini API call ───────────────────────────────────

// ── Tier 1: Scene analysis — ONE Gemini call for the whole episode ────
// Returns scene-level metadata. Shot boundaries come from PySceneDetect.
// Tier 2 (shot metadata) is separate and deferred.

async function analyzeScenes(gcsUri, shots, srtEntries, durationSec) {
  console.log(`\n🤖 Step 5: Gemini scene analysis — SINGLE API call (Tier 1)`);
  console.log(`   Model: ${MODEL} | Region: ${REGION}`);
  console.log(`   Video: ${gcsUri}`);
  console.log(`   Shots detected locally: ${shots.length} (for reference only)`);
  writeStatus({ phase: 'analyzing', step: 'Tier 1 — scene analysis', totalShots: shots.length });

  // Build numbered SRT — Gemini returns just line numbers + speakers (saves ~70% output tokens)
  let srtSection = '';
  if (srtEntries.length > 0) {
    srtSection = '\n\nNUMBERED SUBTITLE LINES (identify the speaker for each line by listening to the audio and watching who talks):\n' +
      srtEntries.map((s, i) => `[${i + 1}] [${fmtTs(s.start)}] "${s.text}"`).join('\n');
  }

  const prompt = `Analyze this video (which includes audio) and break it into SCENES. A scene is a continuous segment in one location with the same group of characters.

For each scene provide:
- sceneNumber (sequential starting from 1)
- startTimestamp (MM:SS.s format with sub-second precision)
- endTimestamp (MM:SS.s)
- location (where the scene takes place)
- characters (array of character names present)
- mood (emotional tone of the scene)
- plotSignificance (1-2 sentence summary of what happens and why it matters)
- lighting (describe the lighting: bright, dim, dramatic shadows, etc.)
- costuming (notable costume details: uniforms, civilian clothes, alien attire)
- music (describe the score/music you hear: tense, uplifting, quiet, dramatic, none)
- tags (array of searchable keywords — be generous: character names, locations, themes, emotions, objects, visual elements)
- supercutPotential (array of compilation categories this scene could appear in, e.g. "Picard Leadership", "Emotional Moments", "Ship Beauty Shots", "Comedy", "Action", "Briefing Room", "Ready Room")
- dialogue (array of {line, speaker} — use the line NUMBERS from the subtitle list below, identify who speaks by LISTENING to the audio. Do NOT repeat the text, just the line number and speaker name)
${srtSection}

RULES:
- Cover EVERY second of the video — no gaps between scenes
- Scene timestamps must be continuous (scene N endTimestamp = scene N+1 startTimestamp)
- Use sub-second precision (MM:SS.s)
- Output ONLY a JSON array starting with [ and ending with ]
- Total video duration is approximately ${fmtTs(durationSec)}`;

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [
      { fileData: { mimeType: 'video/mp4', fileUri: gcsUri } },
      { text: prompt }
    ]}],
    generationConfig: {
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      mediaResolution: MEDIA_RESOLUTION
    }
  });

  const tmpReq = path.join(OUT_DIR, '_req_scenes.json');
  fs.writeFileSync(tmpReq, body);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`   🔄 Attempt ${attempt}/${MAX_RETRIES}...`);
    writeStatus({ phase: 'analyzing', attempt, maxRetries: MAX_RETRIES });

    try {
      const token = getToken();
      const baseUrl = REGION === 'global'
        ? `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global`
        : `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}`;
      const url = `${baseUrl}/publishers/google/models/${MODEL}:generateContent`;

      const result = execSync(
        `curl -s --max-time 900 "${url}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${tmpReq}"`,
        { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: 960000 }
      );

      const response = JSON.parse(result);

      if (response.error) {
        const msg = response.error.message?.slice(0, 100) || 'unknown';
        console.log(`   ⚠️  API error: ${msg}`);
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          console.log(`   ⏳ Backoff ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
        return null;
      }

      const usage = response.usageMetadata || {};
      const cost = logCost('tier1-scenes', usage);
      console.log(`   ✅ Scene analysis complete — $${cost.toFixed(4)}`);
      console.log(`      Input: ${(usage.promptTokenCount / 1000).toFixed(0)}K | Output: ${((usage.candidatesTokenCount || 0) / 1000).toFixed(0)}K | Thinking: ${((usage.thoughtsTokenCount || 0) / 1000).toFixed(0)}K`);

      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === 'MAX_TOKENS') {
        console.log(`   ⚠️  Response truncated — some scenes may be missing`);
      }

      let text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      text = text.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) {
        console.log(`   ⚠️  No JSON array found in response`);
        if (attempt < MAX_RETRIES) { await sleep(15000); continue; }
        return null;
      }

      const scenes = JSON.parse(match[0]);
      console.log(`   📊 ${scenes.length} scenes detected`);

      // Save raw response for debugging
      fs.writeFileSync(path.join(OUT_DIR, 'tier1-raw-response.json'), JSON.stringify(response, null, 2));

      if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);
      return scenes;

    } catch (err) {
      console.log(`   ⚠️  Failed: ${err.message?.slice(0, 80)}`);
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }

  if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);
  return null;
}

// ── Step 6: Merge shot boundaries with metadata + SRT ────────────────

function mergeData(shots, metadata, srtEntries) {
  console.log(`\n🔗 Step 6: Merging shot boundaries + metadata + dialogue`);

  // Create a map from shot number to metadata
  const metaMap = {};
  for (const m of (metadata || [])) {
    metaMap[m.shotNumber] = m;
  }

  // Assign SRT dialogue to shots based on timestamp overlap
  let dialogueAssigned = 0;

  const scenes = [{
    sceneNumber: 1,
    startTimestamp: fmtTs(0),
    endTimestamp: fmtTs(shots[shots.length - 1]?.endSec || 0),
    location: 'Full Episode',
    characters: [],
    mood: '',
    plotSignificance: '',
    shots: []
  }];

  for (const shot of shots) {
    const meta = metaMap[shot.shotNumber] || {};

    // Build shot object
    const shotObj = {
      shotNumber: shot.shotNumber,
      startTimestamp: fmtTs(shot.startSec),
      endTimestamp: fmtTs(shot.endSec),
      shotType: meta.shotType || 'unknown',
      subject: meta.subject || 'Unknown',
      action: meta.action || '',
      characterExpressions: meta.characterExpressions || {},
      cameraMovement: meta.cameraMovement || 'static',
      tags: meta.tags || [],
      supercutPotential: meta.supercutPotential || [],
      dialogue: [],
      _frameFirst: `sc1_sh${shot.shotNumber}_first.jpg`,
      _frameLast: `sc1_sh${shot.shotNumber}_last.jpg`,
    };

    // Assign dialogue from metadata first
    if (meta.dialogue && Array.isArray(meta.dialogue)) {
      shotObj.dialogue = meta.dialogue;
      dialogueAssigned += meta.dialogue.length;
    }

    // If no dialogue from metadata, assign from SRT by timestamp overlap
    if (shotObj.dialogue.length === 0 && srtEntries.length > 0) {
      const overlapping = srtEntries.filter(s =>
        s.start >= shot.startSec - 0.5 && s.start <= shot.endSec + 0.5
      );
      if (overlapping.length > 0) {
        shotObj.dialogue = overlapping.map(s => ({
          speaker: 'Unknown',
          text: s.text,
          start: fmtTs(s.start),
          end: fmtTs(s.end),
        }));
        dialogueAssigned += overlapping.length;
      }
    }

    // Collect characters for scene
    if (meta.subject) {
      const chars = meta.subject.split(/[,&]/).map(c => c.trim()).filter(c => c.length > 1);
      for (const c of chars) {
        if (!scenes[0].characters.includes(c)) scenes[0].characters.push(c);
      }
    }

    scenes[0].shots.push(shotObj);
  }

  console.log(`   ✅ ${shots.length} shots merged | ${dialogueAssigned} dialogue lines assigned`);
  console.log(`   📋 Characters found: ${scenes[0].characters.slice(0, 10).join(', ')}`);

  return scenes;
}

// ── Step 7: Extract frames ───────────────────────────────────────────

function extractFrames(scenes) {
  console.log(`\n📸 Step 7: Extracting frames from ORIGINAL video (full quality)`);
  console.log(`   Source: ${path.basename(LOCAL_FILE)} (${fmtBytes(getFileSize(LOCAL_FILE))})`);
  writeStatus({ phase: 'extracting-frames' });

  // Clear existing frames
  const framesDir = path.join(OUT_DIR, 'frames');
  if (fs.existsSync(framesDir)) {
    const oldFrames = fs.readdirSync(framesDir);
    for (const f of oldFrames) fs.unlinkSync(path.join(framesDir, f));
  }

  let extracted = 0;
  for (const scene of scenes) {
    for (const shot of (scene.shots || [])) {
      const startSec = parseTs(shot.startTimestamp);
      const endSec = parseTs(shot.endTimestamp);
      const firstSec = Math.max(0, startSec + FRAME_OFFSET_START);
      const lastSec = Math.max(0, endSec + FRAME_OFFSET_END);

      const firstPath = path.join(framesDir, shot._frameFirst);
      const lastPath = path.join(framesDir, shot._frameLast);

      try {
        execSync(`"${FFMPEG}" -ss ${firstSec.toFixed(3)} -i "${LOCAL_FILE}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${firstPath}" -y`,
          { stdio: 'pipe', timeout: 10000 });
        execSync(`"${FFMPEG}" -ss ${lastSec.toFixed(3)} -i "${LOCAL_FILE}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${lastPath}" -y`,
          { stdio: 'pipe', timeout: 10000 });
        extracted++;
      } catch {}

      if (extracted % 50 === 0 && extracted > 0) {
        process.stdout.write(`   ${extracted} shots...`);
        writeStatus({ phase: 'extracting-frames', framesExtracted: extracted });
      }
    }
  }
  console.log(`\n   ✅ ${extracted} shot frames extracted`);
}

// ── Step 8: Save + build report + rebuild DB ─────────────────────────

function finalize(scenes, durationSec) {
  console.log(`\n📝 Step 8: Saving and building report`);

  // Save scenes.json
  const scenesPath = path.join(OUT_DIR, 'scenes.json');
  fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2));
  console.log(`   ✅ scenes.json saved (${scenes.length} scenes, ${scenes[0]?.shots?.length || 0} shots)`);

  // Save analysis settings
  const settings = {
    version: 'v2',
    pipeline: 'PySceneDetect + 240p no-audio + single Gemini call',
    model: MODEL,
    mediaResolution: MEDIA_RESOLUTION,
    lowResHeight: LOWRES_HEIGHT,
    minShotDuration: MIN_SHOT_DURATION,
    frameOffsetStart: FRAME_OFFSET_START,
    frameOffsetEnd: FRAME_OFFSET_END,
    region: REGION,
    sourceFile: path.basename(LOCAL_FILE),
    sourceSize: fmtBytes(getFileSize(LOCAL_FILE)),
    duration: fmtTs(durationSec),
    analyzedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'settings.json'), JSON.stringify(settings, null, 2));

  // Rebuild report
  writeStatus({ phase: 'building-report' });
  try {
    execSync(`node "${path.join(__dirname, 'rebuild-report.mjs')}" "${EPISODE_ID}" "${LOCAL_FILE}"`,
      { cwd: __dirname, stdio: 'pipe', timeout: 60000, env: { ...process.env, VSTACK_NO_OPEN: '1' } });
    console.log(`   ✅ Scene Review Report built`);
  } catch (e) {
    console.log(`   ⚠️  Report build failed: ${e.message?.slice(0, 50)}`);
  }

  // Rebuild DB
  writeStatus({ phase: 'rebuilding-db' });
  try {
    execSync(`node "${path.join(__dirname, 'db.mjs')}" --rebuild ${EPISODE_ID}`,
      { cwd: __dirname, stdio: 'pipe', timeout: 30000 });
    console.log(`   ✅ Database rebuilt`);
  } catch (e) {
    console.log(`   ⚠️  DB rebuild failed: ${e.message?.slice(0, 50)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Episode Analyzer v2 — Cost-Optimized Pipeline`);
  console.log(`  ${EPISODE_ID}: ${path.basename(LOCAL_FILE)}`);
  console.log(`  Source: ${fmtBytes(getFileSize(LOCAL_FILE))}`);
  console.log(`${'═'.repeat(60)}\n`);

  writeStatus({ phase: 'starting', version: 'v2' });

  // Duration
  const durationSec = getDuration();
  console.log(`📏 Duration: ${fmtTs(durationSec)} (${(durationSec / 60).toFixed(1)} min)`);

  // Step 1: Create low-res version (used for both shot detection AND Gemini)
  const lowResPath = createLowRes();
  const lowResSize = getFileSize(lowResPath);

  // Step 2: Local shot detection on low-res (FREE, fast)
  const shots = detectShots();
  console.log(`   📊 Low-res file: ${fmtBytes(lowResSize)}`);

  // Step 3: Upload low-res to GCS
  const gcsUri = uploadToGCS(lowResPath);

  // Step 4: Load SRT
  const srtEntries = loadSRT();

  // Step 5: Tier 1 — Scene analysis (ONE Gemini call)
  const geminiScenes = await analyzeScenes(gcsUri, shots, srtEntries, durationSec);

  if (!geminiScenes) {
    console.log(`\n❌ Analysis failed — Gemini did not return scene data`);
    writeStatus({ phase: 'failed', error: 'Gemini scene analysis failed' });
    process.exit(1);
  }

  // Step 6: Build scenes with embedded shot boundaries from PySceneDetect
  console.log(`\n🔗 Step 6: Merging Gemini scenes with local shot boundaries`);

  // Attach shot boundaries to each scene
  for (const scene of geminiScenes) {
    const sceneStart = parseTs(scene.startTimestamp);
    const sceneEnd = parseTs(scene.endTimestamp);

    // Find shots that fall within this scene's time range
    scene.shots = shots.filter(s => s.startSec >= sceneStart - 0.5 && s.endSec <= sceneEnd + 0.5)
      .map(s => ({
        shotNumber: s.shotNumber,
        startTimestamp: fmtTs(s.startSec),
        endTimestamp: fmtTs(s.endSec),
        _frameFirst: `sc${scene.sceneNumber}_sh${s.shotNumber}_first.jpg`,
        _frameLast: `sc${scene.sceneNumber}_sh${s.shotNumber}_last.jpg`,
        _tier: 1,
      }));

    // If no shots found, create a single shot spanning the entire scene
    if (scene.shots.length === 0) {
      const syntheticNum = 9000 + scene.sceneNumber; // high number to avoid conflicts
      scene.shots = [{
        shotNumber: syntheticNum,
        startTimestamp: scene.startTimestamp,
        endTimestamp: scene.endTimestamp,
        _frameFirst: `sc${scene.sceneNumber}_sh${syntheticNum}_first.jpg`,
        _frameLast: `sc${scene.sceneNumber}_sh${syntheticNum}_last.jpg`,
        _tier: 1,
        _synthetic: true, // marker — no PySceneDetect cut found, full-scene shot
      }];
    }
  }

  // Reconstruct dialogue from Gemini's line numbers + SRT text
  if (srtEntries.length > 0) {
    console.log(`   💬 Reconstructing dialogue from line numbers...`);
    let attributed = 0;
    let unattributed = 0;

    for (const scene of geminiScenes) {
      const sceneStart = parseTs(scene.startTimestamp);
      const sceneEnd = parseTs(scene.endTimestamp);

      // Build speaker lookup from Gemini's dialogue line references
      const speakerMap = {};
      if (scene.dialogue && Array.isArray(scene.dialogue)) {
        for (const d of scene.dialogue) {
          if (d.line && d.speaker) {
            speakerMap[d.line] = d.speaker;
          }
        }
      }

      // Match SRT entries to this scene by timestamp, add speaker from Gemini
      scene.dialogue = srtEntries
        .map((s, i) => ({ ...s, lineNum: i + 1 }))
        .filter(s => s.start >= sceneStart - 0.5 && s.start < sceneEnd + 0.5)
        .map(s => {
          const speaker = speakerMap[s.lineNum] || null;
          if (speaker) attributed++;
          else unattributed++;
          return {
            speaker,
            text: s.text,
            start: fmtTs(s.start),
            end: fmtTs(s.end),
            _lineNum: s.lineNum,
          };
        });
    }
    console.log(`   ✅ ${attributed} lines with speaker attribution, ${unattributed} unattributed`);
  }

  const totalShotsAssigned = geminiScenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
  const unassignedShots = shots.length - totalShotsAssigned;
  console.log(`   ${geminiScenes.length} scenes | ${totalShotsAssigned} shots assigned | ${unassignedShots} unassigned`);

  // Step 7: Save shot boundaries separately for Tier 2
  fs.writeFileSync(path.join(OUT_DIR, 'shot-boundaries.json'), JSON.stringify(shots, null, 2));
  console.log(`   💾 Shot boundaries saved (${shots.length} shots) for Tier 2`);

  // Step 8: Extract frames from ORIGINAL (full quality)
  extractFrames(geminiScenes);

  // Step 9: Save + report + DB
  finalize(geminiScenes, durationSec);

  // Final summary
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  let totalCost = 0;
  try {
    const ledger = JSON.parse(fs.readFileSync(COST_LEDGER, 'utf-8'));
    totalCost = ledger.reduce((s, e) => s + e.cost, 0);
  } catch {}

  writeStatus({ phase: 'complete', totalCost, elapsed: elapsed + 'min', scenes: geminiScenes.length, shots: totalShotsAssigned });

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅ Tier 1 Analysis Complete!`);
  console.log(`  ${geminiScenes.length} scenes | ${totalShotsAssigned} shots | ${srtEntries.length} subtitle lines`);
  console.log(`  Cost: $${totalCost.toFixed(4)} | Time: ${elapsed} min`);
  console.log(`  Source: ${fmtBytes(getFileSize(LOCAL_FILE))} | Low-res: ${fmtBytes(lowResSize)}`);
  console.log(`  💡 Run Tier 2 for shot-level metadata (shotType, subject, action, expressions)`);
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err.message}`);
  writeStatus({ phase: 'failed', error: err.message?.slice(0, 200) });
  process.exit(1);
});
