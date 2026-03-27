#!/usr/bin/env node
/**
 * Episode Analyzer — New Pass 1
 *
 * Uploads episode to GCS, runs Gemini 2.5 Pro scene+shot analysis
 * in 15-minute chunks, merges with timestamp validation, snaps to
 * ffmpeg scene cuts, extracts frames, and generates the Scene Review Report.
 *
 * Usage:
 *   node analyze-episode.mjs S02E01 "C:\Star Trek\Star Trek Tng S02e01 The Child.mp4"
 *   node analyze-episode.mjs S02E01 "C:\Star Trek\..." --skip-upload
 *   node analyze-episode.mjs S02E01 "C:\Star Trek\..." --skip-analysis
 *   node analyze-episode.mjs S02E01 "C:\Star Trek\..." --report-only
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────

const CHUNK_MINUTES = 15;
const GCS_BUCKET = 'gs://tng-video-analysis-30025';
const PROJECT = 'data-mind-456822-q3';
const REGION = 'us-central1';
const MODEL = 'gemini-2.5-pro';
const MEDIA_RESOLUTION = 'MEDIA_RESOLUTION_LOW';
const MAX_OUTPUT_TOKENS = 65536;  // 65K — 32K truncates dialogue-heavy scenes
const TEMPERATURE = 0.1;
const MAX_RETRIES = 5;                // More attempts — rate limits can persist
const RETRY_BASE_DELAY_MS = 30000;    // 30s base, doubles each retry (30/60/120/240s)
const SCENE_DETECT_THRESHOLD = 0.3;
const SNAP_MAX_DISTANCE = 2.0;
const CHUNK_COOLDOWN_MS = 30000;      // 30s between successful chunks
const MIN_CHUNK_SECONDS = 30;         // Skip chunks shorter than this

const GCLOUD_PATH = process.env.GCLOUD_PATH ||
  'C:\\Users\\steve\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin';

const ffmpegDir = path.join(__dirname, 'ffmpeg');
const subdirs = fs.readdirSync(ffmpegDir).filter(d =>
  d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory()
);
const FFMPEG = path.join(ffmpegDir, subdirs[0], 'bin', 'ffmpeg.exe');
const FFPROBE = path.join(ffmpegDir, subdirs[0], 'bin', 'ffprobe.exe');

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const EPISODE_ID = args[0];
const LOCAL_FILE = args[1];
const SKIP_UPLOAD = args.includes('--skip-upload');
const SKIP_ANALYSIS = args.includes('--skip-analysis');
const SKIP_FRAMES = args.includes('--skip-frames');
const REPORT_ONLY = args.includes('--report-only');

if (!EPISODE_ID || !LOCAL_FILE) {
  console.error('Usage: node analyze-episode.mjs EPISODE_ID "path/to/episode.mp4" [flags]');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, 'gemini-analysis', EPISODE_ID);
fs.mkdirSync(path.join(OUT_DIR, 'frames'), { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────

function getToken() {
  return execSync(`"${path.join(GCLOUD_PATH, 'gcloud')}" auth print-access-token`,
    { encoding: 'utf-8' }).trim();
}

function getDuration() {
  return parseFloat(execSync(
    `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${LOCAL_FILE}"`,
    { encoding: 'utf-8' }).trim());
}

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

// ── JSON Repair ──────────────────────────────────────────────────────
// Gemini frequently produces malformed JSON. These are the known issues:

function repairGeminiJson(text) {
  // 1. Strip markdown code fences
  text = text.replace(/^```json\s*/m, '').replace(/```\s*$/m, '');

  // 2. Fix bare values in characterExpressions objects
  //    Gemini writes: "Troi": "startled", "confused"
  //    Should be:     "Troi": "startled, confused"
  text = text.replace(/":\s*"([^"]+)",\s*\n\s*"([^"]+)"\s*\n\s*}/g, '": "$1, $2"\n        }');

  // 3. Fix trailing commas before } or ]
  text = text.replace(/,\s*}/g, '}');
  text = text.replace(/,\s*]/g, ']');

  // 4. Fix unescaped control characters in strings
  text = text.replace(/[\x00-\x1f]/g, (ch) => {
    if (ch === '\n' || ch === '\r' || ch === '\t') return ch;
    return '';
  });

  return text;
}

function extractJsonArray(rawText) {
  const text = repairGeminiJson(rawText);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    console.log(`    JSON parse error: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

// ── Upload ───────────────────────────────────────────────────────────

async function upload() {
  const gcsUri = `${GCS_BUCKET}/${EPISODE_ID}.mp4`;
  if (SKIP_UPLOAD || REPORT_ONLY) {
    console.log(`⏭️  Skip upload — using ${gcsUri}`);
    return gcsUri;
  }
  console.log(`📤 Uploading ${path.basename(LOCAL_FILE)}...`);
  execSync(`"${path.join(GCLOUD_PATH, 'gsutil')}" cp "${LOCAL_FILE}" "${gcsUri}"`,
    { stdio: 'inherit' });
  console.log(`✅ Uploaded`);
  return gcsUri;
}

// ── Gemini Analysis ──────────────────────────────────────────────────

// ── SRT Loading ──────────────────────────────────────────────────────

function findSrtFile() {
  // Look for .srt file matching the episode in the same directory as the video
  const videoDir = path.dirname(LOCAL_FILE);
  const files = fs.readdirSync(videoDir).filter(f => f.toLowerCase().endsWith('.srt'));

  // Try to match by episode ID (e.g. S02E01)
  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (epMatch) {
    const pattern = new RegExp(`s0?${epMatch[1]}e0?${epMatch[2]}`, 'i');
    const match = files.find(f => pattern.test(f));
    if (match) return path.join(videoDir, match);
  }

  return null;
}

function parseSRT(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const entries = [];
  const blocks = content.replace(/\r\n/g, '\n').split('\n\n').filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const tm = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!tm) continue;
    const start = parseInt(tm[1])*3600 + parseInt(tm[2])*60 + parseInt(tm[3]) + parseInt(tm[4])/1000;
    const end = parseInt(tm[5])*3600 + parseInt(tm[6])*60 + parseInt(tm[7]) + parseInt(tm[8])/1000;
    const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
    if (text) entries.push({ start, end, text });
  }
  return entries;
}

function getSrtForRange(srtEntries, startSec, endSec) {
  if (!srtEntries?.length) return '';
  const relevant = srtEntries.filter(s => s.start < endSec && s.end > startSec);
  if (!relevant.length) return '';
  return '\n\nSUBTITLE DATA for this time range (use exact text, attribute each line to the speaking character):\n' +
    relevant.map(s => `[${fmtTs(s.start)} → ${fmtTs(s.end)}] "${s.text}"`).join('\n');
}

function buildPrompt(startMin, endMin, srtEntries) {
  const srtSection = getSrtForRange(srtEntries, startMin * 60, endMin * 60);

  return `Analyze this Star Trek TNG episode from ${fmtTs(startMin*60)} to ${fmtTs(endMin*60)}.

Provide TWO levels:
1. SCENES — logical story segments
2. SHOTS within each scene — every camera cut

For each SCENE: sceneNumber, startTimestamp (MM:SS.s), endTimestamp (MM:SS.s), location, characters (array), mood, plotSignificance

For each SHOT: shotNumber, startTimestamp (MM:SS.s), endTimestamp (MM:SS.s), shotType (wide/medium/close-up/extreme-close-up/over-shoulder/two-shot/insert/establishing/effect), subject, action, characterExpressions (object), cameraMovement, dialogue (array of objects: {"speaker": "Character Name", "text": "exact line", "start": "MM:SS.s", "end": "MM:SS.s"}), tags (array), supercutPotential (array)

DIALOGUE RULES:
- For each shot, include ALL dialogue spoken during that shot's time range
- Use the EXACT subtitle text provided below — do not paraphrase or guess
- Identify WHO is speaking each line by watching who is talking on screen
- If a subtitle spans two shots, include it in the shot where the speaker's lips are moving
- Include the subtitle timestamps in MM:SS.s format
${srtSection}

TIMING RULES:
- Cover EVERY second from ${fmtTs(startMin*60)} to ${fmtTs(endMin*60)} — no gaps
- Shot timestamps must be continuous (shot N end = shot N+1 start)
- Scene timestamps must be continuous
- Use sub-second precision (MM:SS.s)
- Output ONLY a JSON array starting with [ ending with ]`;
}

async function analyzeChunk(gcsUri, startMin, endMin, srtEntries) {
  const chunkFile = path.join(OUT_DIR, `chunk-${startMin}-${endMin}.json`);

  // Reuse valid cached result
  if (fs.existsSync(chunkFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(chunkFile, 'utf-8'));
      const text = cached.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const scenes = extractJsonArray(text);
      if (scenes) {
        if (scenes.every(s => s.shots?.length > 0)) {
          console.log(`  ⏭️  ${startMin}-${endMin}min cached (${scenes.length} scenes)`);
          return scenes;
        }
      }
    } catch { /* re-analyze */ }
  }

  const token = getToken();
  const prompt = buildPrompt(startMin, endMin, srtEntries);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`  🔄 ${startMin}-${endMin}min (attempt ${attempt})...`);

    try {
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

      const tmpReq = path.join(OUT_DIR, `_req.json`);
      fs.writeFileSync(tmpReq, body);

      const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/${MODEL}:generateContent`;
      const result = execSync(
        `curl -s --max-time 600 "${url}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${tmpReq}"`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      );
      if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);

      const response = JSON.parse(result);

      // Check for API errors (rate limits, server errors)
      if (response.error) {
        const msg = response.error.message?.slice(0, 100) || 'unknown';
        const isRateLimit = /resource exhausted|rate limit|quota/i.test(msg);
        const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1); // exponential: 30s, 60s, 120s, 240s
        console.log(`  ⚠️  API error: ${msg}`);
        if (attempt < MAX_RETRIES) {
          console.log(`  ⏳ Backoff ${(backoff/1000).toFixed(0)}s (attempt ${attempt}/${MAX_RETRIES})...`);
          await sleep(backoff);
          continue;
        }
        return [];
      }

      fs.writeFileSync(chunkFile, JSON.stringify(response, null, 2));

      // Check for truncated response
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === 'MAX_TOKENS') {
        console.log(`  ⚠️  Response truncated (MAX_TOKENS) — output too large`);
        fs.unlinkSync(chunkFile);
        if (attempt < MAX_RETRIES) {
          const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(`  ⏳ Backoff ${(backoff/1000).toFixed(0)}s...`);
          await sleep(backoff);
          continue;
        }
        return [];
      }

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const scenes = extractJsonArray(text);
      if (!scenes) {
        console.log(`  ⚠️  No valid JSON found (or repair failed)`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_DELAY_MS);
          continue;
        }
        return [];
      }

      // CRITICAL: Never accept scenes without shots — always retry
      const noShots = scenes.filter(s => !s.shots?.length);
      if (noShots.length > 0) {
        console.log(`  ⚠️  ${noShots.length}/${scenes.length} scenes without shots`);
        fs.unlinkSync(chunkFile); // force re-analysis
        if (attempt < MAX_RETRIES) {
          const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(`  ⏳ Backoff ${(backoff/1000).toFixed(0)}s...`);
          await sleep(backoff);
          continue;
        }
        // On final attempt, return what we have but log a WARNING
        console.log(`  ⛔ GIVING UP on shots for this chunk after ${MAX_RETRIES} attempts`);
        return scenes;
      }

      const usage = response.usageMetadata || {};
      const cost = (usage.promptTokenCount || 0) * 2 / 1e6 + (usage.candidatesTokenCount || 0) * 10 / 1e6;
      const totalShots = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
      console.log(`  ✅ ${scenes.length} scenes, ${totalShots} shots ($${cost.toFixed(3)})`);
      return scenes;

    } catch (err) {
      console.log(`  ⚠️  Failed: ${err.message?.slice(0, 80)}`);
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`  ⏳ Backoff ${(backoff/1000).toFixed(0)}s...`);
        await sleep(backoff);
      }
    }
  }
  console.log(`  ⛔ Chunk ${startMin}-${endMin} FAILED after ${MAX_RETRIES} attempts`);
  return [];
}

// ── Merge ────────────────────────────────────────────────────────────

function merge(allChunks) {
  const all = [];

  for (const chunk of allChunks) {
    for (const scene of chunk) {
      const start = parseTs(scene.startTimestamp);
      const end = parseTs(scene.endTimestamp);
      if (start >= end) continue;

      // Check overlap
      const overlap = all.find(s => {
        const a = parseTs(s.startTimestamp), b = parseTs(s.endTimestamp);
        return Math.min(end, b) - Math.max(start, a) > 2;
      });
      if (overlap) continue;

      all.push(scene);
    }
  }

  // Sort by time, renumber
  all.sort((a, b) => parseTs(a.startTimestamp) - parseTs(b.startTimestamp));
  all.forEach((s, i) => { s.sceneNumber = i + 1; });

  // Report gaps
  for (let i = 1; i < all.length; i++) {
    const gap = parseTs(all[i].startTimestamp) - parseTs(all[i-1].endTimestamp);
    if (gap > 5) console.log(`  ⚠️  ${gap.toFixed(1)}s gap before scene ${all[i].sceneNumber}`);
  }

  return all;
}

// ── Scene Detection + Snap ───────────────────────────────────────────

function detectCuts(dur) {
  console.log(`🔍 ffmpeg scene detection...`);
  const out = execSync(
    `"${FFMPEG}" -i "${LOCAL_FILE}" -vf "select='gt(scene,${SCENE_DETECT_THRESHOLD})',showinfo" -vsync vfr -f null - 2>&1`,
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
  );
  const cuts = [];
  for (const line of out.split('\n')) {
    const m = line.match(/pts_time:(\d+\.?\d*)/);
    if (m && parseFloat(m[1]) <= dur) cuts.push(parseFloat(m[1]));
  }
  console.log(`  ${cuts.length} cuts found`);
  return cuts;
}

function snap(scenes, cuts) {
  let count = 0;
  for (const scene of scenes) {
    for (const shot of (scene.shots || [])) {
      for (const edge of ['start', 'end']) {
        const sec = parseTs(edge === 'start' ? shot.startTimestamp : shot.endTimestamp);
        let best = null, bestDist = Infinity;
        for (const c of cuts) {
          const d = Math.abs(c - sec);
          if (d < bestDist && d <= SNAP_MAX_DISTANCE) { bestDist = d; best = c; }
        }
        if (best !== null) {
          if (edge === 'start') {
            shot._origStart = shot.startTimestamp;
            shot._snapDistStart = Math.round(bestDist * 1000);
            shot.startTimestamp = fmtTs(best);
          } else {
            shot._origEnd = shot.endTimestamp;
            shot._snapDistEnd = Math.round(bestDist * 1000);
            shot.endTimestamp = fmtTs(best);
          }
          count++;
        }
      }
    }
  }
  console.log(`  Snapped ${count} timestamps`);
}

// ── Extract Frames ───────────────────────────────────────────────────

function extractFrames(scenes) {
  // LESSON: Always clear frames dir before extraction. Stale frames from
  // previous runs with different scene numbering cause frame/metadata mismatch.
  const framesDir = path.join(OUT_DIR, 'frames');
  if (fs.existsSync(framesDir)) {
    const staleFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
    if (staleFiles.length > 0) {
      console.log(`🗑️  Clearing ${staleFiles.length} stale frames...`);
      for (const f of staleFiles) fs.unlinkSync(path.join(framesDir, f));
    }
  }
  fs.mkdirSync(framesDir, { recursive: true });

  console.log(`📸 Extracting frames...`);
  let done = 0;
  for (const scene of scenes) {
    for (const shot of (scene.shots || [])) {
      const first = `sc${scene.sceneNumber}_sh${shot.shotNumber}_first.jpg`;
      const last = `sc${scene.sceneNumber}_sh${shot.shotNumber}_last.jpg`;
      shot._frameFirst = first;
      shot._frameLast = last;
      const fp = path.join(OUT_DIR, 'frames', first);
      const lp = path.join(OUT_DIR, 'frames', last);
      if (fs.existsSync(fp) && fs.existsSync(lp)) continue;
      try {
        const ss = parseTs(shot.startTimestamp), es = parseTs(shot.endTimestamp);
        execSync(`"${FFMPEG}" -ss ${ss.toFixed(3)} -i "${LOCAL_FILE}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${fp}" -y`, { stdio: 'pipe', timeout: 10000 });
        execSync(`"${FFMPEG}" -ss ${es.toFixed(3)} -i "${LOCAL_FILE}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${lp}" -y`, { stdio: 'pipe', timeout: 10000 });
        done++;
      } catch {}
    }
  }
  console.log(`  ${done} new shots extracted`);
}

// ── Build Report (imports from external template) ────────────────────

function buildReport(scenes, dur, settings) {
  // Import the report builder
  const totalShots = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
  console.log(`📝 Building report (${scenes.length} scenes, ${totalShots} shots)...`);

  // We generate inline since the template is self-contained
  // For brevity, delegate to rebuild-report.mjs
  try {
    execSync(`node "${path.join(__dirname, 'rebuild-report.mjs')}" "${EPISODE_ID}" "${LOCAL_FILE}"`,
      { stdio: 'inherit', cwd: __dirname });
  } catch {
    console.log(`  ⚠️  Report builder failed, using basic report`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Episode Analyzer — New Pass 1`);
  console.log(`  ${EPISODE_ID}: ${path.basename(LOCAL_FILE)}`);
  console.log(`  Chunks: ${CHUNK_MINUTES}min | Model: ${MODEL}`);
  console.log(`${'═'.repeat(50)}\n`);

  const dur = getDuration();
  const durMin = dur / 60;
  const numChunks = Math.ceil(durMin / CHUNK_MINUTES);
  console.log(`📏 ${fmtTs(dur)} (${durMin.toFixed(1)} min → ${numChunks} chunks)\n`);

  // Upload
  const gcsUri = await upload();

  // Load SRT if available
  const srtFile = findSrtFile();
  let srtEntries = [];
  if (srtFile) {
    srtEntries = parseSRT(srtFile);
    console.log(`📝 SRT loaded: ${srtEntries.length} subtitle entries from ${path.basename(srtFile)}`);
  } else {
    console.log(`⚠️  No SRT file found — dialogue will be transcribed by Gemini (less accurate)`);
  }

  // Analyze
  const allChunks = [];
  if (!SKIP_ANALYSIS && !REPORT_ONLY) {
    console.log(`\n🤖 Analyzing with ${MODEL}...`);
    for (let i = 0; i < numChunks; i++) {
      const s = i * CHUNK_MINUTES;
      const e = Math.min((i + 1) * CHUNK_MINUTES, durMin);

      // Skip tiny end chunks (< MIN_CHUNK_SECONDS) — not worth an API call
      const chunkDurSec = (e - s) * 60;
      if (chunkDurSec < MIN_CHUNK_SECONDS) {
        console.log(`  ⏭️  Skipping tiny chunk ${s}-${e}min (${chunkDurSec.toFixed(0)}s < ${MIN_CHUNK_SECONDS}s minimum)`);
        continue;
      }

      allChunks.push(await analyzeChunk(gcsUri, s, e, srtEntries));
      if (i < numChunks - 1) { console.log(`  ⏳ Cooldown ${(CHUNK_COOLDOWN_MS/1000).toFixed(0)}s...`); await sleep(CHUNK_COOLDOWN_MS); }
    }
  } else {
    console.log(`⏭️  Loading cached chunks...`);
    for (let i = 0; i < numChunks; i++) {
      const s = i * CHUNK_MINUTES, e = Math.min((i + 1) * CHUNK_MINUTES, durMin);
      const cf = path.join(OUT_DIR, `chunk-${s}-${e}.json`);
      if (fs.existsSync(cf)) {
        try {
          const d = JSON.parse(fs.readFileSync(cf, 'utf-8'));
          const t = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const parsed = extractJsonArray(t);
          if (parsed) allChunks.push(parsed);
        } catch {}
      }
    }
  }

  // Merge
  console.log(`\n🔗 Merging ${allChunks.length} chunks...`);
  const scenes = merge(allChunks);
  console.log(`  ${scenes.length} scenes`);

  // Scene detection + snap
  if (!REPORT_ONLY) {
    const cuts = detectCuts(dur);
    snap(scenes, cuts);
    // Save cut points for report builder
    fs.writeFileSync(path.join(OUT_DIR, 'cut-points.json'), JSON.stringify(cuts));
  }

  // Extract frames
  if (!SKIP_FRAMES && !REPORT_ONLY) {
    extractFrames(scenes);
  }

  // Save
  fs.writeFileSync(path.join(OUT_DIR, 'scenes.json'), JSON.stringify(scenes, null, 2));

  // Report
  buildReport(scenes, dur, {
    model: MODEL, mediaResolution: MEDIA_RESOLUTION,
    chunkMinutes: CHUNK_MINUTES, temperature: TEMPERATURE,
    maxOutputTokens: MAX_OUTPUT_TOKENS, sceneDetectThreshold: SCENE_DETECT_THRESHOLD,
    snapMaxDistance: SNAP_MAX_DISTANCE, episode: path.basename(LOCAL_FILE),
    duration: fmtTs(dur), chunks: numChunks, analyzed: new Date().toISOString()
  });

  console.log(`\n✅ Done! ${scenes.length} scenes, ${scenes.reduce((s,sc)=>s+(sc.shots?.length||0),0)} shots`);
}

main().catch(err => { console.error(`❌ ${err.message}`); process.exit(1); });
