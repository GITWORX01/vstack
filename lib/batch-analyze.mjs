#!/usr/bin/env node
/**
 * Batch Episode Analyzer
 *
 * Processes multiple episodes sequentially with intelligent scheduling,
 * cost tracking, and resume capability.
 *
 * Usage:
 *   node batch-analyze.mjs --season 1                    # All of season 1
 *   node batch-analyze.mjs --season 2 --start 1 --end 5  # S02E01-E05
 *   node batch-analyze.mjs --list episodes.json          # Custom episode list
 *   node batch-analyze.mjs --resume                      # Resume interrupted batch
 *   node batch-analyze.mjs --status                      # Show progress
 *   node batch-analyze.mjs --dry-run --season 1          # Cost estimate only
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────

const MEDIA_DIR = process.env.MEDIA_DIR || 'C:\\Star Trek';
const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');
const STATE_FILE = path.join(ANALYSIS_DIR, 'batch-state.json');
const EPISODE_COOLDOWN_MS = 60000;  // 1 min between episodes
const COST_PER_MINUTE_LOW = 0.0568; // Gemini 2.5 Pro LOW resolution $/min

const ffmpegDir = path.join(__dirname, 'ffmpeg');
const subdirs = fs.readdirSync(ffmpegDir).filter(d =>
  d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory()
);
const FFPROBE = path.join(ffmpegDir, subdirs[0], 'bin', 'ffprobe.exe');

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf('--' + name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
const hasFlag = (name) => args.includes('--' + name);

const SEASON = getArg('season') ? parseInt(getArg('season')) : undefined;
const START_EP = getArg('start') ? parseInt(getArg('start')) : 1;
const END_EP = getArg('end') ? parseInt(getArg('end')) : 99;
const CUSTOM_LIST = getArg('list');
const RESUME = hasFlag('resume');
const STATUS = hasFlag('status');
const DRY_RUN = hasFlag('dry-run');
const SKIP_UPLOAD = hasFlag('skip-upload');

// ── Episode Discovery ────────────────────────────────────────────────

function discoverEpisodes() {
  const files = fs.readdirSync(MEDIA_DIR).filter(f =>
    f.toLowerCase().endsWith('.mp4') &&
    f.toLowerCase().includes('star trek tng')
  );

  const episodes = [];
  for (const file of files) {
    const match = file.match(/s(\d+)e(\d+)/i);
    if (!match) continue;

    const season = parseInt(match[1]);
    const episode = parseInt(match[2]);

    // Skip duplicate files (files ending with (1).mp4)
    if (file.match(/\(\d+\)\.mp4$/)) continue;

    const epId = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

    episodes.push({
      id: epId,
      season,
      episode,
      file: path.join(MEDIA_DIR, file),
      filename: file,
    });
  }

  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);

  // Deduplicate by ID
  const seen = new Set();
  return episodes.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

function filterEpisodes(episodes) {
  if (CUSTOM_LIST) {
    const list = JSON.parse(fs.readFileSync(CUSTOM_LIST, 'utf-8'));
    const ids = new Set(list.map(e => e.id || e));
    return episodes.filter(e => ids.has(e.id));
  }

  if (SEASON !== undefined) {
    return episodes.filter(e =>
      e.season === SEASON &&
      e.episode >= START_EP &&
      e.episode <= END_EP
    );
  }

  return episodes;
}

// ── Duration & Cost ──────────────────────────────────────────────────

function getEpisodeDuration(filePath) {
  try {
    return parseFloat(execSync(
      `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { encoding: 'utf-8' }
    ).trim());
  } catch {
    return 2700; // default 45 min
  }
}

function estimateCost(durationSec) {
  const minutes = durationSec / 60;
  const chunks = Math.ceil(minutes / 15);
  return chunks * 15 * COST_PER_MINUTE_LOW;
}

// ── Batch State ──────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
  return { startedAt: new Date().toISOString(), episodes: {}, totalCost: 0 };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── SRT Discovery ────────────────────────────────────────────────────

function findSrt(episodeId) {
  const files = fs.readdirSync(MEDIA_DIR).filter(f => f.toLowerCase().endsWith('.srt'));
  const epMatch = episodeId.match(/S(\d+)E(\d+)/i);
  if (!epMatch) return null;
  const pattern = new RegExp(`s0?${epMatch[1]}e0?${epMatch[2]}`, 'i');
  const match = files.find(f => pattern.test(f));
  return match ? '📝' : '';
}

// ── Status Display ───────────────────────────────────────────────────

function showStatus() {
  const state = loadState();
  const eps = Object.entries(state.episodes);

  const completed = eps.filter(([, e]) => e.status === 'completed');
  const failed = eps.filter(([, e]) => e.status === 'failed');
  const pending = eps.filter(([, e]) => e.status === 'pending');

  console.log(`\n  Batch Analysis Status`);
  console.log(`  Started: ${state.startedAt}`);
  console.log(`  Completed: ${completed.length} | Pending: ${pending.length} | Failed: ${failed.length}`);
  console.log(`  Total cost: $${state.totalCost.toFixed(2)}\n`);

  for (const [id, ep] of eps) {
    const icon = ep.status === 'completed' ? '✅' : ep.status === 'failed' ? '❌' : '⏳';
    const cost = ep.cost ? ` ($${ep.cost.toFixed(2)})` : '';
    const scenes = ep.scenes ? ` | ${ep.scenes} scenes, ${ep.shots} shots` : '';
    console.log(`  ${icon} ${id}${cost}${scenes}`);
    if (ep.error) console.log(`     Error: ${ep.error.slice(0, 100)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  if (STATUS) { showStatus(); return; }

  const allEpisodes = discoverEpisodes();
  const episodes = filterEpisodes(allEpisodes);

  if (episodes.length === 0) {
    console.error('No episodes found. Use --season N or --list file.json');
    process.exit(1);
  }

  const state = RESUME ? loadState() : {
    startedAt: new Date().toISOString(), episodes: {}, totalCost: 0
  };

  console.log(`\n  Batch Episode Analyzer — ${episodes.length} episodes\n`);

  let totalMinutes = 0;
  let totalEstCost = 0;

  for (const ep of episodes) {
    const dur = getEpisodeDuration(ep.file);
    const cost = estimateCost(dur);
    const durMin = dur / 60;
    const srt = findSrt(ep.id);
    const status = state.episodes[ep.id]?.status;
    const statusIcon = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏳';

    totalMinutes += durMin;
    totalEstCost += cost;
    ep.duration = dur;
    ep.estimatedCost = cost;

    console.log(`  ${statusIcon} ${ep.id} ${srt} ${durMin.toFixed(0)}min  ~$${cost.toFixed(2)}  ${ep.filename.slice(0, 55)}`);

    if (!state.episodes[ep.id]) {
      state.episodes[ep.id] = { status: 'pending' };
    }
  }

  console.log(`\n  Total: ${totalMinutes.toFixed(0)}min | Est. cost: $${totalEstCost.toFixed(2)}\n`);

  if (DRY_RUN) { console.log('  --dry-run: exiting'); return; }

  const toProcess = episodes.filter(ep => state.episodes[ep.id]?.status !== 'completed');

  if (toProcess.length === 0) {
    console.log('  All done! Use without --resume for fresh start.');
    return;
  }

  console.log(`  Processing ${toProcess.length} episodes...\n`);
  saveState(state);

  for (let i = 0; i < toProcess.length; i++) {
    const ep = toProcess[i];
    const epState = state.episodes[ep.id];

    console.log(`\n  [${i + 1}/${toProcess.length}] ${ep.id}: ${ep.filename}`);

    epState.status = 'running';
    epState.startedAt = new Date().toISOString();
    saveState(state);

    try {
      const analyzeArgs = [
        path.join(__dirname, 'analyze-episode.mjs'),
        ep.id,
        ep.file,
      ];
      if (SKIP_UPLOAD) analyzeArgs.push('--skip-upload');

      execSync(`node ${analyzeArgs.map(a => `"${a}"`).join(' ')}`, {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 30 * 60 * 1000, // 30 min max per episode
        stdio: 'inherit',
      });

      const scenesFile = path.join(ANALYSIS_DIR, ep.id, 'scenes.json');
      if (fs.existsSync(scenesFile)) {
        const scenes = JSON.parse(fs.readFileSync(scenesFile, 'utf-8'));
        const totalShots = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
        const noShots = scenes.filter(s => !s.shots?.length).length;

        epState.status = 'completed';
        epState.completedAt = new Date().toISOString();
        epState.scenes = scenes.length;
        epState.shots = totalShots;
        epState.scenesWithoutShots = noShots;
        epState.cost = ep.estimatedCost;
        state.totalCost += ep.estimatedCost;
      } else {
        epState.status = 'failed';
        epState.error = 'No scenes.json produced';
      }
    } catch (err) {
      epState.status = 'failed';
      epState.error = err.message?.slice(0, 200);
      epState.failedAt = new Date().toISOString();
    }

    saveState(state);

    if (i < toProcess.length - 1) {
      console.log(`  ⏳ Cooldown ${EPISODE_COOLDOWN_MS / 1000}s...`);
      await new Promise(r => setTimeout(r, EPISODE_COOLDOWN_MS));
    }
  }

  // Summary
  const completed = Object.values(state.episodes).filter(e => e.status === 'completed').length;
  const failed = Object.values(state.episodes).filter(e => e.status === 'failed').length;
  console.log(`\n  Batch Complete: ✅ ${completed} | ❌ ${failed} | $${state.totalCost.toFixed(2)}`);
  if (failed > 0) console.log(`  Retry failed with: node batch-analyze.mjs --resume`);
}

main().catch(err => { console.error(`❌ ${err.message}`); process.exit(1); });
