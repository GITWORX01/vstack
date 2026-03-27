#!/usr/bin/env node
/**
 * Batch Episode Analyzer
 *
 * Runs analyze-episode.mjs across multiple episodes with:
 * - Smart rate limit management (exponential backoff between episodes)
 * - Progress tracking and resume capability
 * - Cost tracking and budget enforcement
 * - HTML progress dashboard
 * - Failure recovery (skip failed, continue with rest)
 *
 * Usage:
 *   node batch-analyze.mjs --dir "C:\Star Trek" --pattern "S02*"
 *   node batch-analyze.mjs --dir "C:\Star Trek" --season 2
 *   node batch-analyze.mjs --dir "C:\Star Trek" --episodes S02E01,S02E02,S02E03
 *   node batch-analyze.mjs --dir "C:\Star Trek" --list   (dry run: show what would be processed)
 *   node batch-analyze.mjs --resume                      (resume from last run)
 *
 * Options:
 *   --dir PATH           Directory containing video files
 *   --pattern GLOB       Glob pattern for filenames (e.g. "S02*", "*Picard*")
 *   --season N           Shorthand: process all episodes from season N
 *   --episodes LIST      Comma-separated episode IDs (e.g. S02E01,S02E03)
 *   --list               Dry run: list episodes that would be processed
 *   --resume             Resume from last batch run (skip completed episodes)
 *   --skip-upload        Skip GCS upload (assume files already uploaded)
 *   --max-cost USD       Stop if estimated cost exceeds this (default: $100)
 *   --cooldown SECONDS   Cooldown between episodes (default: 60)
 *   --max-concurrent N   Max episodes to process (rate limit safety, default: 1)
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf('--' + name);
  if (idx === -1) return fallback;
  if (idx + 1 >= args.length) return true; // flag with no value
  const val = args[idx + 1];
  if (val.startsWith('--')) return true; // next arg is a flag
  return val;
}

const SOURCE_DIR = getArg('dir', '');
const PATTERN = getArg('pattern', '');
const SEASON = getArg('season', '');
const EPISODES = getArg('episodes', '');
const LIST_ONLY = args.includes('--list');
const RESUME = args.includes('--resume');
const SKIP_UPLOAD = args.includes('--skip-upload');
const MAX_COST = parseFloat(getArg('max-cost', '100'));
const COOLDOWN_SEC = parseInt(getArg('cooldown', '60'));

// ── State ────────────────────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, '..', '.batch-state.json');

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
  return { episodes: {}, totalCost: 0, startedAt: new Date().toISOString() };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Episode Discovery ────────────────────────────────────────────────

function discoverEpisodes() {
  if (!SOURCE_DIR) {
    console.error('❌ --dir is required. Specify the directory containing video files.');
    process.exit(1);
  }

  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`❌ Directory not found: ${SOURCE_DIR}`);
    process.exit(1);
  }

  const allFiles = fs.readdirSync(SOURCE_DIR).filter(f =>
    f.toLowerCase().endsWith('.mp4') || f.toLowerCase().endsWith('.mkv')
  );

  let filtered = allFiles;

  // Filter by season
  if (SEASON) {
    const seasonPat = new RegExp(`s0?${SEASON}e\\d+`, 'i');
    filtered = filtered.filter(f => seasonPat.test(f));
  }

  // Filter by pattern
  if (PATTERN) {
    const patParts = PATTERN.toLowerCase().replace(/\*/g, '.*');
    const patRe = new RegExp(patParts, 'i');
    filtered = filtered.filter(f => patRe.test(f));
  }

  // Filter by explicit episode list
  if (EPISODES) {
    const epList = EPISODES.split(',').map(e => e.trim().toUpperCase());
    filtered = filtered.filter(f => {
      const match = f.match(/s(\d+)e(\d+)/i);
      if (!match) return false;
      const id = `S${match[1].padStart(2, '0')}E${match[2].padStart(2, '0')}`;
      return epList.includes(id);
    });
  }

  // Extract episode IDs and sort
  const episodes = [];
  const seen = new Set();

  for (const file of filtered) {
    const match = file.match(/s(\d+)e(\d+)/i);
    if (!match) continue;

    const id = `S${match[1].padStart(2, '0')}E${match[2].padStart(2, '0')}`;
    if (seen.has(id)) continue; // skip duplicate files for same episode
    seen.add(id);

    episodes.push({
      id,
      file: path.join(SOURCE_DIR, file),
      season: parseInt(match[1]),
      episode: parseInt(match[2]),
    });
  }

  // Sort by season then episode
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return episodes;
}

// ── Cost Estimation ──────────────────────────────────────────────────

function estimateCost(episodes) {
  // Based on our measurements: ~$2.96 per 45-min episode at LOW resolution
  const costPerMinute = 2.96 / 45;
  let total = 0;

  for (const ep of episodes) {
    // Estimate 45 min per standard episode, 90 for double
    const isDouble = /e\d+e\d+|part.*1.*2/i.test(ep.file);
    const estMinutes = isDouble ? 90 : 45;
    total += estMinutes * costPerMinute;
  }

  return total;
}

// ── Run Single Episode ───────────────────────────────────────────────

function runEpisode(episode, skipUpload) {
  return new Promise((resolve) => {
    const args = [
      path.join(__dirname, 'analyze-episode.mjs'),
      episode.id,
      episode.file,
    ];
    if (skipUpload) args.push('--skip-upload');

    const startTime = Date.now();

    const proc = spawn('node', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      process.stdout.write(chunk);
    });

    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    proc.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(0);

      // Try to extract cost from stdout
      const costMatch = stdout.match(/\$(\d+\.\d+)/g);
      const cost = costMatch
        ? costMatch.reduce((sum, m) => sum + parseFloat(m.replace('$', '')), 0)
        : 0;

      // Try to extract scene/shot count
      const sceneMatch = stdout.match(/(\d+) scenes/);
      const shotMatch = stdout.match(/(\d+) shots/);

      resolve({
        success: code === 0,
        exitCode: code,
        duration: parseInt(duration),
        cost,
        scenes: sceneMatch ? parseInt(sceneMatch[1]) : 0,
        shots: shotMatch ? parseInt(shotMatch[1]) : 0,
        error: code !== 0 ? stderr.slice(-500) : null,
      });
    });
  });
}

// ── Progress Dashboard ───────────────────────────────────────────────

function printProgress(state, episodes, currentIdx) {
  const completed = Object.values(state.episodes).filter(e => e.status === 'completed').length;
  const failed = Object.values(state.episodes).filter(e => e.status === 'failed').length;
  const remaining = episodes.length - completed - failed;
  const pct = ((completed / episodes.length) * 100).toFixed(0);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Progress: ${completed}/${episodes.length} completed (${pct}%) | ${failed} failed | ${remaining} remaining`);
  console.log(`  Cost so far: $${state.totalCost.toFixed(2)} / $${MAX_COST} budget`);
  console.log(`${'─'.repeat(60)}\n`);
}

function buildDashboard(state, episodes) {
  const rows = episodes.map(ep => {
    const s = state.episodes[ep.id] || { status: 'pending' };
    const statusIcon = {
      completed: '✅',
      failed: '❌',
      running: '🔄',
      skipped: '⏭️',
      pending: '⬜',
    }[s.status] || '⬜';

    return `<tr>
      <td>${statusIcon}</td>
      <td><strong>${ep.id}</strong></td>
      <td>${path.basename(ep.file).slice(0, 50)}</td>
      <td>${s.status || 'pending'}</td>
      <td>${s.scenes || '-'}</td>
      <td>${s.shots || '-'}</td>
      <td>${s.cost ? '$' + s.cost.toFixed(2) : '-'}</td>
      <td>${s.duration ? s.duration + 's' : '-'}</td>
      <td>${s.error ? s.error.slice(0, 60) : ''}</td>
    </tr>`;
  }).join('\n');

  const completed = Object.values(state.episodes).filter(e => e.status === 'completed').length;
  const failed = Object.values(state.episodes).filter(e => e.status === 'failed').length;

  const html = `<!DOCTYPE html><html><head><title>Batch Analysis Dashboard</title>
<meta http-equiv="refresh" content="30">
<style>
body{font-family:sans-serif;background:#0a0a1a;color:#eee;padding:20px;max-width:1200px;margin:0 auto}
h1{color:#4fc3f7}
.stats{display:flex;gap:20px;margin-bottom:20px}
.stat{background:#1a1a2e;padding:12px 20px;border-radius:8px;text-align:center}
.stat-val{font-size:28px;font-weight:bold;color:#4fc3f7}
.stat-lbl{font-size:11px;color:#888}
table{width:100%;border-collapse:collapse;background:#1a1a2e;border-radius:8px;overflow:hidden}
th{background:#0d3b66;padding:8px 12px;text-align:left;font-size:12px;color:#4fc3f7}
td{padding:6px 12px;border-bottom:1px solid #222;font-size:12px}
tr:hover{background:#0f0f23}
.bar{background:#333;border-radius:4px;height:20px;margin:10px 0}
.bar-fill{background:#4fc3f7;height:100%;border-radius:4px;transition:width 0.3s}
</style></head><body>
<h1>Batch Analysis Dashboard</h1>
<div class="stats">
  <div class="stat"><div class="stat-val">${completed}</div><div class="stat-lbl">Completed</div></div>
  <div class="stat"><div class="stat-val">${failed}</div><div class="stat-lbl">Failed</div></div>
  <div class="stat"><div class="stat-val">${episodes.length - completed - failed}</div><div class="stat-lbl">Remaining</div></div>
  <div class="stat"><div class="stat-val">$${state.totalCost.toFixed(2)}</div><div class="stat-lbl">Cost</div></div>
</div>
<div class="bar"><div class="bar-fill" style="width:${(completed/episodes.length*100).toFixed(0)}%"></div></div>
<table>
<tr><th></th><th>Episode</th><th>File</th><th>Status</th><th>Scenes</th><th>Shots</th><th>Cost</th><th>Time</th><th>Error</th></tr>
${rows}
</table>
<p style="color:#666;font-size:11px;margin-top:20px">Auto-refreshes every 30s. Started: ${state.startedAt}</p>
</body></html>`;

  const dashPath = path.join(__dirname, '..', 'batch-dashboard.html');
  fs.writeFileSync(dashPath, html);
  return dashPath;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  vstack Batch Episode Analyzer`);
  console.log(`${'═'.repeat(60)}\n`);

  const episodes = discoverEpisodes();

  if (episodes.length === 0) {
    console.error('❌ No episodes found matching your criteria.');
    console.error(`   Dir: ${SOURCE_DIR}`);
    console.error(`   Pattern: ${PATTERN || '(none)'}`);
    console.error(`   Season: ${SEASON || '(none)'}`);
    process.exit(1);
  }

  // Estimate costs
  const estCost = estimateCost(episodes);

  console.log(`📋 ${episodes.length} episodes found:`);
  for (const ep of episodes) {
    console.log(`   ${ep.id}: ${path.basename(ep.file)}`);
  }
  console.log(`\n💰 Estimated cost: $${estCost.toFixed(2)} (at LOW resolution)`);
  console.log(`   Budget limit: $${MAX_COST}`);

  if (estCost > MAX_COST) {
    console.error(`\n⚠️  Estimated cost ($${estCost.toFixed(2)}) exceeds budget ($${MAX_COST}).`);
    console.error(`   Use --max-cost ${Math.ceil(estCost)} to increase budget.`);
    if (!LIST_ONLY) process.exit(1);
  }

  if (LIST_ONLY) {
    console.log(`\n(Dry run — use without --list to process)`);
    process.exit(0);
  }

  // Load or create state
  const state = RESUME ? loadState() : {
    episodes: {},
    totalCost: 0,
    startedAt: new Date().toISOString(),
    sourceDir: SOURCE_DIR,
  };

  // Build initial dashboard
  const dashPath = buildDashboard(state, episodes);
  console.log(`\n📊 Dashboard: ${dashPath}`);

  // Process episodes sequentially
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];

    // Skip if already completed (resume mode)
    if (state.episodes[ep.id]?.status === 'completed') {
      console.log(`\n⏭️  ${ep.id} already completed, skipping`);
      continue;
    }

    // Budget check
    if (state.totalCost >= MAX_COST) {
      console.log(`\n🛑 Budget limit reached ($${state.totalCost.toFixed(2)} >= $${MAX_COST}). Stopping.`);
      break;
    }

    printProgress(state, episodes, i);

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  [${i + 1}/${episodes.length}] ${ep.id}: ${path.basename(ep.file)}`);
    console.log(`${'═'.repeat(60)}\n`);

    // Mark as running
    state.episodes[ep.id] = { status: 'running', startedAt: new Date().toISOString() };
    saveState(state);
    buildDashboard(state, episodes);

    // Run the analysis
    const result = await runEpisode(ep, SKIP_UPLOAD);

    // Update state
    state.episodes[ep.id] = {
      status: result.success ? 'completed' : 'failed',
      ...result,
      completedAt: new Date().toISOString(),
    };
    state.totalCost += result.cost;
    saveState(state);
    buildDashboard(state, episodes);

    if (result.success) {
      console.log(`\n✅ ${ep.id}: ${result.scenes} scenes, ${result.shots} shots ($${result.cost.toFixed(2)}, ${result.duration}s)`);
    } else {
      console.log(`\n❌ ${ep.id} failed (exit code ${result.exitCode})`);
      if (result.error) console.log(`   ${result.error.slice(0, 200)}`);
    }

    // Cooldown between episodes (rate limit management)
    if (i < episodes.length - 1) {
      const remaining = episodes.length - i - 1;
      const completedSoFar = Object.values(state.episodes).filter(e => e.status === 'completed').length;

      // Exponential backoff if we've had failures
      const failures = Object.values(state.episodes).filter(e => e.status === 'failed').length;
      const cooldown = COOLDOWN_SEC * (1 + failures * 0.5); // 50% more cooldown per failure

      console.log(`\n⏳ Cooldown ${cooldown.toFixed(0)}s before next episode (${remaining} remaining)...`);
      await new Promise(r => setTimeout(r, cooldown * 1000));
    }
  }

  // Final summary
  const completed = Object.values(state.episodes).filter(e => e.status === 'completed');
  const failed = Object.values(state.episodes).filter(e => e.status === 'failed');
  const totalScenes = completed.reduce((s, e) => s + (e.scenes || 0), 0);
  const totalShots = completed.reduce((s, e) => s + (e.shots || 0), 0);
  const totalTime = completed.reduce((s, e) => s + (e.duration || 0), 0);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Batch Analysis Complete`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ✅ Completed: ${completed.length}/${episodes.length}`);
  console.log(`  ❌ Failed: ${failed.length}`);
  console.log(`  📊 Total: ${totalScenes} scenes, ${totalShots} shots`);
  console.log(`  💰 Cost: $${state.totalCost.toFixed(2)}`);
  console.log(`  ⏱️  Time: ${(totalTime / 60).toFixed(1)} minutes`);
  console.log(`  📋 Dashboard: ${dashPath}`);

  if (failed.length > 0) {
    console.log(`\n  Failed episodes (rerun with --resume):`);
    for (const f of failed) {
      const ep = episodes.find(e => state.episodes[e.id] === f);
      console.log(`    ${ep?.id || '?'}: ${f.error?.slice(0, 80) || 'unknown error'}`);
    }
  }

  console.log();
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
