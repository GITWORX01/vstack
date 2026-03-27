#!/usr/bin/env node
/**
 * Episode Analyzer
 *
 * Uploads a video to GCS, runs Gemini 2.5 Pro scene+shot analysis
 * in configurable time chunks, merges with timestamp validation, snaps to
 * ffmpeg scene cuts, extracts frames, and generates the Scene Review Report.
 *
 * Usage:
 *   node analyze-episode.mjs EPISODE_ID "path/to/video.mp4"
 *   node analyze-episode.mjs EPISODE_ID "path/to/video.mp4" --skip-upload
 *   node analyze-episode.mjs EPISODE_ID "path/to/video.mp4" --skip-analysis
 *   node analyze-episode.mjs EPISODE_ID "path/to/video.mp4" --report-only
 *
 * Requires a vstack.config.json in the current working directory.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getConfig, getFFmpegPath, getFFprobePath, getGCSBucket } from './config.mjs';
import {
  parseTs, fmtTs, parseSRT, sleep, getAccessToken, getVideoDuration, getSrtForRange,
} from './utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const EPISODE_ID = args[0];
const LOCAL_FILE = args[1];
const SKIP_UPLOAD = args.includes('--skip-upload');
const SKIP_ANALYSIS = args.includes('--skip-analysis');
const SKIP_FRAMES = args.includes('--skip-frames');
const REPORT_ONLY = args.includes('--report-only');

if (!EPISODE_ID || !LOCAL_FILE) {
  console.error('Usage: node analyze-episode.mjs EPISODE_ID "path/to/video.mp4" [flags]');
  console.error('\nFlags:');
  console.error('  --skip-upload     Reuse previously uploaded GCS file');
  console.error('  --skip-analysis   Load cached chunk results only');
  console.error('  --skip-frames     Skip frame extraction');
  console.error('  --report-only     Only regenerate the report from cached data');
  process.exit(1);
}

// ── Config ───────────────────────────────────────────────────────────

const cfg = getConfig();
const FFMPEG = getFFmpegPath();
const FFPROBE = getFFprobePath();

const CHUNK_MINUTES = cfg.chunkMinutes;
const MODEL = cfg.model;
const MEDIA_RESOLUTION = cfg.mediaResolution;
const MAX_OUTPUT_TOKENS = cfg.maxOutputTokens;
const TEMPERATURE = cfg.temperature;
const MAX_RETRIES = cfg.maxRetries;
const SCENE_DETECT_THRESHOLD = cfg.sceneDetectThreshold;
const SNAP_MAX_DISTANCE = cfg.snapMaxDistance;
const CHUNK_COOLDOWN_MS = cfg.chunkCooldownMs;

const OUT_DIR = path.join(cfg.projectDir, EPISODE_ID);
fs.mkdirSync(path.join(OUT_DIR, 'frames'), { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Get the video file duration in seconds.
 * @returns {number}
 */
function getDuration() {
  return getVideoDuration(LOCAL_FILE, FFPROBE);
}

/**
 * Find a matching .srt file in the same directory as the video.
 * Tries to match by episode ID pattern, then falls back to filename similarity.
 *
 * @returns {string|null} Path to the SRT file, or null if not found.
 */
function findSrtFile() {
  const videoDir = path.dirname(LOCAL_FILE);
  const videoBase = path.basename(LOCAL_FILE, path.extname(LOCAL_FILE)).toLowerCase();

  let files;
  try {
    files = fs.readdirSync(videoDir).filter(f => f.toLowerCase().endsWith('.srt'));
  } catch {
    return null;
  }

  // Try exact basename match (video.mp4 -> video.srt)
  const exactMatch = files.find(
    f => path.basename(f, '.srt').toLowerCase() === videoBase
  );
  if (exactMatch) return path.join(videoDir, exactMatch);

  // Try matching by episode ID substring
  const idLower = EPISODE_ID.toLowerCase();
  const idMatch = files.find(f => f.toLowerCase().includes(idLower));
  if (idMatch) return path.join(videoDir, idMatch);

  // Try matching episode pattern (e.g. S02E01)
  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (epMatch) {
    const pattern = new RegExp(`s0?${epMatch[1]}e0?${epMatch[2]}`, 'i');
    const match = files.find(f => pattern.test(f));
    if (match) return path.join(videoDir, match);
  }

  return null;
}

// ── Upload ───────────────────────────────────────────────────────────

/**
 * Upload the video file to GCS.
 * @returns {Promise<string>} The GCS URI of the uploaded file.
 */
async function upload() {
  const bucket = getGCSBucket();
  const gcsUri = `${bucket}/${EPISODE_ID}.mp4`;

  if (SKIP_UPLOAD || REPORT_ONLY) {
    console.log(`  Skip upload -- using ${gcsUri}`);
    return gcsUri;
  }

  console.log(`Uploading ${path.basename(LOCAL_FILE)}...`);
  const gcloudBin = cfg.gcloudPath
    ? path.join(cfg.gcloudPath, 'gsutil')
    : 'gsutil';

  execSync(`"${gcloudBin}" cp "${LOCAL_FILE}" "${gcsUri}"`, { stdio: 'inherit' });
  console.log(`Uploaded to ${gcsUri}`);
  return gcsUri;
}

// ── Gemini Analysis ──────────────────────────────────────────────────

/**
 * Build the Gemini analysis prompt for a time chunk.
 *
 * @param {number} startMin - Chunk start in minutes.
 * @param {number} endMin - Chunk end in minutes.
 * @param {Array} srtEntries - Parsed SRT entries.
 * @returns {string} The prompt text.
 */
function buildPrompt(startMin, endMin, srtEntries) {
  const srtSection = getSrtForRange(srtEntries, startMin * 60, endMin * 60);

  return `Analyze this video from ${fmtTs(startMin * 60)} to ${fmtTs(endMin * 60)}.

Provide TWO levels:
1. SCENES -- logical story segments
2. SHOTS within each scene -- every camera cut

For each SCENE: sceneNumber, startTimestamp (MM:SS.s), endTimestamp (MM:SS.s), location, characters (array), mood, plotSignificance

For each SHOT: shotNumber, startTimestamp (MM:SS.s), endTimestamp (MM:SS.s), shotType (wide/medium/close-up/extreme-close-up/over-shoulder/two-shot/insert/establishing/effect), subject, action, characterExpressions (object), cameraMovement, dialogue (array of objects: {"speaker": "Character Name", "text": "exact line", "start": "MM:SS.s", "end": "MM:SS.s"}), tags (array), supercutPotential (array)

DIALOGUE RULES:
- For each shot, include ALL dialogue spoken during that shot's time range
- Use the EXACT subtitle text provided below -- do not paraphrase or guess
- Identify WHO is speaking each line by watching who is talking on screen
- If a subtitle spans two shots, include it in the shot where the speaker's lips are moving
- Include the subtitle timestamps in MM:SS.s format
${srtSection}

TIMING RULES:
- Cover EVERY second from ${fmtTs(startMin * 60)} to ${fmtTs(endMin * 60)} -- no gaps
- Shot timestamps must be continuous (shot N end = shot N+1 start)
- Scene timestamps must be continuous
- Use sub-second precision (MM:SS.s)
- Output ONLY a JSON array starting with [ ending with ]`;
}

/**
 * Analyze a single time chunk of the video using the Gemini API.
 *
 * @param {string} gcsUri - GCS URI of the uploaded video.
 * @param {number} startMin - Chunk start in minutes.
 * @param {number} endMin - Chunk end in minutes.
 * @param {Array} srtEntries - Parsed SRT entries.
 * @returns {Promise<Array>} Array of scene objects from Gemini.
 */
async function analyzeChunk(gcsUri, startMin, endMin, srtEntries) {
  const chunkFile = path.join(OUT_DIR, `chunk-${startMin}-${endMin}.json`);

  // Reuse valid cached result
  if (fs.existsSync(chunkFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(chunkFile, 'utf-8'));
      const text = cached.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const scenes = JSON.parse(match[0]);
        if (scenes.every(s => s.shots?.length > 0)) {
          console.log(`  ${startMin}-${endMin}min cached (${scenes.length} scenes)`);
          return scenes;
        }
      }
    } catch { /* re-analyze */ }
  }

  const token = getAccessToken();
  const prompt = buildPrompt(startMin, endMin, srtEntries);
  const region = cfg.gcpRegion;
  const project = cfg.gcpProject;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`  ${startMin}-${endMin}min (attempt ${attempt})...`);

    try {
      const body = JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { fileData: { mimeType: 'video/mp4', fileUri: gcsUri } },
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature: TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          mediaResolution: MEDIA_RESOLUTION,
        },
      });

      const tmpReq = path.join(OUT_DIR, '_req.json');
      fs.writeFileSync(tmpReq, body);

      const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${MODEL}:generateContent`;
      const result = execSync(
        `curl -s --max-time 600 "${url}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${tmpReq}"`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      );
      if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);

      const response = JSON.parse(result);

      // Check for API errors
      if (response.error) {
        console.log(`  API error: ${response.error.message?.slice(0, 100)}`);
        if (attempt < MAX_RETRIES) { await sleep(15000); continue; }
        return [];
      }

      fs.writeFileSync(chunkFile, JSON.stringify(response, null, 2));

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) {
        console.log(`  No JSON found in response`);
        if (attempt < MAX_RETRIES) { await sleep(10000); continue; }
        return [];
      }

      const scenes = JSON.parse(match[0]);
      const noShots = scenes.filter(s => !s.shots?.length);
      if (noShots.length > 0 && attempt < MAX_RETRIES) {
        console.log(`  ${noShots.length} scenes without shots, retrying...`);
        fs.unlinkSync(chunkFile);
        await sleep(10000);
        continue;
      }

      const usage = response.usageMetadata || {};
      const cost =
        (usage.promptTokenCount || 0) * 2 / 1e6 +
        (usage.candidatesTokenCount || 0) * 10 / 1e6;
      const totalShots = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
      console.log(`  ${scenes.length} scenes, ${totalShots} shots ($${cost.toFixed(3)})`);
      return scenes;
    } catch (err) {
      console.log(`  Failed: ${err.message?.slice(0, 80)}`);
      if (attempt < MAX_RETRIES) await sleep(15000);
    }
  }

  return [];
}

// ── Merge ────────────────────────────────────────────────────────────

/**
 * Merge multiple analysis chunks into a single sorted scene list.
 * Deduplicates overlapping scenes and renumbers them.
 *
 * @param {Array<Array>} allChunks - Array of chunk results (each is an array of scenes).
 * @returns {Array} Merged, sorted, and renumbered scene array.
 */
function merge(allChunks) {
  const all = [];

  for (const chunk of allChunks) {
    for (const scene of chunk) {
      const start = parseTs(scene.startTimestamp);
      const end = parseTs(scene.endTimestamp);
      if (start >= end) continue;

      // Check overlap with existing scenes
      const overlap = all.find(s => {
        const a = parseTs(s.startTimestamp);
        const b = parseTs(s.endTimestamp);
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
    const gap = parseTs(all[i].startTimestamp) - parseTs(all[i - 1].endTimestamp);
    if (gap > 5) {
      console.log(`  ${gap.toFixed(1)}s gap before scene ${all[i].sceneNumber}`);
    }
  }

  return all;
}

// ── Scene Detection + Snap ───────────────────────────────────────────

/**
 * Run ffmpeg scene detection to find visual cut points.
 *
 * @param {number} dur - Total video duration in seconds.
 * @returns {number[]} Array of cut timestamps in seconds.
 */
function detectCuts(dur) {
  console.log(`Running ffmpeg scene detection...`);
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

/**
 * Snap shot timestamps to the nearest detected scene cut within tolerance.
 *
 * @param {Array} scenes - Scene array with nested shots.
 * @param {number[]} cuts - Array of cut timestamps in seconds.
 */
function snap(scenes, cuts) {
  let count = 0;
  for (const scene of scenes) {
    for (const shot of (scene.shots || [])) {
      for (const edge of ['start', 'end']) {
        const sec = parseTs(edge === 'start' ? shot.startTimestamp : shot.endTimestamp);
        let best = null;
        let bestDist = Infinity;
        for (const c of cuts) {
          const d = Math.abs(c - sec);
          if (d < bestDist && d <= SNAP_MAX_DISTANCE) {
            bestDist = d;
            best = c;
          }
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

/**
 * Extract first and last frame of each shot as JPEG thumbnails.
 *
 * @param {Array} scenes - Scene array with nested shots.
 */
function extractFrames(scenes) {
  console.log(`Extracting frames...`);
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
        const ss = parseTs(shot.startTimestamp);
        const es = parseTs(shot.endTimestamp);
        execSync(
          `"${FFMPEG}" -ss ${ss.toFixed(3)} -i "${LOCAL_FILE}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${fp}" -y`,
          { stdio: 'pipe', timeout: 10000 }
        );
        execSync(
          `"${FFMPEG}" -ss ${es.toFixed(3)} -i "${LOCAL_FILE}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${lp}" -y`,
          { stdio: 'pipe', timeout: 10000 }
        );
        done++;
      } catch { /* skip failed frames */ }
    }
  }
  console.log(`  ${done} new shots extracted`);
}

// ── Build Report ─────────────────────────────────────────────────────

/**
 * Build the Scene Review Report by delegating to rebuild-report.mjs.
 *
 * @param {Array} scenes - The merged scene array.
 * @param {number} dur - Video duration in seconds.
 */
function buildReport(scenes, dur) {
  const totalShots = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
  console.log(`Building report (${scenes.length} scenes, ${totalShots} shots)...`);

  try {
    execSync(
      `node "${path.join(__dirname, 'rebuild-report.mjs')}" "${EPISODE_ID}" "${LOCAL_FILE}"`,
      { stdio: 'inherit', cwd: process.cwd() }
    );
  } catch {
    console.log(`  Report builder failed, using basic report`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Episode Analyzer`);
  console.log(`  ${EPISODE_ID}: ${path.basename(LOCAL_FILE)}`);
  console.log(`  Chunks: ${CHUNK_MINUTES}min | Model: ${MODEL}`);
  console.log(`${'='.repeat(50)}\n`);

  const dur = getDuration();
  const durMin = dur / 60;
  const numChunks = Math.ceil(durMin / CHUNK_MINUTES);
  console.log(`Duration: ${fmtTs(dur)} (${durMin.toFixed(1)} min -> ${numChunks} chunks)\n`);

  // Upload
  const gcsUri = await upload();

  // Load SRT if available
  const srtFile = findSrtFile();
  let srtEntries = [];
  if (srtFile) {
    srtEntries = parseSRT(srtFile);
    console.log(`SRT loaded: ${srtEntries.length} subtitle entries from ${path.basename(srtFile)}`);
  } else {
    console.log(`No SRT file found -- dialogue will be transcribed by Gemini (less accurate)`);
  }

  // Analyze
  const allChunks = [];
  if (!SKIP_ANALYSIS && !REPORT_ONLY) {
    console.log(`\nAnalyzing with ${MODEL}...`);
    for (let i = 0; i < numChunks; i++) {
      const s = i * CHUNK_MINUTES;
      const e = Math.min((i + 1) * CHUNK_MINUTES, durMin);
      allChunks.push(await analyzeChunk(gcsUri, s, e, srtEntries));
      if (i < numChunks - 1) {
        console.log(`  Cooldown...`);
        await sleep(CHUNK_COOLDOWN_MS);
      }
    }
  } else {
    console.log(`Loading cached chunks...`);
    for (let i = 0; i < numChunks; i++) {
      const s = i * CHUNK_MINUTES;
      const e = Math.min((i + 1) * CHUNK_MINUTES, durMin);
      const cf = path.join(OUT_DIR, `chunk-${s}-${e}.json`);
      if (fs.existsSync(cf)) {
        try {
          const d = JSON.parse(fs.readFileSync(cf, 'utf-8'));
          const t = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const m = t.match(/\[[\s\S]*\]/);
          if (m) allChunks.push(JSON.parse(m[0]));
        } catch { /* skip invalid chunks */ }
      }
    }
  }

  // Merge
  console.log(`\nMerging ${allChunks.length} chunks...`);
  const scenes = merge(allChunks);
  console.log(`  ${scenes.length} scenes`);

  // Scene detection + snap
  if (!REPORT_ONLY) {
    const cuts = detectCuts(dur);
    snap(scenes, cuts);
  }

  // Extract frames
  if (!SKIP_FRAMES && !REPORT_ONLY) {
    extractFrames(scenes);
  }

  // Save
  fs.writeFileSync(path.join(OUT_DIR, 'scenes.json'), JSON.stringify(scenes, null, 2));

  // Report
  buildReport(scenes, dur);

  const totalShots = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
  console.log(`\nDone! ${scenes.length} scenes, ${totalShots} shots`);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
