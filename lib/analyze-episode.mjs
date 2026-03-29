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
 *   node analyze-episode.mjs S02E01 "C:\Star Trek\..." --region us-east1
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// ── File Logging ─────────────────────────────────────────────────────
// Tee all console output to a log file for post-mortem debugging.

const __dirnameEarly = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirnameEarly, 'gemini-analysis');
fs.mkdirSync(LOG_DIR, { recursive: true });

const EPISODE_ID_EARLY = process.argv[2] || 'unknown';
const LOG_FILE = path.join(LOG_DIR, EPISODE_ID_EARLY, `analysis-${new Date().toISOString().slice(0,10)}.log`);
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
logStream.write(`\n${'═'.repeat(60)}\n  Analysis started: ${new Date().toISOString()}\n  Args: ${process.argv.slice(2).join(' ')}\n${'═'.repeat(60)}\n\n`);

const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

console.log = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  origLog(...args);
  logStream.write(msg + '\n');
};
console.error = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  origError(...args);
  logStream.write('[ERROR] ' + msg + '\n');
};
console.warn = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  origWarn(...args);
  logStream.write('[WARN] ' + msg + '\n');
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────

const CHUNK_MINUTES = 15;
const GCS_BUCKET = 'gs://tng-video-analysis-east';
const PROJECT = 'data-mind-456822-q3';
const MODEL_SCENES = 'gemini-2.5-pro';        // Pass A: rich scene metadata (needs quality)
const MODEL_SHOTS = 'gemini-3-flash-preview';  // Pass B: shot detection on clips (needs speed + accuracy)
const MODEL = MODEL_SCENES;                     // Default for cache creation + legacy

// ── Region Failover ─────────────────────────────────────────────────
// Auto-rotates to next region after consecutive rate limits.
// User can set preferred region with --region=us-east1
const ALL_REGIONS = ['us-east1', 'us-central1', 'europe-west1', 'asia-northeast1', 'global'];
const RATE_LIMIT_THRESHOLD = 3; // consecutive rate limits before rotating

// Put preferred region first if specified
const REGIONS = (() => {
  const pref = process.argv.find(a => a.startsWith('--region='))?.split('=')[1]
    || (process.argv.includes('--region') ? process.argv[process.argv.indexOf('--region') + 1] : null);
  if (pref && ALL_REGIONS.includes(pref)) {
    return [pref, ...ALL_REGIONS.filter(r => r !== pref)];
  }
  return ALL_REGIONS;
})();
let _regionIndex = 0;
let _consecutiveRateLimits = 0;

function getRegion() { return REGIONS[_regionIndex]; }

// Build the correct API base URL — global endpoint has different format
function getApiBase(region) {
  const r = region || getRegion();
  if (r === 'global') return 'https://aiplatform.googleapis.com/v1';
  return `https://${r}-aiplatform.googleapis.com/v1`;
}

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
const MIN_SHOT_DURATION = 1.7;        // Merge shots shorter than this into their neighbor
const FRAME_OFFSET_START = 0.700;     // Start frames are often too early — offset +700ms
const FRAME_OFFSET_END = -0.700;      // End frames are often too late — offset -700ms
const CACHE_TTL_SECONDS = 21600;      // 6 hours — two-pass with rate limits needs more time
const USE_CONTEXT_CACHE = !process.argv.includes('--no-cache'); // Enable by default

const GCLOUD_PATH = process.env.GCLOUD_PATH ||
  'C:/Users/steve/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin';
// On Windows, gcloud/gsutil need .cmd extension when called with full path from a different CWD
const CMD_EXT = process.platform === 'win32' ? '.cmd' : '';

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
const PREFERRED_REGION = args.find(a => a.startsWith('--region='))?.split('=')[1]
  || args[args.indexOf('--region') + 1]
  || null;

if (!EPISODE_ID || !LOCAL_FILE) {
  console.error('Usage: node analyze-episode.mjs EPISODE_ID "path/to/episode.mp4" [flags]');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, 'gemini-analysis', EPISODE_ID);
fs.mkdirSync(path.join(OUT_DIR, 'frames'), { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────

function getToken() {
  try {
    const token = execSync(`"${path.join(GCLOUD_PATH, 'gcloud' + CMD_EXT)}" auth print-access-token`,
      { encoding: 'utf-8', timeout: 15000 }).trim();
    if (!token || token.length < 20) {
      throw new Error('Token too short — likely auth issue');
    }
    return token;
  } catch (err) {
    console.error(`\n❌ Failed to get gcloud auth token.`);
    console.error(`   Run: gcloud auth login`);
    console.error(`   Error: ${err.message?.slice(0, 100)}`);
    throw new Error('gcloud auth failed — run "gcloud auth login" to re-authenticate');
  }
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
  execSync(`"${path.join(GCLOUD_PATH, 'gsutil' + CMD_EXT)}" cp "${LOCAL_FILE}" "${gcsUri}"`,
    { stdio: 'inherit' });
  console.log(`✅ Uploaded`);
  return gcsUri;
}

// ── Context Cache ────────────────────────────────────────────────────
// Cache the video tokens once, then reuse for all chunks at 90% discount.
// Creates: projects/PROJECT/locations/REGION/cachedContents/CACHE_ID
// Saves ~60-72% on multi-chunk episodes.

async function createVideoCache(gcsUri) {
  // Cache is MANDATORY — uncached requests cost 10x more

  const cacheFile = path.join(OUT_DIR, '_cache-id.txt');

  // Reuse existing cache if still valid
  if (fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile, 'utf-8').trim();
    // Verify cache still exists
    try {
      const token = getToken();
      const checkResult = execSync(
        `curl -s --max-time 30 "${getApiBase()}/${cached}" -H "Authorization: Bearer ${token}"`,
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
      `curl -s --max-time 300 "${getApiBase()}/projects/${PROJECT}/locations/${getRegion()}/cachedContents" ` +
      `-H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${tmpReq}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);

    const response = JSON.parse(result);

    if (response.error) {
      console.log(`  ⛔ Cache creation failed: ${response.error.message?.slice(0, 100)}`);
      console.log(`  STOPPING — uncached analysis costs 10x more ($70+/episode vs $7/episode)`);
      console.log(`  Fix the issue and re-run. Common causes:`);
      console.log(`    - Video not uploaded to GCS (run without --skip-upload)`);
      console.log(`    - GCS bucket doesn't exist`);
      console.log(`    - Billing not enabled`);
      throw new Error('Cache creation failed — refusing to run uncached. ' + (response.error.message || ''));
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
    console.log(`  ⛔ Cache creation error: ${err.message?.slice(0, 80)}`);
    console.log(`  STOPPING — uncached analysis costs 10x more`);
    throw new Error('Cache creation failed — ' + (err.message || 'unknown error'));
  }
}

async function deleteVideoCache(cacheName) {
  if (!cacheName) return;
  try {
    const token = getToken();
    execSync(
      `curl -s -X DELETE "${getApiBase()}/${cacheName}" -H "Authorization: Bearer ${token}"`,
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

  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (epMatch) {
    const season = parseInt(epMatch[1]);
    const episode = parseInt(epMatch[2]);

    // Try multiple naming patterns
    const patterns = [
      new RegExp(`s0?${season}e0?${episode}`, 'i'),           // S02E03, S2E3
      new RegExp(`${season}x0?${episode}`, 'i'),               // 2x03, 2x3
      new RegExp(`season\\s*${season}.*episode\\s*${episode}`, 'i'), // Season 2 Episode 3
      new RegExp(`s${String(season).padStart(2,'0')}e${String(episode).padStart(2,'0')}`, 'i'), // S02E03 strict
    ];

    for (const pattern of patterns) {
      const match = files.find(f => pattern.test(f));
      if (match) return path.join(videoDir, match);
    }
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
- tags (array of searchable keywords — be generous, include character names, objects, actions, emotions, visual details)
- supercutPotential (array of categories this specific shot could fit in a compilation, e.g. "Picard Leadership", "Riker Charm", "Data Confusion", "Worf Being Gruff", "Ship Beauty Shots", "Emotional Moments", "Comedy", "Action")

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
  // Use the active cache (may have been recreated after expiry)
  let effectiveCache = _activeCacheName || cacheName;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) console.log(`    🔄 ${label} (attempt ${attempt})...`);

    // Fresh token on every attempt (tokens expire after 1 hour)
    const token = getToken();

    try {
      // HARD STOP: Never send uncached requests — each one costs $1.50+ in video tokens
      if (!effectiveCache) {
        console.log(`    ⛔ BLOCKED: No valid cache. Refusing to send uncached request ($1.50+ per call).`);
        console.log(`       Re-run the analysis to create a fresh cache.`);
        return null;
      }

      const requestBody = {
            cachedContent: effectiveCache,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS }
          };

      const tmpReq = path.join(OUT_DIR, `_req.json`);
      fs.writeFileSync(tmpReq, JSON.stringify(requestBody));

      const url = `${getApiBase()}/projects/${PROJECT}/locations/${getRegion()}/publishers/google/models/${MODEL}:generateContent`;
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

        // Billing failures — don't retry, open console
        const isBillingError = /billing|payment|account.*disabled|project.*disabled/i.test(msg);
        if (isBillingError) {
          console.error(`    ❌ Billing issue detected. Opening GCP billing console...`);
          try { execSync(`start "" "https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT}"`, { stdio: 'pipe' }); } catch {}
          return null;
        }

        // Auth failures — don't retry, fix the root cause
        const isAuthError = /authentication|credentials|unauthorized|unauthenticated/i.test(msg);
        if (isAuthError) {
          console.log(`    ❌ Authentication failed — refreshing token...`);
          try {
            // Try refreshing and retrying once
            const freshToken = getToken();
            if (attempt < MAX_RETRIES) continue;
          } catch {
            console.error(`    ❌ Cannot refresh auth. Run: gcloud auth login`);
            return null;
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
      const promptTokens = usage.promptTokenCount || 0;
      const outputTokens = usage.candidatesTokenCount || 0;
      const thinkingTokens = usage.thoughtsTokenCount || 0;
      // Vertex AI Gemini 2.5 Pro pricing (March 2026):
      // Input ≤200K: $1.25/M | Input >200K: $2.50/M
      // Cached ≤200K: $0.13/M | Cached >200K: $0.25/M
      // Output: $10.00/M | Thinking: $10.00/M (billed as output)
      const isLongContext = promptTokens > 200000;
      const inputRate = cachedTokens > 0
        ? (isLongContext ? 0.25 : 0.13)   // cached rates
        : (isLongContext ? 2.50 : 1.25);   // standard rates
      const cost = promptTokens * inputRate / 1e6 + outputTokens * 10 / 1e6 + thinkingTokens * 10 / 1e6;
      const cacheInfo = cachedTokens > 0 ? ` 💰 cached` : '';
      onSuccess(); // reset rate limit counter

      // Log to cost ledger — every API call tracked
      const ledgerFile = path.join(OUT_DIR, 'cost-ledger.json');
      let ledger = [];
      try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf-8')); } catch {}
      ledger.push({
        timestamp: new Date().toISOString(),
        label,
        promptTokens,
        cachedTokens,
        outputTokens,
        thinkingTokens,
        inputRate,
        cost: Math.round(cost * 10000) / 10000,
        cached: cachedTokens > 0,
        region: getRegion(),
        attempt
      });
      const totalCost = ledger.reduce((s, e) => s + e.cost, 0);
      fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
      writeStatus({ estimatedCost: Math.round(totalCost * 100) / 100 });

      return { data: parsed, cost, response, cacheInfo };

    } catch (err) {
      console.log(`    ⚠️  ${err.message?.slice(0, 80)}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }
  }
  return null;
}

// ── Gemini API caller for scene clips (no cache, direct file) ────────

async function callGeminiWithClip(prompt, clipGcsUri, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) console.log(`    🔄 ${label} (attempt ${attempt})...`);

    const token = getToken();

    try {
      const requestBody = {
        contents: [{ role: 'user', parts: [
          { fileData: { mimeType: 'video/mp4', fileUri: clipGcsUri } },
          { text: prompt }
        ]}],
        generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS, mediaResolution: MEDIA_RESOLUTION }
      };

      const tmpReq = path.join(OUT_DIR, `_req_clip.json`);
      fs.writeFileSync(tmpReq, JSON.stringify(requestBody));

      // Use MODEL_SHOTS for clip analysis — Gemini 3.x requires global endpoint
      const isGemini3 = MODEL_SHOTS.includes('3');
      const shotUrl = isGemini3
        ? `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/${MODEL_SHOTS}:generateContent`
        : `${getApiBase()}/projects/${PROJECT}/locations/${getRegion()}/publishers/google/models/${MODEL_SHOTS}:generateContent`;
      const result = execSync(
        `curl -s --max-time 600 "${shotUrl}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${tmpReq}"`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      );
      if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);

      const response = JSON.parse(result);

      if (response.error) {
        const msg = response.error.message || '';
        console.log(`    ⚠️  API error: ${msg.slice(0, 80)}`);
        if (/exhausted|rate/i.test(msg)) {
          onRateLimit();
          if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)); continue; }
        }
        if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_DELAY_MS); continue; }
        return null;
      }

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = extractJsonArray(text);
      if (!parsed) {
        if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_DELAY_MS); continue; }
        return null;
      }

      const usage = response.usageMetadata || {};
      const promptTokens = usage.promptTokenCount || 0;
      const outputTokens = usage.candidatesTokenCount || 0;
      const thinkingTokens = usage.thoughtsTokenCount || 0;
      // Clip tokens are NOT cached — billed at standard rate
      // Clips are always <200K tokens, so use $1.25/M rate
      const clipInputRate = 1.25;
      const cost = promptTokens * clipInputRate / 1e6 + outputTokens * 10 / 1e6 + thinkingTokens * 10 / 1e6;
      onSuccess();

      // Log to cost ledger
      const ledgerFile = path.join(OUT_DIR, 'cost-ledger.json');
      let ledger = [];
      try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf-8')); } catch {}
      ledger.push({
        timestamp: new Date().toISOString(),
        label: label + ' (clip)',
        promptTokens,
        cachedTokens: 0,
        outputTokens,
        thinkingTokens,
        inputRate: clipInputRate,
        cost: Math.round(cost * 10000) / 10000,
        cached: false,
        clipTokens: promptTokens, // track how small the clip was
        region: getRegion(),
        attempt
      });
      const totalCost = ledger.reduce((s, e) => s + e.cost, 0);
      fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
      writeStatus({ estimatedCost: Math.round(totalCost * 100) / 100 });

      console.log(`(${(promptTokens/1000).toFixed(0)}K tok, $${cost.toFixed(4)})`);
      return { data: parsed, cost, response, cacheInfo: '' };

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

  // Reuse valid cached result (must have scenes WITH shots, and reasonable file size)
  if (fs.existsSync(chunkFile)) {
    try {
      const fileSize = fs.statSync(chunkFile).size;
      if (fileSize < 500) {
        console.log(`  ⚠️  ${startMin}-${endMin}min chunk file too small (${fileSize}B) — re-analyzing`);
        fs.unlinkSync(chunkFile);
      } else {
        const cached = JSON.parse(fs.readFileSync(chunkFile, 'utf-8'));
        if (cached.scenes && cached.scenes.every(s => s.shots?.length > 0)) {
          const totalShots = cached.scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
          console.log(`  ⏭️  ${startMin}-${endMin}min cached (${cached.scenes.length} scenes, ${totalShots} shots)`);
          return cached.scenes;
        }
        console.log(`  ⚠️  ${startMin}-${endMin}min chunk incomplete — re-analyzing`);
        fs.unlinkSync(chunkFile);
      }
    } catch {
      console.log(`  ⚠️  ${startMin}-${endMin}min chunk corrupted — re-analyzing`);
      try { fs.unlinkSync(chunkFile); } catch {}
    }
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

  // ── Pass B: Shots per scene (using scene clips, not full video) ─────
  // Extract short clips per scene → upload to GCS → analyze each clip
  // This sends ~50K tokens per shot request instead of ~750K (93% savings)
  console.log(`  🎬 Pass B: Shots for ${scenes.length} scenes (using scene clips)...`);
  let totalShots = 0;
  let totalShotCost = 0;
  const clipsDir = path.join(OUT_DIR, '_scene_clips');
  fs.mkdirSync(clipsDir, { recursive: true });
  const clipCleanup = []; // GCS paths to delete after

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const startSec = parseTs(scene.startTimestamp);
    const endSec = parseTs(scene.endTimestamp);
    const duration = endSec - startSec;

    // Skip very short scenes (< 3 seconds)
    if (duration < 3) {
      console.log(`    Scene ${i+1}: skipped (${duration.toFixed(1)}s)`);
      scene.shots = [];
      continue;
    }

    // Small cooldown between requests
    if (i > 0) await sleep(3000);

    writeStatus({ phase: 'analyzing', passB: true, currentScene: i + 1, totalScenes: scenes.length, shotsCompleted: totalShots });

    // Extract scene clip with ffmpeg
    const clipFile = path.join(clipsDir, `scene_${i+1}.mp4`);
    const clipGcsPath = `${GCS_BUCKET}/${EPISODE_ID}_scene_${i+1}.mp4`;

    try {
      // Extract clip (add 1s padding on each side for context)
      const clipStart = Math.max(0, startSec - 1);
      const clipDuration = duration + 2;
      execSync(
        `"${FFMPEG}" -ss ${clipStart.toFixed(3)} -i "${LOCAL_FILE}" -t ${clipDuration.toFixed(3)} -c copy -avoid_negative_ts make_zero "${clipFile}" -y`,
        { stdio: 'pipe', timeout: 30000 }
      );

      // Upload clip to GCS
      execSync(
        `"${path.join(GCLOUD_PATH, 'gsutil' + CMD_EXT)}" -q cp "${clipFile}" "${clipGcsPath}"`,
        { stdio: 'pipe', timeout: 60000 }
      );
      clipCleanup.push(clipGcsPath);

      // Build shot prompt — tell Gemini the clip's offset so timestamps are absolute
      const shotPrompt = buildShotPrompt(scene);

      // Call Gemini with the SHORT clip instead of the full episode
      // Don't use the cache — the clip is a different file
      const shotResult = await callGeminiWithClip(shotPrompt, clipGcsPath, `shots scene ${i+1}`);

      if (shotResult) {
        scene.shots = shotResult.data;
        totalShots += scene.shots.length;
        totalShotCost += shotResult.cost;
        process.stdout.write(`    Scene ${i+1}: ${scene.shots.length} shots  `);
      } else {
        console.log(`    Scene ${i+1}: ❌ shots failed`);
        scene.shots = [];
      }

      // Clean up local clip file
      try { fs.unlinkSync(clipFile); } catch {}

    } catch (err) {
      console.log(`    Scene ${i+1}: ❌ clip extraction failed: ${err.message?.slice(0, 60)}`);
      scene.shots = [];
    }
  }

  // Clean up GCS clips
  console.log(`  🧹 Cleaning up ${clipCleanup.length} scene clips from GCS...`);
  for (const gcsPath of clipCleanup) {
    try {
      execSync(`"${path.join(GCLOUD_PATH, 'gsutil' + CMD_EXT)}" -q rm "${gcsPath}"`, { stdio: 'pipe', timeout: 10000 });
    } catch {}
  }
  try { fs.rmdirSync(clipsDir); } catch {}

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

// ── Auto-Split Oversized Shots ──────────────────────────────────────
// LESSON: Gemini sometimes gets lazy and lumps 60+ seconds into one shot,
// especially at the end of chunks (credits, long dialogue). Split any shot
// >MAX_SHOT_DURATION at the nearest ffmpeg cut point.

const MAX_SHOT_DURATION = 15; // seconds

function splitOversizedShots(scenes, cuts) {
  let splitCount = 0;

  for (const scene of scenes) {
    if (!scene.shots) continue;

    const newShots = [];
    for (const shot of scene.shots) {
      const startSec = parseTs(shot.startTimestamp);
      const endSec = parseTs(shot.endTimestamp);
      const duration = endSec - startSec;

      if (duration <= MAX_SHOT_DURATION) {
        newShots.push(shot);
        continue;
      }

      // Find all ffmpeg cuts within this shot's range
      const cutsInRange = cuts.filter(c => c > startSec + 1 && c < endSec - 1);

      if (cutsInRange.length === 0) {
        // No cuts available — split evenly
        const numParts = Math.ceil(duration / MAX_SHOT_DURATION);
        const partDuration = duration / numParts;
        for (let i = 0; i < numParts; i++) {
          const partStart = startSec + i * partDuration;
          const partEnd = i === numParts - 1 ? endSec : startSec + (i + 1) * partDuration;
          newShots.push({
            ...shot,
            startTimestamp: fmtTs(partStart),
            endTimestamp: fmtTs(partEnd),
            _autoSplit: true,
            _splitPart: i + 1,
            _splitTotal: numParts,
          });
          splitCount++;
        }
      } else {
        // Split at each ffmpeg cut point
        let prevCut = startSec;
        for (const cut of cutsInRange) {
          newShots.push({
            ...shot,
            startTimestamp: fmtTs(prevCut),
            endTimestamp: fmtTs(cut),
            _autoSplit: true,
          });
          prevCut = cut;
          splitCount++;
        }
        // Final segment
        newShots.push({
          ...shot,
          startTimestamp: fmtTs(prevCut),
          endTimestamp: fmtTs(endSec),
          _autoSplit: true,
        });
        splitCount++;
      }
    }

    // Renumber shots
    scene.shots = newShots;
    scene.shots.forEach((sh, i) => { sh.shotNumber = i + 1; });
  }

  if (splitCount > 0) {
    console.log(`  ✂️  Auto-split ${splitCount} oversized shots (>${MAX_SHOT_DURATION}s)`);
  }
}

// ── Merge Short Shots ────────────────────────────────────────────────
// Shots under MIN_SHOT_DURATION seconds are usually false cuts from Gemini.
// Merge them into their neighbor (prefer merging into the previous shot).

function mergeShortShots(scenes) {
  let mergeCount = 0;

  for (const scene of scenes) {
    if (!scene.shots || scene.shots.length < 2) continue;

    const merged = [scene.shots[0]];

    for (let i = 1; i < scene.shots.length; i++) {
      const shot = scene.shots[i];
      const startSec = parseTs(shot.startTimestamp);
      const endSec = parseTs(shot.endTimestamp);
      const duration = endSec - startSec;

      if (duration < MIN_SHOT_DURATION) {
        // Merge into previous shot — extend its end timestamp
        const prev = merged[merged.length - 1];
        prev.endTimestamp = shot.endTimestamp;

        // Combine metadata
        if (shot.action && prev.action) prev.action += ' ' + shot.action;
        if (shot.subject && prev.subject && shot.subject !== prev.subject) {
          prev.subject += ', ' + shot.subject;
        }
        if (shot.tags) prev.tags = [...new Set([...(prev.tags || []), ...shot.tags])];
        if (shot.dialogue?.length) {
          prev.dialogue = [...(prev.dialogue || []), ...shot.dialogue];
        }
        if (shot.characterExpressions) {
          prev.characterExpressions = { ...(prev.characterExpressions || {}), ...shot.characterExpressions };
        }
        prev._merged = (prev._merged || 1) + 1;
        mergeCount++;
      } else {
        merged.push(shot);
      }
    }

    // Check if first shot is also too short (merge into next)
    if (merged.length >= 2) {
      const first = merged[0];
      const firstDur = parseTs(first.endTimestamp) - parseTs(first.startTimestamp);
      if (firstDur < MIN_SHOT_DURATION) {
        const next = merged[1];
        next.startTimestamp = first.startTimestamp;
        if (first.action && next.action) next.action = first.action + ' ' + next.action;
        if (first.subject && next.subject && first.subject !== next.subject) {
          next.subject = first.subject + ', ' + next.subject;
        }
        if (first.tags) next.tags = [...new Set([...(first.tags || []), ...(next.tags || [])])];
        if (first.dialogue?.length) {
          next.dialogue = [...first.dialogue, ...(next.dialogue || [])];
        }
        next._merged = (next._merged || 1) + (first._merged || 1);
        merged.shift();
        mergeCount++;
      }
    }

    // Renumber
    scene.shots = merged;
    scene.shots.forEach((sh, i) => { sh.shotNumber = i + 1; });
  }

  if (mergeCount > 0) {
    console.log(`  🔗 Merged ${mergeCount} short shots (<${MIN_SHOT_DURATION}s) into neighbors`);
  }
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
        // Apply frame offsets — start frames are often too early, end frames too late
        const ssOffset = Math.max(0, ss + FRAME_OFFSET_START);
        const esOffset = Math.max(0, es + FRAME_OFFSET_END);
        execSync(`"${FFMPEG}" -ss ${ssOffset.toFixed(3)} -i "${LOCAL_FILE}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${fp}" -y`, { stdio: 'pipe', timeout: 10000 });
        execSync(`"${FFMPEG}" -ss ${esOffset.toFixed(3)} -i "${LOCAL_FILE}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${lp}" -y`, { stdio: 'pipe', timeout: 10000 });
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

// ── Status & Watchdog ────────────────────────────────────────────────

const STATUS_FILE = path.join(OUT_DIR, '_analysis-status.json');
let statusInterval = null;

function writeStatus(data) {
  const status = {
    episodeId: EPISODE_ID,
    heartbeat: new Date().toISOString(),
    pid: process.pid,
    cached: !!_activeCacheName,
    region: getRegion(),
    ...data
  };
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2)); } catch {}
}

function startHeartbeat() {
  statusInterval = setInterval(() => {
    try {
      const existing = fs.existsSync(STATUS_FILE) ? JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')) : {};
      existing.heartbeat = new Date().toISOString();
      fs.writeFileSync(STATUS_FILE, JSON.stringify(existing, null, 2));
    } catch {}
  }, 30000); // heartbeat every 30s
}

function stopHeartbeat() {
  if (statusInterval) clearInterval(statusInterval);
}

// ── Preflight Checks ─────────────────────────────────────────────────

function preflightChecks() {
  const errors = [];

  // 1. Video file exists
  if (!fs.existsSync(LOCAL_FILE)) {
    errors.push(`Video file not found: ${LOCAL_FILE}`);
  }

  // 2. ffmpeg/ffprobe available
  try { execSync(`"${FFPROBE}" -version`, { stdio: 'pipe', timeout: 5000 }); }
  catch { errors.push(`ffprobe not found at: ${FFPROBE}`); }

  // 3. gcloud auth works
  try { getToken(); }
  catch { errors.push(`gcloud auth failed — run: gcloud auth login`); }

  // 4. GCS bucket accessible (skip if --skip-upload)
  if (!SKIP_UPLOAD && !REPORT_ONLY) {
    try {
      execSync(`"${path.join(GCLOUD_PATH, 'gsutil' + CMD_EXT)}" ls "${GCS_BUCKET}/"`, { timeout: 15000, stdio: 'pipe' });
    } catch {
      errors.push(`GCS bucket not accessible: ${GCS_BUCKET} — create it or check permissions`);
    }
  }

  // 5. GCP billing enabled
  try {
    const billingResult = execSync(
      `"${path.join(GCLOUD_PATH, 'gcloud' + CMD_EXT)}" billing projects describe ${PROJECT} --format="value(billingEnabled)"`,
      { encoding: 'utf-8', timeout: 15000 }
    ).trim();
    if (billingResult !== 'True') {
      errors.push(`GCP billing not enabled for project ${PROJECT}`);
      console.log(`\n   💳 Enable billing: https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT}`);
      try { execSync(`start "" "https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT}"`, { stdio: 'pipe' }); } catch {}
    }
  } catch {
    console.log(`   ⚠️  Could not check billing status (non-critical)`);
  }

  // 6. Disk space (warn if <500MB free)
  try {
    const driveRoot = OUT_DIR.slice(0, 3); // e.g. "C:\"
    const result = execSync(`wmic logicaldisk where "DeviceID='${driveRoot.slice(0,2)}'" get FreeSpace /value`, { encoding: 'utf-8' });
    const freeBytes = parseInt(result.match(/FreeSpace=(\d+)/)?.[1] || '0');
    const freeMB = freeBytes / (1024 * 1024);
    if (freeMB < 500) {
      errors.push(`Low disk space: ${freeMB.toFixed(0)}MB free on ${driveRoot} (need ~500MB for frames)`);
    }
  } catch {} // non-critical

  const warnings = [];

  if (errors.length > 0) {
    console.log(`\n❌ Preflight checks failed:\n`);
    errors.forEach(e => console.log(`   • ${e}`));
    console.log();
    process.exit(1);
  }

  console.log(`✅ Preflight checks passed\n`);
}

// ── Cost Estimation ──────────────────────────────────────────────────

function estimateCost(durationSec) {
  // Vertex AI Gemini 2.5 Pro pricing (March 2026):
  // Input ≤200K: $1.25/M | >200K: $2.50/M | Cached ≤200K: $0.13/M | >200K: $0.25/M
  // Output: $10/M | Thinking: $10/M
  const minutes = durationSec / 60;
  const chunks = Math.ceil(minutes / CHUNK_MINUTES);
  const tokensPerChunk = 24897 * CHUNK_MINUTES; // ~25K tokens/min at LOW (~375K per 15min chunk)
  const scenesPerChunk = 12; // average

  // Pass A: scene analysis (full video, cached after first call)
  // All Pass A calls are >200K tokens
  const passACostFirst = tokensPerChunk * 2.50 / 1e6; // first chunk at full rate
  const passACostCached = tokensPerChunk * 0.25 / 1e6; // subsequent at cached rate
  const passATotal = passACostFirst + passACostCached * (chunks - 1);

  // Pass B: shot analysis (scene clips, ~5K tokens each, uncached)
  // Clips are always <200K, billed at $1.25/M
  const shotsPerEpisode = scenesPerChunk * chunks;
  const clipTokens = 5000; // average clip size from our tests
  const passBTotal = shotsPerEpisode * clipTokens * 1.25 / 1e6;

  // Output tokens (scenes + shots)
  const outputTokens = scenesPerChunk * chunks * 500; // ~500 tokens per scene/shot response
  const outputCost = outputTokens * 10 / 1e6;

  // Thinking tokens (~2x output)
  const thinkingCost = outputTokens * 2 * 10 / 1e6;

  const totalCached = passATotal + passBTotal + outputCost + thinkingCost;
  const totalUncached = tokensPerChunk * chunks * 2.50 / 1e6 + outputCost + thinkingCost; // all full rate, no clips
  return { chunks, totalUncached, totalCached };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Episode Analyzer — New Pass 1`);
  console.log(`  ${EPISODE_ID}: ${path.basename(LOCAL_FILE)}`);
  console.log(`  Chunks: ${CHUNK_MINUTES}min | Model: ${MODEL}`);
  console.log(`${'═'.repeat(50)}\n`);

  // Preflight
  preflightChecks();
  startHeartbeat();

  const dur = getDuration();
  const durMin = dur / 60;
  const numChunks = Math.ceil(durMin / CHUNK_MINUTES);

  // Cost estimate
  const cost = estimateCost(dur);
  console.log(`📏 ${fmtTs(dur)} (${durMin.toFixed(1)} min → ${numChunks} chunks)`);
  console.log(`💰 Estimated cost: $${cost.totalCached.toFixed(2)} (cached) / $${cost.totalUncached.toFixed(2)} (uncached)\n`);

  writeStatus({ phase: 'starting', duration: dur, chunks: numChunks, estimatedCost: cost.totalCached, videoFile: path.basename(LOCAL_FILE) });

  // Upload
  writeStatus({ phase: 'uploading', step: 'Uploading to GCS' });
  const gcsUri = await upload();
  writeStatus({ phase: 'uploading', step: 'Upload complete' });

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
    // ALWAYS create cache — uncached requests cost 10x more
    writeStatus({ phase: 'caching', step: 'Creating video context cache' });
    cacheName = await createVideoCache(gcsUri);
    _activeCacheName = cacheName;
    if (!cacheName) {
      writeStatus({ phase: 'failed', error: 'Cache creation failed — refusing uncached analysis' });
      throw new Error('Cache creation failed — refusing to run without cache');
    }
    writeStatus({ phase: 'caching', step: 'Cache created', cached: true });

    console.log(`\n🤖 Analyzing — Pass A: ${MODEL_SCENES} | Pass B: ${MODEL_SHOTS} (context cached 💰)...`);
    for (let i = 0; i < numChunks; i++) {
      const s = i * CHUNK_MINUTES;
      const e = Math.min((i + 1) * CHUNK_MINUTES, durMin);

      // Skip tiny end chunks (< MIN_CHUNK_SECONDS) — not worth an API call
      const chunkDurSec = (e - s) * 60;
      if (chunkDurSec < MIN_CHUNK_SECONDS) {
        console.log(`  ⏭️  Skipping tiny chunk ${s}-${e}min (${chunkDurSec.toFixed(0)}s < ${MIN_CHUNK_SECONDS}s minimum)`);
        continue;
      }

      writeStatus({ phase: 'analyzing', chunk: i + 1, totalChunks: numChunks, chunkRange: `${s}-${e}min` });
      allChunks.push(await analyzeChunk(gcsUri, s, e, srtEntries, cacheName));

      // Update with chunk results
      const lastChunk = allChunks[allChunks.length - 1];
      const chunkScenes = lastChunk?.length || 0;
      const chunkShots = lastChunk?.reduce((t, sc) => t + (sc.shots?.length || 0), 0) || 0;
      writeStatus({ phase: 'analyzing', chunk: i + 1, totalChunks: numChunks, chunkComplete: true, chunkScenes, chunkShots,
        totalScenesSoFar: allChunks.reduce((t, c) => t + (c?.length || 0), 0),
        totalShotsSoFar: allChunks.reduce((t, c) => t + (c?.reduce((s, sc) => s + (sc.shots?.length || 0), 0) || 0), 0)
      });
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
  writeStatus({ phase: 'scene-detection', step: 'Running ffmpeg scene detection' });
  if (!REPORT_ONLY) {
    const cuts = detectCuts(dur);
    snap(scenes, cuts);
    splitOversizedShots(scenes, cuts);
    mergeShortShots(scenes);
    // Save cut points for report builder
    fs.writeFileSync(path.join(OUT_DIR, 'cut-points.json'), JSON.stringify(cuts));
  }

  // Extract frames
  if (!SKIP_FRAMES && !REPORT_ONLY) {
    const totalShotsForFrames = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
    writeStatus({ phase: 'extracting-frames', total: totalShotsForFrames, progress: 0 });
    extractFrames(scenes);
    writeStatus({ phase: 'extracting-frames', total: totalShotsForFrames, progress: totalShotsForFrames });
  }

  // Save
  fs.writeFileSync(path.join(OUT_DIR, 'scenes.json'), JSON.stringify(scenes, null, 2));

  // Report
  writeStatus({ phase: 'building-report', step: 'Generating Scene Review Report' });
  buildReport(scenes, dur, {
    model: MODEL, mediaResolution: MEDIA_RESOLUTION,
    chunkMinutes: CHUNK_MINUTES, temperature: TEMPERATURE,
    maxOutputTokens: MAX_OUTPUT_TOKENS, sceneDetectThreshold: SCENE_DETECT_THRESHOLD,
    snapMaxDistance: SNAP_MAX_DISTANCE, episode: path.basename(LOCAL_FILE),
    duration: fmtTs(dur), chunks: numChunks, analyzed: new Date().toISOString()
  });

  // Auto-rebuild SQLite database
  writeStatus({ phase: 'rebuilding-db', step: 'Updating SQLite database' });
  try {
    const { rebuildEpisode, closeDb } = await import('./db.mjs');
    const scenesPath = path.join(OUT_DIR, 'scenes.json');
    const dbResult = rebuildEpisode(EPISODE_ID, scenesPath);
    if (dbResult) {
      console.log(`🗃️  Database updated: ${dbResult.scenes} scenes, ${dbResult.shots} shots, ${dbResult.dialogue} dialogue`);
    }
    closeDb();
  } catch (err) {
    console.log(`⚠️  Database update skipped: ${err.message?.slice(0, 60)}`);
  }

  const totalShots = scenes.reduce((s,sc)=>s+(sc.shots?.length||0),0);
  writeStatus({ phase: 'complete', scenes: scenes.length, shots: totalShots, completedAt: new Date().toISOString() });
  stopHeartbeat();
  console.log(`\n✅ Done! ${scenes.length} scenes, ${totalShots} shots`);
}

main().catch(err => {
  writeStatus({ phase: 'failed', error: err.message, failedAt: new Date().toISOString() });
  stopHeartbeat();
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
