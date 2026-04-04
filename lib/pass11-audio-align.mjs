#!/usr/bin/env node
/**
 * Pass 1.1 — Audio-Aligned Dialogue
 *
 * Post-processing step that uses faster-whisper word-level timestamps to
 * improve dialogue-to-shot assignment and split cross-boundary dialogue lines.
 *
 * Usage:
 *   node pass11-audio-align.mjs S02E01 [--model base] [--srt path/to/file.srt] [--force]
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

const MEDIA_DIR = process.env.MEDIA_DIR || 'C:\\Star Trek';
const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');

// ffmpeg
const ffmpegDir = path.join(__dirname, 'ffmpeg');
const ffmpegSubs = fs.readdirSync(ffmpegDir).filter(d =>
  d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory()
);
const FFMPEG = path.join(ffmpegDir, ffmpegSubs[0], 'bin', 'ffmpeg.exe');

// ── Args ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const EPISODE_ID = argv[0];
const WHISPER_MODEL = argv.find(a => a === '--model') ? argv[argv.indexOf('--model') + 1] : 'base';
const WHISPER_DEVICE = argv.find(a => a === '--device') ? argv[argv.indexOf('--device') + 1] : 'cuda';
const SRT_OVERRIDE = argv.find(a => a === '--srt') ? argv[argv.indexOf('--srt') + 1] : null;
const FORCE = argv.includes('--force');

if (!EPISODE_ID) {
  console.error('Usage: node pass11-audio-align.mjs EPISODE_ID [--model base] [--device cuda] [--srt path] [--force]');
  process.exit(1);
}

const OUT_DIR = path.join(ANALYSIS_DIR, EPISODE_ID);

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

function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, '')  // strip punctuation except apostrophes
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Find video file (same pattern as tier2-shots.mjs) ────────────────

function findVideoFile() {
  // Priority 1: Check settings.json for stored video path
  const settingsPath = path.join(OUT_DIR, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.videoPath && fs.existsSync(settings.videoPath)) return settings.videoPath;
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

  // Priority 3: Any file containing the episode ID
  try {
    const files = fs.readdirSync(MEDIA_DIR);
    const match = files.find(f => f.toLowerCase().includes(EPISODE_ID.toLowerCase()) && f.endsWith('.mp4'));
    if (match) return path.join(MEDIA_DIR, match);
  } catch {}

  return null;
}

// ── Load SRT (same pattern as tier2-shots.mjs) ──────────────────────

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

function loadSrt(videoPath) {
  // Try 0: Explicit SRT path from --srt flag
  if (SRT_OVERRIDE && fs.existsSync(SRT_OVERRIDE)) {
    console.log(`   Using SRT override: ${SRT_OVERRIDE}`);
    return parseSrtFile(SRT_OVERRIDE);
  }

  // Try 1: SxxExx pattern in MEDIA_DIR
  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (epMatch) {
    const files = fs.readdirSync(MEDIA_DIR).filter(f => f.toLowerCase().endsWith('.srt'));
    const srtFile = files.find(f => {
      if (new RegExp('s0?' + epMatch[1] + 'e0?' + epMatch[2], 'i').test(f)) return true;
      const altMatch = f.match(/(\d+)x(\d+)/i);
      if (altMatch && parseInt(altMatch[1]) === parseInt(epMatch[1]) && parseInt(altMatch[2]) === parseInt(epMatch[2])) return true;
      return false;
    });
    if (srtFile) return parseSrtFile(path.join(MEDIA_DIR, srtFile));
  }

  // Try 2: Look for SRT next to the video file (from settings.json)
  const settingsPath = path.join(OUT_DIR, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const vp = settings.videoPath || '';
      if (vp) {
        const videoDir = path.dirname(vp);
        const videoBase = path.basename(vp, path.extname(vp)).toLowerCase();
        const srtFiles = fs.readdirSync(videoDir).filter(f => f.toLowerCase().endsWith('.srt'));
        const matched = srtFiles.find(f => {
          const srtBase = f.toLowerCase().replace(/[-_\.]/g, ' ');
          return srtBase.includes(videoBase.replace(/[-_\.]/g, ' ').slice(0, 20));
        });
        if (matched) return parseSrtFile(path.join(videoDir, matched));
        if (srtFiles.length === 1) return parseSrtFile(path.join(videoDir, srtFiles[0]));
      }
    } catch {}
  }

  // Try 3: Search MEDIA_DIR for any SRT with episode ID
  try {
    const files = fs.readdirSync(MEDIA_DIR).filter(f => f.toLowerCase().endsWith('.srt'));
    const match = files.find(f => f.toLowerCase().includes(EPISODE_ID.toLowerCase()));
    if (match) return parseSrtFile(path.join(MEDIA_DIR, match));
    if (files.length === 1) return parseSrtFile(path.join(MEDIA_DIR, files[0]));
  } catch {}

  return [];
}

// ── Matching algorithm ───────────────────────────────────────────────

function calculateWordOverlap(srtWords, whisperWords) {
  if (srtWords.length === 0 || whisperWords.length === 0) return 0;
  let matches = 0;
  const whisperSet = new Set(whisperWords);
  for (const w of srtWords) {
    if (whisperSet.has(w)) matches++;
  }
  // Jaccard-like: penalize length mismatch
  const union = new Set([...srtWords, ...whisperWords]).size;
  return union > 0 ? matches / union : 0;
}

function matchSrtToWhisper(srtEntry, whisperWords) {
  const srtText = normalize(srtEntry.text);
  const srtWordList = srtText.split(/\s+/).filter(w => w.length > 0);
  if (srtWordList.length === 0) return null;

  const srtStart = srtEntry.start;
  const srtDuration = srtEntry.end - srtEntry.start;

  // Search window: +/-10 seconds around the SRT timestamp (SRT drift can be up to 5s)
  const searchStart = srtStart - 10;
  const searchEnd = srtStart + 10 + srtDuration;

  // Find whisper words in the search window
  const candidates = whisperWords.filter(w => w.start >= searchStart && w.start <= searchEnd);
  if (candidates.length === 0) return null;

  let bestScore = 0;
  let bestMatch = null;

  // Sliding window: try each possible start position
  const maxWindowLen = srtWordList.length + 2; // allow slight length mismatch
  for (let i = 0; i < candidates.length; i++) {
    const windowWords = candidates.slice(i, i + maxWindowLen);
    const normalizedWindow = windowWords.map(w => normalize(w.word));
    const score = calculateWordOverlap(srtWordList, normalizedWindow);

    if (score > bestScore) {
      bestScore = score;
      // Take exactly srtWordList.length words (or fewer if at end)
      const matchedWords = candidates.slice(i, i + srtWordList.length);
      bestMatch = {
        words: matchedWords,
        score,
        whisperStart: matchedWords[0]?.start ?? srtEntry.start,
        whisperEnd: matchedWords[matchedWords.length - 1]?.end ?? srtEntry.end,
      };
    }
  }

  return bestMatch;
}

// ── Build flat shot boundary list ────────────────────────────────────

function buildShotList(scenes) {
  const shots = [];
  for (const scene of scenes) {
    for (const shot of (scene.shots || [])) {
      if (shot._synthetic) continue;
      const startSec = parseTs(shot.startTimestamp);
      const endSec = parseTs(shot.endTimestamp);
      shots.push({
        sceneNumber: scene.sceneNumber,
        shotNumber: shot.shotNumber,
        startSec,
        endSec,
        ref: shot, // reference to the original shot object
      });
    }
  }
  shots.sort((a, b) => a.startSec - b.startSec);
  return shots;
}

function findShotForTimestamp(shots, timeSec) {
  // Strict matching: word belongs to the shot it falls within (no end tolerance)
  for (let i = 0; i < shots.length; i++) {
    if (timeSec >= shots[i].startSec && timeSec < shots[i].endSec) {
      return shots[i];
    }
  }
  // Small tolerance for words right at boundaries
  for (let i = 0; i < shots.length; i++) {
    if (timeSec >= shots[i].startSec - 0.15 && timeSec < shots[i].endSec + 0.05) {
      return shots[i];
    }
  }
  // Fallback: find nearest shot
  let best = null, bestDist = Infinity;
  for (const sh of shots) {
    const dist = Math.min(Math.abs(timeSec - sh.startSec), Math.abs(timeSec - sh.endSec));
    if (dist < bestDist) { bestDist = dist; best = sh; }
  }
  return best;
}

// ══════════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Pass 1.1 — Audio-Aligned Dialogue`);
console.log(`  ${EPISODE_ID} | Model: ${WHISPER_MODEL} | Device: ${WHISPER_DEVICE}`);
console.log(`${'═'.repeat(60)}\n`);

// ── Step 1: Load data ────────────────────────────────────────────────

console.log(`📊 Step 1: Loading data`);

const scenesPath = path.join(OUT_DIR, 'scenes.json');
if (!fs.existsSync(scenesPath)) {
  console.error(`   ❌ scenes.json not found: ${scenesPath}`);
  process.exit(1);
}
const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));
const totalShots = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
console.log(`   scenes.json: ${scenes.length} scenes, ${totalShots} shots`);

const videoPath = findVideoFile();
if (!videoPath) {
  console.error(`   ❌ Video file not found for ${EPISODE_ID}`);
  process.exit(1);
}
console.log(`   Video: ${path.basename(videoPath)}`);

const srtEntries = loadSrt(videoPath);
if (srtEntries.length === 0) {
  console.error(`   ❌ No SRT subtitles found for ${EPISODE_ID}`);
  process.exit(1);
}
console.log(`   SRT: ${srtEntries.length} subtitle lines`);

// ── Step 2: Extract audio ────────────────────────────────────────────

console.log(`\n🎵 Step 2: Extracting audio (16kHz mono WAV)`);

const audioPath = path.join(OUT_DIR, `${EPISODE_ID}_audio.wav`);

if (fs.existsSync(audioPath) && !FORCE) {
  const sz = fs.statSync(audioPath).size;
  console.log(`   ✅ Audio cached: ${fmtBytes(sz)}`);
} else {
  try {
    execSync(
      `"${FFMPEG}" -i "${videoPath}" -ac 1 -ar 16000 -c:a pcm_s16le "${audioPath}" -y`,
      { stdio: 'pipe', timeout: 600000 }
    );
    const sz = fs.statSync(audioPath).size;
    // Calculate duration from file size: 16kHz * 16bit * mono = 32000 bytes/sec
    const durationSec = sz / 32000;
    console.log(`   ✅ Audio: ${fmtBytes(sz)} (${durationSec.toFixed(1)}s)`);
  } catch (err) {
    console.error(`   ❌ ffmpeg failed: ${err.message}`);
    process.exit(1);
  }
}

// ── Step 3: Whisper transcription ────────────────────────────────────

console.log(`\n🗣️  Step 3: Whisper transcription (model: ${WHISPER_MODEL}, device: ${WHISPER_DEVICE})`);

const whisperOutputPath = path.join(OUT_DIR, 'whisper-words.json');
const whisperScript = path.join(__dirname, 'pass11_whisper.py');

if (fs.existsSync(whisperOutputPath) && !FORCE) {
  console.log(`   ✅ whisper-words.json cached`);
} else {
  if (!fs.existsSync(whisperScript)) {
    console.error(`   ❌ pass11_whisper.py not found: ${whisperScript}`);
    process.exit(1);
  }

  const startMs = Date.now();
  try {
    execSync(
      `python "${whisperScript}" "${audioPath}" --model ${WHISPER_MODEL} --device ${WHISPER_DEVICE} --output "${whisperOutputPath}"`,
      { stdio: 'inherit', timeout: 600000 } // 10 minute timeout
    );
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const words = JSON.parse(fs.readFileSync(whisperOutputPath, 'utf-8'));
    console.log(`   ✅ ${words.length.toLocaleString()} words transcribed in ${elapsed}s`);
  } catch (err) {
    console.error(`   ❌ Whisper failed: ${err.message}`);
    process.exit(1);
  }
}

const whisperWords = JSON.parse(fs.readFileSync(whisperOutputPath, 'utf-8'));
console.log(`   Loaded ${whisperWords.length.toLocaleString()} Whisper words`);

// ── Step 4: Whisper-first matching (group Whisper words → match to SRT) ───

console.log(`\n🔗 Step 4: Grouping Whisper words into utterances and matching to SRT`);

// Group Whisper words into utterances by silence gaps
const UTTERANCE_GAP = 0.4; // seconds of silence between words to split utterances
const whisperUtterances = [];
let currentUtterance = null;

for (const w of whisperWords) {
  if (!currentUtterance || w.start - currentUtterance.words[currentUtterance.words.length - 1].end > UTTERANCE_GAP) {
    if (currentUtterance) whisperUtterances.push(currentUtterance);
    currentUtterance = { words: [w], start: w.start, end: w.end, text: w.word };
  } else {
    currentUtterance.words.push(w);
    currentUtterance.end = w.end;
    currentUtterance.text += ' ' + w.word;
  }
}
if (currentUtterance) whisperUtterances.push(currentUtterance);
console.log(`   ${whisperUtterances.length} Whisper utterances grouped`);

// For each Whisper utterance, find the best matching SRT line
const usedSrtIndices = new Set();
const matchedLines = [];
let highConfCount = 0, lowConfCount = 0, totalCorrection = 0;

for (const utt of whisperUtterances) {
  const uttNorm = normalize(utt.text);
  const uttWords = uttNorm.split(/\s+/).filter(Boolean);
  if (uttWords.length < 1) continue;

  // Try single SRT line match first
  let bestSingle = null, bestSingleScore = 0;
  for (let si = 0; si < srtEntries.length; si++) {
    if (usedSrtIndices.has(si)) continue;
    const srt = srtEntries[si];
    if (Math.abs(srt.start - utt.start) > 15) continue;
    const srtWords = normalize(srt.text).split(/\s+/).filter(Boolean);
    const score = calculateWordOverlap(srtWords, uttWords);
    if (score > bestSingleScore) {
      bestSingleScore = score;
      bestSingle = { index: si, entry: srt, score };
    }
  }

  // Try multi-SRT match: one utterance may contain 2-3 consecutive SRT lines
  let bestMulti = null, bestMultiScore = 0;
  for (let si = 0; si < srtEntries.length; si++) {
    if (usedSrtIndices.has(si)) continue;
    const srt = srtEntries[si];
    if (Math.abs(srt.start - utt.start) > 15) continue;
    // Try combining this SRT line with the next 1-2 unused consecutive lines
    for (let count = 2; count <= 5; count++) {
      const group = [];
      let allAvailable = true;
      for (let k = 0; k < count; k++) {
        if (si + k >= srtEntries.length || usedSrtIndices.has(si + k)) { allAvailable = false; break; }
        group.push({ index: si + k, entry: srtEntries[si + k] });
      }
      if (!allAvailable || group.length < 2) continue;
      const combinedText = group.map(g => normalize(g.entry.text)).join(' ');
      const combinedWords = combinedText.split(/\s+/).filter(Boolean);
      const score = calculateWordOverlap(combinedWords, uttWords);
      if (score > bestMultiScore) {
        bestMultiScore = score;
        bestMulti = { group, score };
      }
    }
  }

  // Use whichever match is better
  if (bestMulti && bestMultiScore > bestSingleScore && bestMultiScore > 0.25) {
    // Multi-line match: one utterance = multiple SRT lines
    // Distribute Whisper words among the SRT lines proportionally
    let wordIdx = 0;
    for (let gi = 0; gi < bestMulti.group.length; gi++) {
      const g = bestMulti.group[gi];
      usedSrtIndices.add(g.index);
      const srtWordCount = normalize(g.entry.text).split(/\s+/).filter(Boolean).length;
      const totalSrtWords = bestMulti.group.reduce((s, gg) => s + normalize(gg.entry.text).split(/\s+/).filter(Boolean).length, 0);
      const whisperCount = gi === bestMulti.group.length - 1
        ? utt.words.length - wordIdx
        : Math.max(1, Math.round(utt.words.length * srtWordCount / totalSrtWords));
      const segWords = utt.words.slice(wordIdx, wordIdx + whisperCount);
      wordIdx += whisperCount;

      if (segWords.length === 0) continue;
      const correction = Math.abs(segWords[0].start - g.entry.start);
      totalCorrection += correction;
      highConfCount++;

      matchedLines.push({
        srtIndex: g.index,
        srtText: g.entry.text,
        srtStart: g.entry.start,
        srtEnd: g.entry.end,
        whisperStart: segWords[0].start,
        whisperEnd: segWords[segWords.length - 1].end,
        words: segWords,
        confidence: bestMulti.score,
      });
    }
  } else if (bestSingle && bestSingleScore > 0.15) {
    usedSrtIndices.add(bestSingle.index);
    const correction = Math.abs(utt.start - bestSingle.entry.start);
    totalCorrection += correction;
    if (bestSingleScore >= 0.4) highConfCount++; else lowConfCount++;

    matchedLines.push({
      srtIndex: bestSingle.index,
      srtText: bestSingle.entry.text,
      srtStart: bestSingle.entry.start,
      srtEnd: bestSingle.entry.end,
      whisperStart: utt.start,
      whisperEnd: utt.end,
      words: utt.words,
      confidence: bestSingleScore,
    });
  }
}

// Handle unmatched SRT lines — assign with interpolated offset
const unmatchedSrt = srtEntries.filter((_, i) => !usedSrtIndices.has(i));
const sortedMatches = [...matchedLines].sort((a, b) => a.srtStart - b.srtStart);

for (const srt of unmatchedSrt) {
  // Interpolate offset from nearest successful matches
  let before = null, after = null;
  for (const m of sortedMatches) {
    if (m.srtStart <= srt.start && (!before || m.srtStart > before.srtStart)) before = m;
    if (m.srtStart > srt.start && (!after || m.srtStart < after.srtStart)) after = m;
  }
  let offset = 0;
  if (before && after) {
    const bOff = before.whisperStart - before.srtStart;
    const aOff = after.whisperStart - after.srtStart;
    const t = (srt.start - before.srtStart) / Math.max(after.srtStart - before.srtStart, 0.01);
    offset = bOff + (aOff - bOff) * t;
  } else if (before) offset = before.whisperStart - before.srtStart;
  else if (after) offset = after.whisperStart - after.srtStart;

  lowConfCount++;
  totalCorrection += Math.abs(offset);
  matchedLines.push({
    srtIndex: srt.index || srtEntries.indexOf(srt),
    srtText: srt.text,
    srtStart: srt.start,
    srtEnd: srt.end,
    whisperStart: srt.start + offset,
    whisperEnd: srt.end + offset,
    words: [], // no per-word data for interpolated lines
    confidence: 0,
  });
}

// Sort by Whisper start time
matchedLines.sort((a, b) => a.whisperStart - b.whisperStart);

const avgCorrection = matchedLines.length > 0 ? (totalCorrection / matchedLines.length) : 0;
console.log(`   ✅ ${matchedLines.length} lines matched (${highConfCount} high-confidence, ${lowConfCount} low-confidence, ${unmatchedSrt.length} interpolated)`);
console.log(`   Average timestamp correction: ${Math.round(avgCorrection * 1000)}ms`);

// ── Step 5: Assign dialogue to shots with cross-boundary splitting ───

console.log(`\n✂️  Step 5: Assigning dialogue to shots (with cross-boundary splitting)`);

// Build speaker map from existing dialogue before clearing
const speakerMap = new Map(); // normalized text -> speaker
for (const scene of scenes) {
  for (const dlg of (scene.dialogue || [])) {
    const key = normalize(dlg.text);
    if (dlg.speaker && dlg.speaker !== 'Unknown') {
      speakerMap.set(key, dlg.speaker);
    }
  }
  for (const shot of (scene.shots || [])) {
    for (const dlg of (shot.dialogue || [])) {
      const key = normalize(dlg.text);
      if (dlg.speaker && dlg.speaker !== 'Unknown') {
        speakerMap.set(key, dlg.speaker);
      }
    }
  }
}

// Build flat shot list
const shotList = buildShotList(scenes);

// Clear existing dialogue from all scenes and shots
for (const scene of scenes) {
  scene.dialogue = [];
  for (const shot of (scene.shots || [])) {
    shot.dialogue = [];
  }
}

let linesSplit = 0;
let linesRelocated = 0;
let totalEntries = 0;

for (const line of matchedLines) {
  const speaker = speakerMap.get(normalize(line.srtText)) || 'Unknown';

  if (line.words.length >= 2) {
    // We have per-word timestamps — check for cross-boundary splits
    const wordShots = line.words.map(w => ({
      word: w.word,
      start: w.start,
      end: w.end,
      shot: findShotForTimestamp(shotList, w.start),
    }));

    // Group consecutive words by shot
    const segments = [];
    let currentSegment = null;

    for (const ws of wordShots) {
      const shotKey = ws.shot ? `${ws.shot.sceneNumber}.${ws.shot.shotNumber}` : null;
      if (!currentSegment || currentSegment.shotKey !== shotKey) {
        if (currentSegment) segments.push(currentSegment);
        currentSegment = {
          shotKey,
          shot: ws.shot,
          words: [ws],
        };
      } else {
        currentSegment.words.push(ws);
      }
    }
    if (currentSegment) segments.push(currentSegment);

    if (segments.length > 1) {
      linesSplit++;
    }

    // Check if the line moved to a different shot than original SRT timing
    const originalShot = findShotForTimestamp(shotList, line.srtStart);
    const newPrimaryShot = segments[0]?.shot;
    if (originalShot && newPrimaryShot &&
        (originalShot.sceneNumber !== newPrimaryShot.sceneNumber ||
         originalShot.shotNumber !== newPrimaryShot.shotNumber)) {
      linesRelocated++;
    }

    // Create dialogue entries for each segment
    // Use original SRT text — only split it when crossing shot boundaries
    const srtTextWords = line.srtText.split(/\s+/);

    if (segments.length === 1) {
      // No split — use original SRT text exactly as-is
      const seg = segments[0];
      if (!seg.shot) continue;
      const startSec = seg.words[0].start;
      const endSec = seg.words[seg.words.length - 1].end;

      const dlgEntry = {
        speaker,
        text: line.srtText,
        start: fmtTs(startSec),
        end: fmtTs(endSec),
      };
      seg.shot.ref.dialogue.push(dlgEntry);

      const parentScene = scenes.find(sc => sc.sceneNumber === seg.shot.sceneNumber);
      if (parentScene) {
        if (!parentScene.dialogue) parentScene.dialogue = [];
        parentScene.dialogue.push({ ...dlgEntry });
      }
      totalEntries++;
      continue;
    }

    // Multi-segment (cross-boundary split) — split SRT text proportionally by word count
    let srtWordIdx = 0;
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      if (!seg.shot) continue;
      // Allocate SRT words proportionally to Whisper word count in this segment
      const whisperWordsInSeg = seg.words.length;
      const totalWhisperRemaining = segments.slice(si).reduce((s, g) => s + g.words.length, 0);
      const srtWordsRemaining = srtTextWords.length - srtWordIdx;
      const srtWordCount = si === segments.length - 1
        ? srtWordsRemaining  // last segment gets everything remaining
        : Math.max(1, Math.round(srtWordsRemaining * whisperWordsInSeg / totalWhisperRemaining));
      const segSrtWords = srtTextWords.slice(srtWordIdx, srtWordIdx + srtWordCount);
      srtWordIdx += srtWordCount;
      const text = segSrtWords.join(' ');
      if (!text) continue;
      const startSec = seg.words[0].start;
      const endSec = seg.words[seg.words.length - 1].end;

      const dlgEntry = {
        speaker,
        text,
        start: fmtTs(startSec),
        end: fmtTs(endSec),
      };

      // Add to the shot
      seg.shot.ref.dialogue.push(dlgEntry);

      // Also add to the parent scene
      const parentScene = scenes.find(sc => sc.sceneNumber === seg.shot.sceneNumber);
      if (parentScene) {
        parentScene.dialogue.push(dlgEntry);
      }

      totalEntries++;
    }
  } else {
    // No per-word timestamps — use the (potentially corrected) line-level timing
    const startSec = line.whisperStart;
    const endSec = line.whisperEnd;
    const shot = findShotForTimestamp(shotList, startSec);

    // Check if relocated
    const originalShot = findShotForTimestamp(shotList, line.srtStart);
    if (originalShot && shot &&
        (originalShot.sceneNumber !== shot.sceneNumber ||
         originalShot.shotNumber !== shot.shotNumber)) {
      linesRelocated++;
    }

    const dlgEntry = {
      speaker,
      text: line.srtText,
      start: fmtTs(startSec),
      end: fmtTs(endSec),
    };

    if (shot) {
      shot.ref.dialogue.push(dlgEntry);
      const parentScene = scenes.find(sc => sc.sceneNumber === shot.sceneNumber);
      if (parentScene) {
        parentScene.dialogue.push(dlgEntry);
      }
    } else {
      // Fallback: assign to nearest scene by timestamp
      const scene = scenes.find(sc => {
        const scStart = sc.shots?.[0] ? parseTs(sc.shots[0].startTimestamp) : 0;
        const scEnd = sc.shots?.[sc.shots.length - 1] ? parseTs(sc.shots[sc.shots.length - 1].endTimestamp) : 0;
        return startSec >= scStart - 0.5 && startSec <= scEnd + 0.5;
      });
      if (scene) scene.dialogue.push(dlgEntry);
    }

    totalEntries++;
  }
}

console.log(`   ✅ ${srtEntries.length} SRT lines → ${totalEntries} dialogue entries (${linesSplit} lines split at shot boundaries)`);
console.log(`   Lines moved to different shot: ${linesRelocated}`);

// ── Step 6: Save ─────────────────────────────────────────────────────

console.log(`\n💾 Step 6: Saving`);

// Save scenes.json
fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2));
console.log(`   ✅ scenes.json updated`);

// Save pass11-report.json
const report = {
  episodeId: EPISODE_ID,
  timestamp: new Date().toISOString(),
  whisperModel: WHISPER_MODEL,
  whisperDevice: WHISPER_DEVICE,
  stats: {
    srtLines: srtEntries.length,
    whisperWords: whisperWords.length,
    matchedLines: matchedLines.length,
    highConfidence: highConfCount,
    lowConfidence: lowConfCount,
    totalDialogueEntries: totalEntries,
    linesSplit,
    linesRelocated,
    avgCorrectionMs: Math.round(avgCorrection * 1000),
  },
  matchDetails: matchedLines.map(m => ({
    srtIndex: m.srtIndex,
    text: m.srtText.slice(0, 80),
    confidence: Math.round(m.confidence * 100) / 100,
    correctionMs: Math.round(Math.abs(m.whisperStart - m.srtStart) * 1000),
    wordCount: m.words.length,
  })),
};
const reportPath = path.join(OUT_DIR, 'pass11-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`   ✅ pass11-report.json saved`);

// Rebuild DB
try {
  execSync(`node "${path.join(__dirname, 'db.mjs')}" --rebuild ${EPISODE_ID}`,
    { cwd: __dirname, stdio: 'pipe', timeout: 30000 });
  console.log(`   ✅ DB rebuilt`);
} catch (err) {
  console.error(`   ⚠️  DB rebuild failed: ${err.message}`);
}

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ✅ Pass 1.1 Complete!`);
console.log(`  ${srtEntries.length} lines processed | ${linesSplit} cross-boundary splits | ${linesRelocated} lines relocated`);
console.log(`  Average correction: ${Math.round(avgCorrection * 1000)}ms | Whisper words: ${whisperWords.length.toLocaleString()}`);
console.log(`${'═'.repeat(60)}\n`);
