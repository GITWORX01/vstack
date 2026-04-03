#!/usr/bin/env node
/**
 * Re-analyze Scene — Extract a single scene, send to Gemini for Tier 1 re-analysis,
 * and replace the original scene with the resulting sub-scenes.
 *
 * Usage:
 *   node reanalyze-scene.mjs EPISODE_ID SCENE_NUMBER [--region us-east1]
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

const GCS_BUCKET = process.env.GCS_BUCKET;
const PROJECT = process.env.GCP_PROJECT;
if (!GCS_BUCKET) { console.error('GCS_BUCKET env var required'); process.exit(1); }
if (!PROJECT) { console.error('GCP_PROJECT env var required'); process.exit(1); }

const MODEL = 'gemini-2.5-pro';
const MEDIA_RESOLUTION = 'MEDIA_RESOLUTION_LOW';
const MAX_OUTPUT_TOKENS = 65536;
const TEMPERATURE = 0.1;
const LOWRES_HEIGHT = 240;
const MIN_SHOT_DURATION = 1.7;
const FRAME_OFFSET_START = 0.7;
const FRAME_OFFSET_END = -0.7;
const CURL_TIMEOUT = 3600;

const GCLOUD_PATH = process.env.GCLOUD_PATH ||
  'C:/Users/steve/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin';

const MEDIA_DIR = process.env.MEDIA_DIR || 'C:\\Star Trek';
const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');

const ffmpegDir = path.join(__dirname, 'ffmpeg');
const ffmpegSubs = fs.readdirSync(ffmpegDir).filter(d =>
  d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory()
);
const FFMPEG = path.join(ffmpegDir, ffmpegSubs[0], 'bin', 'ffmpeg.exe');
const FFPROBE = path.join(ffmpegDir, ffmpegSubs[0], 'bin', 'ffprobe.exe');

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const EPISODE_ID = args[0];
const SCENE_NUMBER = parseInt(args[1]);
const REGION = (args.find(a => a === '--region') ? args[args.indexOf('--region') + 1] : null) || 'us-east1';

if (!EPISODE_ID || isNaN(SCENE_NUMBER)) {
  console.error('Usage: node reanalyze-scene.mjs EPISODE_ID SCENE_NUMBER [--region us-east1]');
  process.exit(1);
}

const OUT_DIR = path.join(ANALYSIS_DIR, EPISODE_ID);
const FRAMES_DIR = path.join(OUT_DIR, 'frames');
const COST_LEDGER = path.join(OUT_DIR, 'cost-ledger.json');
const STATUS_FILE = path.join(OUT_DIR, '_tier2-status.json');

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
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return execSync(`"${path.join(GCLOUD_PATH, 'gcloud' + ext)}" auth print-access-token`,
    { encoding: 'utf-8' }).trim();
}

function writeStatus(data) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({
    ...data,
    episodeId: EPISODE_ID,
    sceneNumber: SCENE_NUMBER,
    heartbeat: new Date().toISOString(),
    pid: process.pid,
  }));
}

function logCost(label, usage) {
  const promptTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  const thinkingTokens = usage.thoughtsTokenCount || 0;
  const cachedTokens = usage.cachedContentTokenCount || 0;

  const inputRate = promptTokens > 200000 ? 2.50 : 1.25;
  const cachedRate = cachedTokens > 200000 ? 0.25 : 0.13;
  const outputRate = 10.00;

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

// ── Find video file ─────────────────────────────────────────────────

function findVideoFile() {
  // Priority 1: Check settings.json for stored video path
  const settingsPath = path.join(OUT_DIR, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.videoPath && fs.existsSync(settings.videoPath)) return settings.videoPath;
      const fwd = settings.videoPath?.replace(/\\/g, '/');
      if (fwd && fs.existsSync(fwd)) return fwd;
      // Try sourceFile in MEDIA_DIR
      if (settings.sourceFile) {
        const p = path.join(MEDIA_DIR, settings.sourceFile);
        if (fs.existsSync(p)) return p;
      }
    } catch {}
  }

  // Priority 2: Search MEDIA_DIR by episode pattern
  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (epMatch) {
    const s = parseInt(epMatch[1]), e = parseInt(epMatch[2]);
    try {
      const files = fs.readdirSync(MEDIA_DIR);
      const match = files.find(f => {
        const fm = f.match(/[Ss]0*(\d+)[Ee]0*(\d+)/);
        return fm && parseInt(fm[1]) === s && parseInt(fm[2]) === e && f.endsWith('.mp4');
      });
      if (match) return path.join(MEDIA_DIR, match);
    } catch {}
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

function parseSrtFile(srtPath) {
  const content = fs.readFileSync(srtPath, 'utf-8');
  const entries = [];
  const blocks = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').split('\n\n').filter(b => b.trim());

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

function loadSrt() {
  // Try 1: SxxExx pattern in MEDIA_DIR
  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (epMatch) {
    try {
      const files = fs.readdirSync(MEDIA_DIR).filter(f => f.toLowerCase().endsWith('.srt'));
      const srtFile = files.find(f => {
        if (new RegExp('s0?' + epMatch[1] + 'e0?' + epMatch[2], 'i').test(f)) return true;
        const altMatch = f.match(/(\d+)x(\d+)/i);
        if (altMatch && parseInt(altMatch[1]) === parseInt(epMatch[1]) && parseInt(altMatch[2]) === parseInt(epMatch[2])) return true;
        return false;
      });
      if (srtFile) return parseSrtFile(path.join(MEDIA_DIR, srtFile));
    } catch {}
  }

  // Try 2: Look for SRT next to the video file (from settings.json)
  const settingsPath = path.join(OUT_DIR, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const videoPath = settings.videoPath || '';
      if (videoPath) {
        const videoDir = path.dirname(videoPath);
        const srtFiles = fs.readdirSync(videoDir).filter(f => f.toLowerCase().endsWith('.srt'));
        if (srtFiles.length > 0) return parseSrtFile(path.join(videoDir, srtFiles[0]));
      }
    } catch {}
  }

  // Try 3: Search MEDIA_DIR for any SRT with episode ID in the name
  try {
    const files = fs.readdirSync(MEDIA_DIR).filter(f => f.toLowerCase().endsWith('.srt'));
    const match = files.find(f => f.toLowerCase().includes(EPISODE_ID.toLowerCase()));
    if (match) return parseSrtFile(path.join(MEDIA_DIR, match));
    if (files.length === 1) return parseSrtFile(path.join(MEDIA_DIR, files[0]));
  } catch {}

  // Try 4: Search MEDIA_DIRS
  const altDirs = (process.env.MEDIA_DIRS || '').split(';').filter(Boolean);
  for (const dir of altDirs) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.srt'));
      const match = files.find(f => f.toLowerCase().includes(EPISODE_ID.toLowerCase()));
      if (match) return parseSrtFile(path.join(dir, match));
    } catch {}
  }

  return [];
}

// ── Build Gemini prompt ─────────────────────────────────────────────

function buildScenePrompt(clipDurationSec, sceneStartSec) {
  const contentContext = process.env.CONTENT_CONTEXT || '';
  const contextLine = contentContext
    ? `\nThis video is: ${contentContext}. Adapt your analysis to this type of content — use appropriate terminology for characters/subjects, locations/settings, and categories.\n`
    : '';

  const offsetNote = sceneStartSec > 0
    ? `\nIMPORTANT: This video clip starts at ${fmtTs(sceneStartSec)} in the full episode. All timestamps you return must be RELATIVE TO THIS CLIP (starting from 00:00.0), NOT the full episode. I will adjust them afterward.\n`
    : '';

  return `Analyze this video and break it into SCENES. A scene is a continuous segment in one location with the same group of characters/subjects.
${contextLine}${offsetNote}
For each scene provide:
- sceneNumber (sequential starting from 1)
- startTimestamp (MM:SS.s format with sub-second precision)
- endTimestamp (MM:SS.s)
- location (where the scene takes place)
- characters (array of character names present — identify by listening to dialogue and watching)
- mood (emotional tone of the scene)
- plotSignificance (1-2 sentence summary of what happens and why it matters)
- lighting (describe the lighting: bright, dim, dramatic shadows, etc.)
- costuming (notable costume details: uniforms, civilian clothes, alien attire)
- music (describe the score/music you hear: tense, uplifting, quiet, dramatic, none)
- tags (array of searchable keywords — be generous: character names, locations, themes, emotions, objects, visual elements)
- supercutPotential (array of compilation categories this scene could appear in — use categories specific to this content, e.g. "Emotional Moments", "Action Sequences", "Comedy", "Character Development", "Establishing Shots", "Dramatic Reveals", "Confrontations")

RULES:
- Cover EVERY second of the video — no gaps between scenes
- Scene timestamps must be continuous (scene N endTimestamp = scene N+1 startTimestamp)
- Use sub-second precision (MM:SS.s)
- Output ONLY a JSON array starting with [ and ending with ]
- Total video duration is approximately ${fmtTs(clipDurationSec)}`;
}

// ── Call Gemini ──────────────────────────────────────────────────────

async function callGeminiForScenes(gcsUri, prompt) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [
      { fileData: { mimeType: 'video/mp4', fileUri: gcsUri } },
      { text: prompt }
    ]}],
    generationConfig: {
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      mediaResolution: MEDIA_RESOLUTION
    },
    labels: {
      tier: 'reanalyze',
      episode: EPISODE_ID.toLowerCase(),
      scene: String(SCENE_NUMBER)
    }
  });

  const tmpReq = path.join(OUT_DIR, `_req_reanalyze_sc${SCENE_NUMBER}.json`);
  fs.writeFileSync(tmpReq, body);

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`   Attempt ${attempt}/${maxAttempts}...`);
    writeStatus({ phase: 'analyzing', step: 'Gemini API call', attempt, maxAttempts });

    try {
      const token = getToken();
      const baseUrl = REGION === 'global'
        ? `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global`
        : `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}`;
      const url = `${baseUrl}/publishers/google/models/${MODEL}:generateContent`;

      const curlReqPath = tmpReq.replace(/\\/g, '/');
      const result = execSync(
        `curl -s --max-time ${CURL_TIMEOUT} "${url}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${curlReqPath}"`,
        { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: (CURL_TIMEOUT + 60) * 1000 }
      );

      const response = JSON.parse(result);

      if (response.error) {
        const msg = response.error.message?.slice(0, 100) || 'unknown';
        console.log(`   API error: ${msg}`);
        if (attempt < maxAttempts) {
          const delay = 30000 * Math.pow(2, attempt - 1);
          console.log(`   Backoff ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
        return null;
      }

      const usage = response.usageMetadata || {};
      const cost = logCost(`reanalyze-scene-${SCENE_NUMBER}`, usage);
      console.log(`   Scene analysis complete — $${cost.toFixed(4)}`);
      console.log(`   Input: ${((usage.promptTokenCount || 0) / 1000).toFixed(0)}K | Output: ${((usage.candidatesTokenCount || 0) / 1000).toFixed(0)}K | Thinking: ${((usage.thoughtsTokenCount || 0) / 1000).toFixed(0)}K`);

      // Parse JSON from response
      let text = (response.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || '').join('\n');
      text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      text = text.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) {
        console.log(`   No JSON array found in response`);
        if (attempt < maxAttempts) { await sleep(15000); continue; }
        return null;
      }

      const scenes = JSON.parse(match[0]);
      console.log(`   ${scenes.length} sub-scenes detected`);

      // Save raw response
      fs.writeFileSync(path.join(OUT_DIR, `reanalyze-sc${SCENE_NUMBER}-raw.json`), JSON.stringify(response, null, 2));

      if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);
      return scenes;

    } catch (err) {
      console.log(`   Failed: ${err.message?.slice(0, 120)}`);
      if (attempt < maxAttempts) {
        const delay = 30000 * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }

  if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);
  return null;
}

// ── Detect shots with PySceneDetect ──────────────────────────────────

function detectShots(clipPath) {
  console.log(`\n   Running PySceneDetect on clip...`);

  let shots = [];
  try {
    execSync(
      `scenedetect -i "${clipPath}" -o "${OUT_DIR}" detect-adaptive list-scenes -q`,
      { encoding: 'utf-8', timeout: 300000, maxBuffer: 50 * 1024 * 1024 }
    );

    const csvBaseName = path.basename(clipPath).replace(/\.[^.]+$/, '-Scenes.csv');
    const csvCandidates = [
      path.join(OUT_DIR, csvBaseName),
      path.join(path.dirname(clipPath), csvBaseName),
      csvBaseName,
      path.join(process.cwd(), csvBaseName),
    ];
    const csvFile = csvCandidates.find(f => fs.existsSync(f));

    if (csvFile) {
      const csv = fs.readFileSync(csvFile, 'utf-8');
      const lines = csv.split('\n').filter(l => l.trim() && !l.startsWith('Scene'));
      for (const line of lines) {
        const parts = line.split(',');
        if (parts.length < 4) continue;
        const num = parseInt(parts[0]);
        if (isNaN(num)) continue;
        const startSec = parseFloat(parts[3]) || 0;
        const endSec = parseFloat(parts[6]) || 0;
        if (endSec > startSec) {
          shots.push({ shotNumber: num, startSec, endSec, duration: endSec - startSec });
        }
      }
      fs.unlinkSync(csvFile);
    }
  } catch (e) {
    console.log(`   PySceneDetect failed: ${e.message?.slice(0, 80)}`);
  }

  // Merge short shots
  const merged = [];
  for (const shot of shots) {
    if (merged.length > 0 && shot.duration < MIN_SHOT_DURATION) {
      merged[merged.length - 1].endSec = shot.endSec;
      merged[merged.length - 1].duration = merged[merged.length - 1].endSec - merged[merged.length - 1].startSec;
    } else {
      merged.push({ ...shot });
    }
  }
  merged.forEach((s, i) => { s.shotNumber = i + 1; });

  console.log(`   ${shots.length} shots detected -> ${merged.length} after merging (min ${MIN_SHOT_DURATION}s)`);
  return merged;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Re-analyze Scene ${SCENE_NUMBER} — ${EPISODE_ID}`);
  console.log(`  Region: ${REGION}`);
  console.log(`${'='.repeat(60)}\n`);

  writeStatus({ phase: 'starting', step: 'loading data' });

  // ── 1. Load scene data ──────────────────────────────────────────────

  const scenesPath = path.join(OUT_DIR, 'scenes.json');
  if (!fs.existsSync(scenesPath)) {
    console.error(`scenes.json not found: ${scenesPath}`);
    writeStatus({ phase: 'failed', error: 'scenes.json not found' });
    process.exit(1);
  }

  const allScenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));
  const targetScene = allScenes.find(sc => sc.sceneNumber === SCENE_NUMBER);

  if (!targetScene) {
    console.error(`Scene ${SCENE_NUMBER} not found in scenes.json (${allScenes.length} scenes total)`);
    writeStatus({ phase: 'failed', error: `Scene ${SCENE_NUMBER} not found` });
    process.exit(1);
  }

  console.log(`Target scene: #${SCENE_NUMBER}`);
  console.log(`  Time: ${targetScene.startTimestamp} -> ${targetScene.endTimestamp}`);
  console.log(`  Location: ${targetScene.location || 'unknown'}`);
  console.log(`  Shots: ${targetScene.shots?.length || 0}`);

  // ── 2. Find video file ──────────────────────────────────────────────

  const videoPath = findVideoFile();
  if (!videoPath) {
    console.error('Could not find video file');
    writeStatus({ phase: 'failed', error: 'Video file not found' });
    process.exit(1);
  }
  console.log(`Video: ${path.basename(videoPath)}`);

  // ── 3. Extract clip ─────────────────────────────────────────────────

  const sceneStartSec = parseTs(targetScene.startTimestamp);
  const sceneEndSec = parseTs(targetScene.endTimestamp);
  const clipDuration = sceneEndSec - sceneStartSec;

  if (clipDuration <= 0) {
    console.error(`Invalid scene duration: ${clipDuration}s`);
    writeStatus({ phase: 'failed', error: 'Invalid scene duration' });
    process.exit(1);
  }

  console.log(`\nExtracting ${LOWRES_HEIGHT}p clip: ${fmtTs(sceneStartSec)} -> ${fmtTs(sceneEndSec)} (${clipDuration.toFixed(1)}s)`);
  writeStatus({ phase: 'extracting-clip', step: `Extracting ${clipDuration.toFixed(0)}s clip` });

  const clipPath = path.join(OUT_DIR, `${EPISODE_ID}_reanalyze_sc${SCENE_NUMBER}.mp4`);

  try {
    execSync(
      `"${FFMPEG}" -ss ${sceneStartSec.toFixed(3)} -i "${videoPath}" -t ${clipDuration.toFixed(3)} -vf "scale=-2:${LOWRES_HEIGHT}" -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 8k -ac 1 "${clipPath}" -y`,
      { stdio: 'pipe', timeout: 300000 }
    );
    const clipSize = fs.statSync(clipPath).size;
    console.log(`  Clip created: ${(clipSize / 1e6).toFixed(1)} MB`);
  } catch (e) {
    console.error(`ffmpeg clip extraction failed: ${e.message?.slice(0, 100)}`);
    writeStatus({ phase: 'failed', error: 'Clip extraction failed' });
    process.exit(1);
  }

  // ── 4. Upload to GCS ───────────────────────────────────────────────

  const gcsUri = `${GCS_BUCKET}/${EPISODE_ID}_reanalyze.mp4`;
  console.log(`\nUploading to ${gcsUri}...`);
  writeStatus({ phase: 'uploading', step: 'Uploading clip to GCS' });

  try {
    const ext = process.platform === 'win32' ? '.cmd' : '';
    execSync(`"${path.join(GCLOUD_PATH, 'gsutil' + ext)}" cp "${clipPath}" "${gcsUri}"`,
      { stdio: 'pipe', timeout: 600000 });
    console.log(`  Uploaded`);
  } catch (e) {
    console.error(`GCS upload failed: ${e.message?.slice(0, 100)}`);
    writeStatus({ phase: 'failed', error: 'GCS upload failed' });
    process.exit(1);
  }

  // ── 5. Call Gemini ─────────────────────────────────────────────────

  console.log(`\nCalling Gemini (${MODEL}) for scene analysis...`);
  writeStatus({ phase: 'analyzing', step: 'Gemini Tier 1 analysis' });

  const prompt = buildScenePrompt(clipDuration, sceneStartSec);
  const newScenes = await callGeminiForScenes(gcsUri, prompt);

  if (!newScenes || newScenes.length === 0) {
    console.error('Gemini returned no scenes');
    writeStatus({ phase: 'failed', error: 'No scenes from Gemini' });
    process.exit(1);
  }

  // ── 6. Adjust timestamps (clip-relative -> absolute) ───────────────

  console.log(`\nAdjusting timestamps (adding ${fmtTs(sceneStartSec)} offset)...`);

  for (const scene of newScenes) {
    const relStart = parseTs(scene.startTimestamp);
    const relEnd = parseTs(scene.endTimestamp);
    scene.startTimestamp = fmtTs(relStart + sceneStartSec);
    scene.endTimestamp = fmtTs(relEnd + sceneStartSec);
  }

  // ── 7. Run PySceneDetect on clip for shot boundaries ───────────────

  console.log(`\nDetecting shot boundaries in clip...`);
  writeStatus({ phase: 'detecting-shots', step: 'PySceneDetect on clip' });

  const clipShots = detectShots(clipPath);

  // Adjust shot timestamps to absolute (clip-relative -> episode-relative)
  for (const shot of clipShots) {
    shot.startSec += sceneStartSec;
    shot.endSec += sceneStartSec;
  }

  // ── 8. Assign shots to scenes by midpoint ──────────────────────────

  console.log(`\nAssigning ${clipShots.length} shots to ${newScenes.length} scenes...`);

  const parsedScenes = newScenes.map(sc => ({
    ...sc,
    _startSec: parseTs(sc.startTimestamp),
    _endSec: parseTs(sc.endTimestamp),
    shots: [],
    dialogue: [],
  }));

  let shotNum = 1;
  for (const shot of clipShots) {
    const midpoint = (shot.startSec + shot.endSec) / 2;
    const scene = parsedScenes.find(sc => midpoint >= sc._startSec && midpoint <= sc._endSec)
      || parsedScenes[parsedScenes.length - 1];

    if (scene) {
      scene.shots.push({
        shotNumber: shotNum,
        startTimestamp: fmtTs(shot.startSec),
        endTimestamp: fmtTs(shot.endSec),
        shotType: 'unknown',
        subject: 'Unknown',
        action: '',
        characterExpressions: {},
        cameraMovement: 'static',
        tags: [],
        supercutPotential: [],
        dialogue: [],
        _tier: 1,
        _frameFirst: `sc${scene.sceneNumber}_sh${shotNum}_first.jpg`,
        _frameLast: `sc${scene.sceneNumber}_sh${shotNum}_last.jpg`,
      });
    }
    shotNum++;
  }

  // If no shots were detected by PySceneDetect, create a synthetic shot per scene
  for (const scene of parsedScenes) {
    if (scene.shots.length === 0) {
      scene.shots.push({
        shotNumber: 1,
        startTimestamp: scene.startTimestamp || fmtTs(scene._startSec),
        endTimestamp: scene.endTimestamp || fmtTs(scene._endSec),
        shotType: 'unknown',
        subject: 'Unknown',
        action: '',
        characterExpressions: {},
        cameraMovement: 'static',
        tags: [],
        supercutPotential: [],
        dialogue: [],
        _tier: 1,
        _synthetic: true,
        _frameFirst: `sc${scene.sceneNumber}_sh1_first.jpg`,
        _frameLast: `sc${scene.sceneNumber}_sh1_last.jpg`,
      });
    }
  }

  // ── 9. Assign SRT dialogue ─────────────────────────────────────────

  console.log(`\nLoading SRT dialogue...`);
  const srtEntries = loadSrt();
  let dialogueAssigned = 0;

  if (srtEntries.length > 0) {
    // Filter to entries within our scene's time range
    const sceneEntries = srtEntries.filter(e =>
      e.start >= sceneStartSec - 0.5 && e.start <= sceneEndSec + 0.5
    );

    for (const entry of sceneEntries) {
      const scene = parsedScenes.find(sc =>
        entry.start >= sc._startSec - 0.5 && entry.start <= sc._endSec + 0.5
      );
      if (!scene) continue;

      const dlgEntry = {
        speaker: 'Unknown',
        text: entry.text,
        start: fmtTs(entry.start),
        end: fmtTs(entry.end),
      };

      scene.dialogue.push(dlgEntry);
      dialogueAssigned++;

      // Also assign to the specific shot
      const BOUNDARY_THRESHOLD = 0.5;
      let assignedShot = null;
      for (let si = 0; si < scene.shots.length; si++) {
        const sh = scene.shots[si];
        if (sh._synthetic) continue;
        const shStart = parseTs(sh.startTimestamp);
        const shEnd = parseTs(sh.endTimestamp);
        if (entry.start >= shStart - 0.3 && entry.start < shEnd) {
          if (shEnd - entry.start < BOUNDARY_THRESHOLD && si + 1 < scene.shots.length) {
            assignedShot = scene.shots[si + 1];
          } else {
            assignedShot = sh;
          }
          break;
        }
      }
      if (assignedShot) {
        assignedShot.dialogue.push(dlgEntry);
      }
    }
    console.log(`  ${dialogueAssigned} dialogue lines assigned`);
  } else {
    console.log(`  No SRT found`);
  }

  // ── 10. Replace scene in scenes.json ───────────────────────────────

  console.log(`\nReplacing scene ${SCENE_NUMBER} with ${parsedScenes.length} sub-scenes...`);
  writeStatus({ phase: 'replacing-scene', step: 'Updating scenes.json' });

  // Clean up internal fields from parsedScenes
  for (const scene of parsedScenes) {
    delete scene._startSec;
    delete scene._endSec;
    // Renumber shots within each scene
    scene.shots.forEach((sh, i) => {
      sh.shotNumber = i + 1;
    });
  }

  // Find and replace
  const targetIdx = allScenes.findIndex(sc => sc.sceneNumber === SCENE_NUMBER);
  if (targetIdx === -1) {
    console.error(`Scene ${SCENE_NUMBER} no longer found in scenes.json`);
    writeStatus({ phase: 'failed', error: 'Scene disappeared from scenes.json' });
    process.exit(1);
  }

  allScenes.splice(targetIdx, 1, ...parsedScenes);

  // Renumber all scenes sequentially
  allScenes.forEach((sc, i) => {
    sc.sceneNumber = i + 1;
    // Update shot frame filenames to match new scene numbers
    if (sc.shots) {
      sc.shots.forEach((sh, si) => {
        sh._frameFirst = `sc${i + 1}_sh${si + 1}_first.jpg`;
        sh._frameLast = `sc${i + 1}_sh${si + 1}_last.jpg`;
      });
    }
  });

  console.log(`  Total scenes: ${allScenes.length} (was ${allScenes.length - parsedScenes.length + 1})`);

  // ── 11. Extract frames from ORIGINAL video ─────────────────────────

  console.log(`\nExtracting frames for new sub-scenes from original video...`);
  writeStatus({ phase: 'extracting-frames', step: 'Extracting shot frames' });

  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  let framesExtracted = 0;

  // Only extract frames for the newly inserted scenes
  const newStartIdx = targetIdx;
  const newEndIdx = targetIdx + parsedScenes.length;

  for (let si = newStartIdx; si < newEndIdx; si++) {
    const scene = allScenes[si];
    for (const shot of (scene.shots || [])) {
      const startSec = parseTs(shot.startTimestamp);
      const endSec = parseTs(shot.endTimestamp);
      const firstSec = Math.max(0, startSec + FRAME_OFFSET_START);
      const lastSec = Math.max(0, endSec + FRAME_OFFSET_END);

      const firstPath = path.join(FRAMES_DIR, shot._frameFirst);
      const lastPath = path.join(FRAMES_DIR, shot._frameLast);

      try {
        execSync(`"${FFMPEG}" -ss ${firstSec.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${firstPath}" -y`,
          { stdio: 'pipe', timeout: 10000 });
        execSync(`"${FFMPEG}" -ss ${lastSec.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${lastPath}" -y`,
          { stdio: 'pipe', timeout: 10000 });
        framesExtracted++;
      } catch {}
    }
  }
  console.log(`  ${framesExtracted} shot frames extracted`);

  // ── 12. Save scenes.json ───────────────────────────────────────────

  console.log(`\nSaving scenes.json...`);
  fs.writeFileSync(scenesPath, JSON.stringify(allScenes, null, 2));
  console.log(`  Saved (${allScenes.length} scenes)`);

  // ── 13. Rebuild DB ─────────────────────────────────────────────────

  console.log(`\nRebuilding database...`);
  writeStatus({ phase: 'rebuilding-db', step: 'Rebuilding search index' });

  try {
    execSync(`node "${path.join(__dirname, 'db.mjs')}" --rebuild ${EPISODE_ID}`,
      { cwd: __dirname, stdio: 'pipe', timeout: 30000 });
    console.log(`  Database rebuilt`);
  } catch (e) {
    console.log(`  DB rebuild failed: ${e.message?.slice(0, 50)}`);
  }

  // ── 14. Clean up ──────────────────────────────────────────────────

  try {
    if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
    console.log(`  Temp clip deleted`);
  } catch {}

  // ── 15. Write final status ─────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Re-analysis complete!`);
  console.log(`  Scene ${SCENE_NUMBER} -> ${parsedScenes.length} sub-scenes`);
  console.log(`  Total scenes: ${allScenes.length}`);
  console.log(`  Time: ${elapsed}s`);
  console.log(`${'='.repeat(60)}`);

  writeStatus({
    phase: 'complete',
    originalScene: SCENE_NUMBER,
    newSceneCount: parsedScenes.length,
    totalScenes: allScenes.length,
    elapsed: parseFloat(elapsed),
  });
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  console.error(err.stack);
  writeStatus({ phase: 'failed', error: err.message });
  process.exit(1);
});
