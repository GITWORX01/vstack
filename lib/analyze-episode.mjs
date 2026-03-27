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
const GCS_BUCKET = 'gs://tng-video-analysis-east';
const PROJECT = 'data-mind-456822-q3';
const MODEL = 'gemini-2.5-pro';

// ── Region Failover ─────────────────────────────────────────────────
// Auto-rotates to next region after consecutive rate limits.
const REGIONS = ['us-east1', 'us-central1', 'europe-west1', 'asia-northeast1'];
const RATE_LIMIT_THRESHOLD = 3; // consecutive rate limits before rotating
let _regionIndex = 0;
let _consecutiveRateLimits = 0;

function getRegion() { return REGIONS[_regionIndex]; }

function onRateLimit() {
  _consecutiveRateLimits++;
  if (_consecutiveRateLimits >= RATE_LIMIT_THRESHOLD) {
    const oldRegion = REGIONS[_regionIndex];
    _regionIndex = (_regionIndex + 1) % REGIONS.length;
    _consecutiveRateLimits = 0;
    console.log(`    🌍 Region failover: ${oldRegion} → ${REGIONS[_regionIndex]} (${RATE_LIMIT_THRESHOLD} consecutive rate limits)`);
    return true; // signal that region changed
  }
  return false;
}

function onSuccess() { _consecutiveRateLimits = 0; }
const MEDIA_RESOLUTION = 'MEDIA_RESOLUTION_LOW';
const MAX_OUTPUT_TOKENS = 65536;  // 65K — 32K truncates dialogue-heavy scenes
const TEMPERATURE = 0.1;
const MAX_RETRIES = 5;                // More attempts — rate limits can persist
const RETRY_BASE_DELAY_MS = 30000;    // 30s base, doubles each retry (30/60/120/240s)
const SCENE_DETECT_THRESHOLD = 0.3;
const SNAP_MAX_DISTANCE = 2.0;
const CHUNK_COOLDOWN_MS = 30000;      // 30s between successful chunks
const MIN_CHUNK_SECONDS = 30;         // Skip chunks shorter than this
const CACHE_TTL_SECONDS = 21600;      // 6 hours — two-pass with rate limits needs more time
const USE_CONTEXT_CACHE = !process.argv.includes('--no-cache'); // Enable by default

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

// ── Context Cache ────────────────────────────────────────────────────
// Cache the video tokens once, then reuse for all chunks at 90% discount.
// Creates: projects/PROJECT/locations/REGION/cachedContents/CACHE_ID
// Saves ~60-72% on multi-chunk episodes.

async function createVideoCache(gcsUri) {
  if (!USE_CONTEXT_CACHE) return null;

  const cacheFile = path.join(OUT_DIR, '_cache-id.txt');

  // Reuse existing cache if still valid
  if (fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile, 'utf-8').trim();
    // Verify cache still exists
    try {
      const token = getToken();
      const checkResult = execSync(
        `curl -s --max-time 30 "https://${getRegion()}-aiplatform.googleapis.com/v1/${cached}" -H "Authorization: Bearer ${token}"`,
        { encoding: 'utf-8' }
      );
      const check = JSON.parse(checkResult);
      if (!check.error) {
        console.log(`♻️  Reusing existing video cache`);
        return cached;
      }
    } catch { /* cache expired, create new */ }
  }

  console.log(`🗄️  Creating video context cache (saves ~60% on subsequent chunks)...`);

  const token = getToken();
  const modelPath = `projects/${PROJECT}/locations/${getRegion()}/publishers/google/models/${MODEL}`;

  const body = JSON.stringify({
    model: modelPath,
    contents: [{
      role: 'user',
      parts: [{
        fileData: {
          mimeType: 'video/mp4',
          fileUri: gcsUri
        }
      }]
    }],
    displayName: `vstack-${EPISODE_ID}`,
    ttl: `${CACHE_TTL_SECONDS}s`
  });

  const tmpReq = path.join(OUT_DIR, '_cache_req.json');
  fs.writeFileSync(tmpReq, body);

  try {
    const result = execSync(
      `curl -s --max-time 300 "https://${getRegion()}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${getRegion()}/cachedContents" ` +
      `-H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${tmpReq}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);

    const response = JSON.parse(result);

    if (response.error) {
      console.log(`  ⚠️  Cache creation failed: ${response.error.message?.slice(0, 100)}`);
      console.log(`  Falling back to uncached mode`);
      return null;
    }

    const cacheName = response.name;
    if (!cacheName) {
      console.log(`  ⚠️  No cache name in response, falling back to uncached`);
      return null;
    }

    // Save cache ID for reuse
    fs.writeFileSync(cacheFile, cacheName);

    const usage = response.usageMetadata || {};
    console.log(`  ✅ Cache created: ${cacheName.split('/').pop()}`);
    console.log(`  Cached tokens: ${(usage.totalTokenCount || 0).toLocaleString()}`);
    console.log(`  Expires: ${response.expireTime}`);
    return cacheName;

  } catch (err) {
    if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);
    console.log(`  ⚠️  Cache creation error: ${err.message?.slice(0, 80)}`);
    console.log(`  Falling back to uncached mode`);
    return null;
  }
}

async function deleteVideoCache(cacheName) {
  if (!cacheName) return;
  try {
    const token = getToken();
    execSync(
      `curl -s -X DELETE "https://${getRegion()}-aiplatform.googleapis.com/v1/${cacheName}" -H "Authorization: Bearer ${token}"`,
      { encoding: 'utf-8' }
    );
    const cacheFile = path.join(OUT_DIR, '_cache-id.txt');
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    console.log(`🗑️  Video cache deleted`);
  } catch { /* best effort cleanup */ }
}

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

// ── Two-Pass Prompt System ──────────────────────────────────────────
// Pass A: Rich scene metadata (reliable — Gemini always completes this)
// Pass B: Shot-level detail per scene (simpler task, higher success rate)

function buildScenePrompt(startMin, endMin, srtEntries) {
  const srtSection = getSrtForRange(srtEntries, startMin * 60, endMin * 60);

  return `Analyze this video from ${fmtTs(startMin*60)} to ${fmtTs(endMin*60)}.

Identify every SCENE (a logical story segment — a conversation, an action sequence, a location change).

For each scene provide:
- sceneNumber (sequential starting from 1)
- startTimestamp (MM:SS.s format)
- endTimestamp (MM:SS.s format)
- location (specific set/location name)
- characters (array of full character names present)
- mood (emotional tone)
- plotSignificance (1-2 sentence summary of what happens and why it matters)
- lighting (e.g. "standard bridge lighting", "dim quarters", "dramatic shadows")
- music (describe any score/soundtrack if notable, or "none")
- costuming (notable costume details if any)
- dialogue (array of {speaker, text, start, end} — attribute each subtitle line to the speaking character)
- tags (extensive array of searchable keywords)
- supercutPotential (array of categories: e.g. "Picard Leadership", "Emotional Moments", "Action", "Comedy")
${srtSection}

RULES:
- Cover EVERY second from ${fmtTs(startMin*60)} to ${fmtTs(endMin*60)} — no gaps
- Scene timestamps must be continuous (scene N end = scene N+1 start)
- Use sub-second precision (MM:SS.s)
- Output ONLY a JSON array starting with [ ending with ]
- Do NOT include a "shots" field — that will be done separately`;
}

function buildShotPrompt(scene) {
  return `Analyze this video from ${scene.startTimestamp} to ${scene.endTimestamp}.

This is a single scene: "${scene.plotSignificance || scene.location}"
Characters present: ${(scene.characters || []).join(', ')}

Identify every SHOT (camera cut or significant visual change) within this time range.

For each shot provide:
- shotNumber (sequential starting from 1)
- startTimestamp (MM:SS.s — must be within ${scene.startTimestamp} to ${scene.endTimestamp})
- endTimestamp (MM:SS.s)
- shotType (wide/medium/close-up/extreme-close-up/over-shoulder/two-shot/insert/establishing/effect)
- subject (who or what the camera is focused on)
- action (what happens in this shot, 1-2 sentences)
- characterExpressions (object: {"Character": "expression description"})
- cameraMovement (static/pan/tilt/track/zoom/dolly)

RULES:
- Cover EVERY second — no gaps
- Shot timestamps must be continuous (shot N end = shot N+1 start)
- First shot starts at ${scene.startTimestamp}, last shot ends at ${scene.endTimestamp}
- Use sub-second precision (MM:SS.s)
- Output ONLY a JSON array starting with [ ending with ]`;
}

// Legacy single-pass prompt (kept as fallback)
function buildPrompt(startMin, endMin, srtEntries) {
  const srtSection = getSrtForRange(srtEntries, startMin * 60, endMin * 60);

  return `Analyze this video from ${fmtTs(startMin*60)} to ${fmtTs(endMin*60)}.

Provide TWO levels:
1. SCENES — logical story segments
2. SHOTS within each scene — every camera cut

For each SCENE: sceneNumber, startTimestamp (MM:SS.s), endTimestamp (MM:SS.s), location, characters (array), mood, plotSignificance

For each SHOT: shotNumber, startTimestamp (MM:SS.s), endTimestamp (MM:SS.s), shotType, subject, action, characterExpressions (object), cameraMovement, tags (array)
${srtSection}

TIMING RULES:
- Cover EVERY second from ${fmtTs(startMin*60)} to ${fmtTs(endMin*60)} — no gaps
- Shot timestamps must be continuous (shot N end = shot N+1 start)
- Scene timestamps must be continuous
- Use sub-second precision (MM:SS.s)
- Output ONLY a JSON array starting with [ ending with ]`;
}

// ── Generic Gemini API caller with retry ─────────────────────────────

// Mutable cache reference — allows auto-recreation on expiry
let _activeCacheName = null;
let _activeGcsUri = null;

async function callGemini(prompt, gcsUri, cacheName, label) {
  const token = getToken();
  // Use the active cache (may have been recreated after expiry)
  let effectiveCache = _activeCacheName || cacheName;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) console.log(`    🔄 ${label} (attempt ${attempt})...`);

    try {
      const requestBody = effectiveCache
        ? {
            cachedContent: effectiveCache,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS }
          }
        : {
            contents: [{ role: 'user', parts: [
              { fileData: { mimeType: 'video/mp4', fileUri: gcsUri } },
              { text: prompt }
            ]}],
            generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS, mediaResolution: MEDIA_RESOLUTION }
          };

      const tmpReq = path.join(OUT_DIR, `_req.json`);
      fs.writeFileSync(tmpReq, JSON.stringify(requestBody));

      const url = `https://${getRegion()}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${getRegion()}/publishers/google/models/${MODEL}:generateContent`;
      const result = execSync(
        `curl -s --max-time 600 "${url}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${tmpReq}"`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      );
      if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);

      const response = JSON.parse(result);

      if (response.error) {
        const msg = response.error.message?.slice(0, 100) || 'unknown';

        // Auto-recreate cache on expiry
        if (/expired/i.test(msg) && effectiveCache) {
          console.log(`    ♻️  Cache expired — recreating...`);
          const newCache = await createVideoCache(_activeGcsUri || gcsUri);
          if (newCache) {
            _activeCacheName = newCache;
            effectiveCache = newCache;
            continue; // retry immediately with new cache
          } else {
            // Fall back to uncached
            effectiveCache = null;
            _activeCacheName = null;
            continue;
          }
        }

        const isRateLimit = /resource exhausted|rate limit|quota/i.test(msg);
        if (isRateLimit) {
          const regionChanged = onRateLimit();
          if (regionChanged) {
            // Invalidate cache — different region needs its own cache
            effectiveCache = null;
            _activeCacheName = null;
          }
        }
        console.log(`    ⚠️  API error: ${msg}`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
          continue;
        }
        return null;
      }

      if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
        console.log(`    ⚠️  Truncated (MAX_TOKENS)`);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_DELAY_MS); continue; }
        return null;
      }

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = extractJsonArray(text);
      if (!parsed) {
        console.log(`    ⚠️  No valid JSON`);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_DELAY_MS); continue; }
        return null;
      }

      const usage = response.usageMetadata || {};
      const cachedTokens = usage.cachedContentTokenCount || 0;
      const inputRate = cachedTokens > 0 ? 0.20 : 2.00;
      const cost = (usage.promptTokenCount || 0) * inputRate / 1e6 + (usage.candidatesTokenCount || 0) * 10 / 1e6;
      const cacheInfo = cachedTokens > 0 ? ` 💰 cached` : '';
      onSuccess(); // reset rate limit counter

      return { data: parsed, cost, response, cacheInfo };

    } catch (err) {
      console.log(`    ⚠️  ${err.message?.slice(0, 80)}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }
  }
  return null;
}

// ── Two-Pass Chunk Analysis ──────────────────────────────────────────
// Pass A: Get scenes (rich metadata, no shots) — always succeeds
// Pass B: Get shots per scene — simpler prompt, high success rate

async function analyzeChunk(gcsUri, startMin, endMin, srtEntries, cacheName) {
  const chunkFile = path.join(OUT_DIR, `chunk-${startMin}-${endMin}.json`);

  // Reuse valid cached result (must have scenes WITH shots)
  if (fs.existsSync(chunkFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(chunkFile, 'utf-8'));
      if (cached.scenes && cached.scenes.every(s => s.shots?.length > 0)) {
        console.log(`  ⏭️  ${startMin}-${endMin}min cached (${cached.scenes.length} scenes)`);
        return cached.scenes;
      }
    } catch { /* re-analyze */ }
  }

  // ── Pass A: Scenes ──────────────────────────────────────────────────
  console.log(`  📋 Pass A: Scenes for ${startMin}-${endMin}min...`);
  const scenePrompt = buildScenePrompt(startMin, endMin, srtEntries);
  const sceneResult = await callGemini(scenePrompt, gcsUri, cacheName, `scenes ${startMin}-${endMin}`);

  if (!sceneResult) {
    console.log(`  ⛔ Pass A failed for ${startMin}-${endMin}min`);
    return [];
  }

  const scenes = sceneResult.data;
  console.log(`  ✅ ${scenes.length} scenes ($${sceneResult.cost.toFixed(3)}${sceneResult.cacheInfo})`);

  // ── Pass B: Shots per scene ─────────────────────────────────────────
  console.log(`  🎬 Pass B: Shots for ${scenes.length} scenes...`);
  let totalShots = 0;
  let totalShotCost = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const shotPrompt = buildShotPrompt(scene);

    // Small cooldown between shot requests to avoid rate limits
    if (i > 0) await sleep(3000);

    const shotResult = await callGemini(shotPrompt, gcsUri, cacheName, `shots scene ${i+1}`);
    if (shotResult) {
      scene.shots = shotResult.data;
      totalShots += scene.shots.length;
      totalShotCost += shotResult.cost;
      process.stdout.write(`    Scene ${i+1}: ${scene.shots.length} shots  `);
    } else {
      console.log(`    Scene ${i+1}: ❌ shots failed`);
      scene.shots = [];
    }
  }
  console.log(`\n  ✅ Total: ${totalShots} shots ($${totalShotCost.toFixed(3)})`);

  // ── Distribute dialogue from scenes to shots ──────────────────────
  // Scene-level dialogue has speaker + timestamps. Match each line to
  // the shot whose time range contains it.
  let dialogueAssigned = 0;
  for (const scene of scenes) {
    const sceneDialogue = scene.dialogue || [];
    if (!sceneDialogue.length || !scene.shots?.length) continue;

    for (const shot of scene.shots) {
      const shotStart = parseTs(shot.startTimestamp);
      const shotEnd = parseTs(shot.endTimestamp);
      shot.dialogue = [];

      for (const line of sceneDialogue) {
        const lineStart = parseTs(line.start);
        const lineEnd = parseTs(line.end);
        // Line belongs to this shot if it overlaps
        if (lineStart < shotEnd && lineEnd > shotStart) {
          shot.dialogue.push(line);
          dialogueAssigned++;
        }
      }

      if (!shot.dialogue.length) delete shot.dialogue;
    }
  }
  if (dialogueAssigned > 0) {
    console.log(`  💬 ${dialogueAssigned} dialogue lines assigned to shots`);
  }

  // Save combined result
  fs.writeFileSync(chunkFile, JSON.stringify({ scenes, passA: sceneResult.cost, passB: totalShotCost }, null, 2));

  return scenes;
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
    // Create context cache for the video (90% discount on chunks 2+)
    let cacheName = null;
    _activeGcsUri = gcsUri;
    if (numChunks > 1) {
      cacheName = await createVideoCache(gcsUri);
      _activeCacheName = cacheName;
    }

    console.log(`\n🤖 Analyzing with ${MODEL}${cacheName ? ' (context cached 💰)' : ''}...`);
    for (let i = 0; i < numChunks; i++) {
      const s = i * CHUNK_MINUTES;
      const e = Math.min((i + 1) * CHUNK_MINUTES, durMin);

      // Skip tiny end chunks (< MIN_CHUNK_SECONDS) — not worth an API call
      const chunkDurSec = (e - s) * 60;
      if (chunkDurSec < MIN_CHUNK_SECONDS) {
        console.log(`  ⏭️  Skipping tiny chunk ${s}-${e}min (${chunkDurSec.toFixed(0)}s < ${MIN_CHUNK_SECONDS}s minimum)`);
        continue;
      }

      allChunks.push(await analyzeChunk(gcsUri, s, e, srtEntries, cacheName));
      if (i < numChunks - 1) { console.log(`  ⏳ Cooldown ${(CHUNK_COOLDOWN_MS/1000).toFixed(0)}s...`); await sleep(CHUNK_COOLDOWN_MS); }
    }

    // Cleanup cache after all chunks are done
    if (cacheName) {
      await deleteVideoCache(cacheName);
    }
  } else {
    console.log(`⏭️  Loading cached chunks...`);
    for (let i = 0; i < numChunks; i++) {
      const s = i * CHUNK_MINUTES, e = Math.min((i + 1) * CHUNK_MINUTES, durMin);
      const cf = path.join(OUT_DIR, `chunk-${s}-${e}.json`);
      if (fs.existsSync(cf)) {
        try {
          const d = JSON.parse(fs.readFileSync(cf, 'utf-8'));
          // Support both new format { scenes: [...] } and legacy raw Gemini response
          if (d.scenes) {
            allChunks.push(d.scenes);
          } else {
            const t = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const parsed = extractJsonArray(t);
            if (parsed) allChunks.push(parsed);
          }
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
