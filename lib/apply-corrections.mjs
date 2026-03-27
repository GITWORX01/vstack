#!/usr/bin/env node
/**
 * Apply Scene Review Corrections
 *
 * Parses the correction export from the Scene Review Report and applies
 * timestamp adjustments to scenes.json. Auto-rebuilds the DB and re-extracts
 * affected frames.
 *
 * Usage:
 *   node apply-corrections.mjs S02E01 corrections.txt
 *   node apply-corrections.mjs S02E01 --stdin < corrections.txt
 *   echo "Scene 1, Shot 3: start -30ms" | node apply-corrections.mjs S02E01 --stdin
 *
 * Correction format (from report export):
 *   Scene 1, Shot 3: start -30ms (21.100s -> 21.070s) end -70ms (30.600s -> 30.530s) [LOCKED]
 *   Scene 4, Shot 2: end -50ms (144.400s -> 144.350s) [LOCKED]
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────

const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');

const ffmpegDir = path.join(__dirname, 'ffmpeg');
const subdirs = fs.readdirSync(ffmpegDir).filter(d =>
  d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory()
);
const FFMPEG = path.join(ffmpegDir, subdirs[0], 'bin', 'ffmpeg.exe');

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const EPISODE_ID = args[0];
const FROM_STDIN = args.includes('--stdin');
const CORRECTION_FILE = args.find(a => !a.startsWith('-') && a !== EPISODE_ID);
const DRY_RUN = args.includes('--dry-run');

if (!EPISODE_ID) {
  console.error('Usage: node apply-corrections.mjs EPISODE_ID [corrections.txt | --stdin] [--dry-run]');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseTs(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const [m, s] = ts.split(':');
  if (!s) return 0;
  return parseInt(m) * 60 + parseFloat(s);
}

function fmtTs(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

// ── Parse Corrections ────────────────────────────────────────────────

function parseCorrections(text) {
  const corrections = [];
  const lines = text.split('\n').filter(l => l.trim());

  for (const line of lines) {
    // Match: Scene N, Shot M: start +/-Xms ... end +/-Xms ...
    const match = line.match(/Scene\s+(\d+),?\s*Shot\s+(\d+):\s*(.*)/i);
    if (!match) continue;

    const scene = parseInt(match[1]);
    const shot = parseInt(match[2]);
    const details = match[3];

    let startMs = 0;
    let endMs = 0;

    // Parse start adjustment
    const startMatch = details.match(/start\s+([+-]?\d+)ms/i);
    if (startMatch) startMs = parseInt(startMatch[1]);

    // Parse end adjustment
    const endMatch = details.match(/end\s+([+-]?\d+)ms/i);
    if (endMatch) endMs = parseInt(endMatch[1]);

    if (startMs !== 0 || endMs !== 0) {
      corrections.push({ scene, shot, startMs, endMs, raw: line.trim() });
    }
  }

  return corrections;
}

// ── Apply ────────────────────────────────────────────────────────────

async function main() {
  const episodeDir = path.join(ANALYSIS_DIR, EPISODE_ID);
  const scenesPath = path.join(episodeDir, 'scenes.json');

  if (!fs.existsSync(scenesPath)) {
    console.error(`scenes.json not found for ${EPISODE_ID}`);
    process.exit(1);
  }

  // Read corrections
  let correctionText;
  if (FROM_STDIN) {
    correctionText = fs.readFileSync(0, 'utf-8'); // stdin
  } else if (CORRECTION_FILE && fs.existsSync(CORRECTION_FILE)) {
    correctionText = fs.readFileSync(CORRECTION_FILE, 'utf-8');
  } else {
    console.error('Provide a corrections file or use --stdin');
    process.exit(1);
  }

  const corrections = parseCorrections(correctionText);
  if (corrections.length === 0) {
    console.log('No corrections found in input.');
    return;
  }

  console.log(`\n📝 ${corrections.length} corrections for ${EPISODE_ID}:\n`);

  // Load scenes
  const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));
  const affectedShots = [];

  for (const c of corrections) {
    const sc = scenes.find(s => s.sceneNumber === c.scene);
    if (!sc) { console.log(`  ⚠️  Scene ${c.scene} not found — skipping`); continue; }
    const sh = sc.shots?.find(s => s.shotNumber === c.shot);
    if (!sh) { console.log(`  ⚠️  Scene ${c.scene} Shot ${c.shot} not found — skipping`); continue; }

    const oldStart = sh.startTimestamp;
    const oldEnd = sh.endTimestamp;

    if (c.startMs !== 0) {
      const newSec = parseTs(sh.startTimestamp) + c.startMs / 1000;
      sh.startTimestamp = fmtTs(newSec);
    }
    if (c.endMs !== 0) {
      const newSec = parseTs(sh.endTimestamp) + c.endMs / 1000;
      sh.endTimestamp = fmtTs(newSec);
    }

    const startChange = c.startMs !== 0 ? ` start ${c.startMs > 0 ? '+' : ''}${c.startMs}ms` : '';
    const endChange = c.endMs !== 0 ? ` end ${c.endMs > 0 ? '+' : ''}${c.endMs}ms` : '';
    console.log(`  ✅ Scene ${c.scene} Shot ${c.shot}:${startChange}${endChange}`);
    console.log(`     ${oldStart} → ${sh.startTimestamp} | ${oldEnd} → ${sh.endTimestamp}`);

    affectedShots.push({ scene: c.scene, shot: c.shot, startTs: sh.startTimestamp, endTs: sh.endTimestamp });
  }

  if (DRY_RUN) {
    console.log('\n  --dry-run: no files modified');
    return;
  }

  // Save scenes.json
  fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2));
  console.log(`\n💾 Saved scenes.json`);

  // Re-extract frames for affected shots
  if (affectedShots.length > 0) {
    console.log(`📸 Re-extracting ${affectedShots.length} affected frames...`);
    const framesDir = path.join(episodeDir, 'frames');

    // Find the episode video file
    const mediaDir = process.env.MEDIA_DIR || 'C:\\Star Trek';
    const mediaFiles = fs.readdirSync(mediaDir);
    const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
    const pattern = epMatch ? new RegExp(`s0?${epMatch[1]}e0?${epMatch[2]}`, 'i') : null;
    const videoFile = pattern ? mediaFiles.find(f => pattern.test(f) && f.endsWith('.mp4')) : null;

    if (videoFile) {
      const videoPath = path.join(mediaDir, videoFile);
      for (const s of affectedShots) {
        const first = path.join(framesDir, `sc${s.scene}_sh${s.shot}_first.jpg`);
        const last = path.join(framesDir, `sc${s.scene}_sh${s.shot}_last.jpg`);
        const startSec = parseTs(s.startTs);
        const endSec = parseTs(s.endTs);
        try {
          execSync(`"${FFMPEG}" -ss ${startSec.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf scale=320:-1 "${first}" -y`, { stdio: 'pipe', timeout: 10000 });
          execSync(`"${FFMPEG}" -ss ${endSec.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf scale=320:-1 "${last}" -y`, { stdio: 'pipe', timeout: 10000 });
        } catch { console.log(`    ⚠️  Frame extraction failed for Scene ${s.scene} Shot ${s.shot}`); }
      }
      console.log(`  ✅ Frames updated`);
    } else {
      console.log(`  ⚠️  Video file not found — frames not updated`);
    }
  }

  // Rebuild DB
  try {
    const { rebuildEpisode, closeDb } = await import('./db.mjs');
    const result = rebuildEpisode(EPISODE_ID, scenesPath);
    if (result) {
      console.log(`🗃️  Database updated`);
    }
    closeDb();
  } catch (err) {
    console.log(`⚠️  DB update skipped: ${err.message?.slice(0, 60)}`);
  }

  // Rebuild report
  try {
    const videoFile = affectedShots.length > 0 ? path.join(process.env.MEDIA_DIR || 'C:\\Star Trek',
      fs.readdirSync(process.env.MEDIA_DIR || 'C:\\Star Trek').find(f => {
        const m = EPISODE_ID.match(/S(\d+)E(\d+)/i);
        return m && new RegExp(`s0?${m[1]}e0?${m[2]}`, 'i').test(f) && f.endsWith('.mp4');
      }) || '') : '';

    if (videoFile && fs.existsSync(videoFile)) {
      execSync(`node "${path.join(__dirname, 'rebuild-report.mjs')}" "${EPISODE_ID}" "${videoFile}"`, { stdio: 'inherit' });
    }
  } catch {
    console.log(`⚠️  Report rebuild skipped`);
  }

  console.log(`\n✅ ${corrections.length} corrections applied to ${EPISODE_ID}`);
}

main().catch(err => { console.error(`❌ ${err.message}`); process.exit(1); });
