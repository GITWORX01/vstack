#!/usr/bin/env node
/**
 * Smart Supercut Builder
 *
 * Searches the metadata database for clips matching a query, ranks them,
 * orders them with smart pacing, and generates a Remotion composition.
 *
 * CLI:
 *   node supercut-builder.mjs "picard smiling" --limit 30 --min-duration 1.5 --max-duration 15 --output supercut-project-1
 *   node supercut-builder.mjs "worf being rude" --render
 *
 * API:
 *   import { searchForSupercut, createSupercutProject, generateRemotionComposition } from './supercut-builder.mjs';
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { semanticSearch, searchDialogue, getDb } from './db.mjs';

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
const SUPERCUTS_DIR = path.join(ANALYSIS_DIR, '_supercuts');

// ── CLI Arg Parsing ──────────────────────────────────────────────────

function parseCliArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0].startsWith('--')) {
    console.error('Usage: node supercut-builder.mjs "query" [--limit N] [--min-duration N] [--max-duration N] [--output NAME] [--render]');
    process.exit(1);
  }

  const query = args[0];
  const opts = {
    query,
    limit: 30,
    minDuration: 0,
    maxDuration: Infinity,
    output: null,
    render: false,
    maxPerEpisode: 5,
    maxPerScene: 2,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit' && args[i + 1]) { opts.limit = parseInt(args[++i]); }
    else if (arg === '--min-duration' && args[i + 1]) { opts.minDuration = parseFloat(args[++i]); }
    else if (arg === '--max-duration' && args[i + 1]) { opts.maxDuration = parseFloat(args[++i]); }
    else if (arg === '--output' && args[i + 1]) { opts.output = args[++i]; }
    else if (arg === '--render') { opts.render = true; }
    else if (arg === '--max-per-episode' && args[i + 1]) { opts.maxPerEpisode = parseInt(args[++i]); }
    else if (arg === '--max-per-scene' && args[i + 1]) { opts.maxPerScene = parseInt(args[++i]); }
  }

  // Default output name from query
  if (!opts.output) {
    opts.output = 'supercut-' + query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  }

  return opts;
}

// ── Search & Merge ──────────────────────────────────────────────────

/**
 * Search for clips matching a query using both visual and dialogue search.
 * Results are merged, deduplicated, and ranked.
 *
 * @param {string} query - Natural language search query
 * @param {object} options - Search options
 * @param {number} options.limit - Max clips to return (default 30)
 * @param {number} options.minDuration - Min clip duration in seconds (default 0)
 * @param {number} options.maxDuration - Max clip duration in seconds (default Infinity)
 * @param {number} options.maxPerEpisode - Max clips from one episode (default 5)
 * @param {number} options.maxPerScene - Max clips from one scene (default 2)
 * @returns {Array} Ranked array of clip objects
 */
export function searchForSupercut(query, options = {}) {
  const limit = options.limit || 30;
  const minDuration = options.minDuration || 0;
  const maxDuration = options.maxDuration || Infinity;
  const maxPerEpisode = options.maxPerEpisode ?? 5;
  const maxPerScene = options.maxPerScene ?? 2;

  // ── Step 1: Search visual metadata ──
  const visualHits = semanticSearch(query, {
    limit: limit * 4, // oversample for filtering
  });

  // ── Step 2: Search dialogue ──
  let dialogueHits = [];
  try {
    dialogueHits = searchDialogue(query, { limit: limit * 3 });
  } catch {
    // Dialogue search may fail on certain queries — non-fatal
  }

  // ── Step 3: Merge — build a map keyed by shot id ──
  const clipMap = new Map();

  for (const shot of visualHits) {
    clipMap.set(shot.id, {
      id: shot.id,
      episodeId: shot.episode_id,
      sceneNumber: shot.scene_number,
      shotNumber: shot.shot_number,
      startSec: shot.start_sec,
      endSec: shot.end_sec,
      duration: shot.duration_sec,
      shotType: shot.shot_type,
      subject: shot.subject,
      action: shot.action,
      expressions: shot.expressions,
      cameraMovement: shot.camera_movement,
      location: shot.location,
      mood: shot.mood,
      tags: shot.tags,
      supercutPotential: shot.supercut_potential,
      visualScore: shot._searchScore || Math.abs(shot.rank || 0),
      dialogueScore: 0,
      dialogueText: null,
      dialogueSpeaker: null,
      combinedScore: shot._searchScore || Math.abs(shot.rank || 0),
    });
  }

  // Boost shots that also have dialogue matches
  for (const line of dialogueHits) {
    // Find shot by matching episode + approximate timestamp
    const shotId = line.shot_id || findShotByTimestamp(line.episode_id, line.shot_start);
    if (!shotId) continue;

    if (clipMap.has(shotId)) {
      const clip = clipMap.get(shotId);
      clip.dialogueScore = Math.abs(line.rank || 0);
      clip.dialogueText = line.text;
      clip.dialogueSpeaker = line.speaker;
      // Boost combined score for visual+dialogue overlap
      clip.combinedScore += clip.dialogueScore * 1.5;
    } else {
      // Dialogue-only match — still include but at lower priority
      // We need to look up the shot data from the DB
      const shotData = getShotById(shotId);
      if (shotData) {
        clipMap.set(shotId, {
          id: shotId,
          episodeId: shotData.episode_id,
          sceneNumber: shotData.scene_number,
          shotNumber: shotData.shot_number,
          startSec: shotData.start_sec,
          endSec: shotData.end_sec,
          duration: shotData.duration_sec,
          shotType: shotData.shot_type,
          subject: shotData.subject,
          action: shotData.action,
          expressions: shotData.expressions,
          cameraMovement: shotData.camera_movement,
          location: line.location || null,
          mood: null,
          tags: shotData.tags,
          supercutPotential: shotData.supercut_potential,
          visualScore: 0,
          dialogueScore: Math.abs(line.rank || 0),
          dialogueText: line.text,
          dialogueSpeaker: line.speaker,
          combinedScore: Math.abs(line.rank || 0) * 0.8,
        });
      }
    }
  }

  // ── Step 4: Filter & Deduplicate ──
  let clips = [...clipMap.values()];

  // Duration filter
  if (minDuration > 0 || maxDuration < Infinity) {
    clips = clips.filter(c => c.duration >= minDuration && c.duration <= maxDuration);
  }

  // Deduplicate: within same episode, clips within 5 seconds = same moment
  clips.sort((a, b) => b.combinedScore - a.combinedScore);
  const deduped = [];
  for (const clip of clips) {
    const isDupe = deduped.some(d =>
      d.episodeId === clip.episodeId &&
      Math.abs(d.startSec - clip.startSec) < 5
    );
    if (!isDupe) deduped.push(clip);
  }
  clips = deduped;

  // ── Step 5: Per-episode and per-scene caps ──
  const episodeCounts = {};
  const sceneCounts = {};
  const capped = [];

  for (const clip of clips) {
    const epKey = clip.episodeId;
    const sceneKey = `${clip.episodeId}:${clip.sceneNumber}`;

    episodeCounts[epKey] = (episodeCounts[epKey] || 0);
    sceneCounts[sceneKey] = (sceneCounts[sceneKey] || 0);

    if (episodeCounts[epKey] >= maxPerEpisode) continue;
    if (sceneCounts[sceneKey] >= maxPerScene) continue;

    episodeCounts[epKey]++;
    sceneCounts[sceneKey]++;
    capped.push(clip);
  }
  clips = capped;

  // ── Step 6: Prefer shot type variety ──
  // If we have more clips than needed, prefer a mix of shot types
  if (clips.length > limit) {
    clips = selectWithVariety(clips, limit);
  } else {
    clips = clips.slice(0, limit);
  }

  return clips;
}

/**
 * Select clips ensuring shot type variety.
 * Takes top clips but ensures a mix of close-up, medium, wide, etc.
 */
function selectWithVariety(clips, limit) {
  const buckets = {};
  for (const clip of clips) {
    const type = clip.shotType || 'unknown';
    if (!buckets[type]) buckets[type] = [];
    buckets[type].push(clip);
  }

  const selected = [];
  const types = Object.keys(buckets);

  // Round-robin through types, picking top-scored from each
  let round = 0;
  while (selected.length < limit) {
    let addedThisRound = false;
    for (const type of types) {
      if (selected.length >= limit) break;
      if (round < buckets[type].length) {
        selected.push(buckets[type][round]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
    round++;
  }

  // Re-sort by combined score (pacing will reorder later)
  selected.sort((a, b) => b.combinedScore - a.combinedScore);
  return selected;
}

// ── Helper: find shot by episode + timestamp ─────────────────────────

function findShotByTimestamp(episodeId, startSec) {
  if (!episodeId || startSec == null) return null;
  try {
    const db = getDb();
    const shot = db.prepare(
      'SELECT id FROM shots WHERE episode_id = ? AND start_sec <= ? AND end_sec >= ? LIMIT 1'
    ).get(episodeId, startSec + 0.5, startSec - 0.5);
    return shot?.id || null;
  } catch {
    return null;
  }
}

function getShotById(shotId) {
  if (!shotId) return null;
  try {
    const db = getDb();
    return db.prepare(`
      SELECT s.*, sc.location, sc.mood
      FROM shots s
      JOIN scenes sc ON s.scene_id = sc.id
      WHERE s.id = ?
    `).get(shotId);
  } catch {
    return null;
  }
}

// ── Smart Pacing Algorithm ──────────────────────────────────────────

/**
 * Reorder clips for optimal viewing experience.
 *
 * Rules:
 * - Open with a strong clip (high relevance, close-up preferred)
 * - Alternate short punchy clips (2-3s) and longer moments (4-6s)
 * - Build intensity toward the end
 * - Final clip = absolute best match
 * - Insert "breather" clips (wider shots, establishing) every 5-7 clips
 * - Avoid adjacent clips from the same episode
 */
function applySmartPacing(clips) {
  if (clips.length <= 2) return clips;

  // Separate clips into categories
  const bestClip = clips[0]; // highest combined score = finale
  const remaining = clips.slice(1);

  // Find a good opener: high score + close-up preferred
  let openerIdx = 0;
  for (let i = 0; i < remaining.length; i++) {
    const c = remaining[i];
    const isCloseup = c.shotType === 'close-up' || c.shotType === 'extreme-close-up';
    if (isCloseup && c.combinedScore >= remaining[openerIdx].combinedScore * 0.7) {
      openerIdx = i;
      break;
    }
  }
  const opener = remaining.splice(openerIdx, 1)[0];

  // Classify remaining clips
  const shortClips = []; // 0-3s
  const mediumClips = []; // 3-6s
  const longClips = []; // 6s+
  const breatherClips = []; // wide/establishing shots

  for (const clip of remaining) {
    const isBreather = clip.shotType === 'wide' || clip.shotType === 'establishing' ||
                       clip.shotType === 'est';
    if (isBreather) {
      breatherClips.push(clip);
    } else if (clip.duration <= 3) {
      shortClips.push(clip);
    } else if (clip.duration <= 6) {
      mediumClips.push(clip);
    } else {
      longClips.push(clip);
    }
  }

  // Build the sequence
  const ordered = [opener];
  const pools = { short: shortClips, medium: mediumClips, long: longClips };

  // Pattern: alternate short/medium, insert breather every 5-7 clips
  const pattern = ['short', 'medium', 'short', 'medium', 'short', 'breather'];
  let patternIdx = 0;
  let clipsSinceBreather = 0;

  const allRemaining = [...shortClips, ...mediumClips, ...longClips, ...breatherClips];
  const used = new Set();

  while (ordered.length < clips.length - 1) { // reserve last slot for bestClip
    const targetType = pattern[patternIdx % pattern.length];
    patternIdx++;

    let picked = null;

    if (targetType === 'breather' && breatherClips.length > 0) {
      // Pick a breather not yet used
      picked = pickFromPool(breatherClips, ordered, used);
      clipsSinceBreather = 0;
    }

    if (!picked) {
      // Pick from the target pool
      const pool = pools[targetType] || pools.medium;
      picked = pickFromPool(pool, ordered, used);
    }

    if (!picked) {
      // Fall back: pick from any pool
      for (const poolName of ['medium', 'short', 'long']) {
        picked = pickFromPool(pools[poolName], ordered, used);
        if (picked) break;
      }
    }

    if (!picked) {
      // Fall back: pick from breathers
      picked = pickFromPool(breatherClips, ordered, used);
    }

    if (!picked) {
      // Exhausted all pools — pick any unused clip
      for (const clip of allRemaining) {
        if (!used.has(clip.id)) {
          picked = clip;
          used.add(clip.id);
          break;
        }
      }
    }

    if (!picked) break; // truly exhausted

    ordered.push(picked);
    clipsSinceBreather++;
  }

  // Finale: absolute best match as the last clip
  ordered.push(bestClip);

  return ordered;
}

/**
 * Pick the best clip from a pool, avoiding adjacent same-episode clips.
 */
function pickFromPool(pool, ordered, used) {
  const lastEpisode = ordered.length > 0 ? ordered[ordered.length - 1].episodeId : null;

  // Prefer clip from a different episode than the last one
  for (let i = 0; i < pool.length; i++) {
    if (!used.has(pool[i].id) && pool[i].episodeId !== lastEpisode) {
      const picked = pool[i];
      used.add(picked.id);
      return picked;
    }
  }

  // Fall back: same episode is okay
  for (let i = 0; i < pool.length; i++) {
    if (!used.has(pool[i].id)) {
      const picked = pool[i];
      used.add(picked.id);
      return picked;
    }
  }

  return null;
}

// ── Project Management ──────────────────────────────────────────────

/**
 * Create a supercut project directory with config and clip data.
 *
 * @param {string} name - Project name (directory name)
 * @param {string} query - The search query used
 * @param {Array} clips - Ordered array of clip objects from searchForSupercut
 * @param {object} options - Original search options
 * @returns {string} Path to the project directory
 */
export function createSupercutProject(name, query, clips, options = {}) {
  const projectDir = path.join(SUPERCUTS_DIR, name);
  fs.mkdirSync(projectDir, { recursive: true });

  // Resolve video file paths for each episode
  const episodeFiles = resolveVideoFiles(clips);

  // Save supercut config
  const config = {
    name,
    query,
    createdAt: new Date().toISOString(),
    clipCount: clips.length,
    totalDuration: clips.reduce((sum, c) => sum + c.duration, 0),
    settings: {
      limit: options.limit || 30,
      minDuration: options.minDuration || 0,
      maxDuration: options.maxDuration || Infinity,
      maxPerEpisode: options.maxPerEpisode ?? 5,
      maxPerScene: options.maxPerScene ?? 2,
    },
    episodeFiles,
  };

  fs.writeFileSync(
    path.join(projectDir, 'supercut-config.json'),
    JSON.stringify(config, null, 2)
  );

  // Save ordered clips with full metadata
  const clipsData = clips.map((clip, index) => ({
    index,
    id: clip.id,
    episodeId: clip.episodeId,
    sceneNumber: clip.sceneNumber,
    shotNumber: clip.shotNumber,
    startSec: clip.startSec,
    endSec: clip.endSec,
    duration: clip.duration,
    shotType: clip.shotType,
    subject: clip.subject,
    action: clip.action,
    expressions: clip.expressions,
    cameraMovement: clip.cameraMovement,
    location: clip.location,
    mood: clip.mood,
    dialogueText: clip.dialogueText,
    dialogueSpeaker: clip.dialogueSpeaker,
    combinedScore: clip.combinedScore,
    visualScore: clip.visualScore,
    dialogueScore: clip.dialogueScore,
    videoFile: episodeFiles[clip.episodeId] || null,
  }));

  fs.writeFileSync(
    path.join(projectDir, 'clips.json'),
    JSON.stringify(clipsData, null, 2)
  );

  console.log(`\n  Project saved to: ${projectDir}`);
  console.log(`  ${clips.length} clips | ${config.totalDuration.toFixed(1)}s total duration`);

  return projectDir;
}

// ── Remotion Composition Generation ─────────────────────────────────

/**
 * Generate Remotion-compatible files from a saved supercut project.
 *
 * Creates:
 *   - scenes.ts — SceneGroup[] array
 *   - narrationData.json — timing segments (empty text, duration from clips)
 *   - project.config.json — video file mappings
 *
 * @param {string} projectName - Name of the project directory
 * @returns {object} Paths to generated files
 */
export function generateRemotionComposition(projectName) {
  const projectDir = path.join(SUPERCUTS_DIR, projectName);

  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project not found: ${projectDir}`);
  }

  const config = JSON.parse(fs.readFileSync(path.join(projectDir, 'supercut-config.json'), 'utf-8'));
  const clips = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips.json'), 'utf-8'));

  if (clips.length === 0) {
    throw new Error('No clips in project');
  }

  // ── scenes.ts ──
  const episodeFiles = config.episodeFiles || {};

  // Build unique source file map: episodeId -> staticFile path
  const sourceMap = {};
  for (const [epId, filePath] of Object.entries(episodeFiles)) {
    const basename = path.basename(filePath);
    sourceMap[epId] = `staticFile('movies/${basename}')`;
  }

  // Generate SceneGroup entries
  const sceneEntries = clips.map((clip, i) => {
    const src = sourceMap[clip.episodeId] || `staticFile('movies/${clip.episodeId}.mp4')`;
    const durationOverride = clip.duration > 0 ? clip.duration : undefined;
    let entry = `  { range: [${i}, ${i}], src: ${src}, startSec: ${clip.startSec}`;
    if (durationOverride) {
      entry += `, durationOverride: ${parseFloat(durationOverride.toFixed(2))}`;
    }
    entry += ' }';
    return entry;
  });

  // Build source constants
  const sourceConstants = Object.entries(sourceMap)
    .map(([epId, sfCall]) => `const ${sanitizeVarName(epId)} = ${sfCall};`)
    .join('\n');

  const scenesTs = `// Auto-generated by supercut-builder.mjs
// Query: "${config.query}"
// Generated: ${new Date().toISOString()}

import { staticFile } from 'remotion';

export interface SceneGroup {
  range: [number, number];
  src: string;
  startSec: number;
  startSecOffset?: number;
  chapter?: string;
  image?: string;
  video?: string;
  videoStartSec?: number;
  narrationTrimStart?: number;
  narrationTrimEnd?: number;
  durationOverride?: number;
}

export interface Interstitial {
  position: number;
  duration: number;
  src?: string;
  startSec?: number;
  video?: string;
  keepMusic?: boolean;
  audioSrc?: string;
  volume?: number;
  audioBoost?: number;
  label?: string;
}

${sourceConstants}

export const SCENES: SceneGroup[] = [
${sceneEntries.join(',\n')}
];

export const INTERSTITIALS: Interstitial[] = [];
`;

  fs.writeFileSync(path.join(projectDir, 'scenes.ts'), scenesTs);

  // ── narrationData.json ──
  // Each clip becomes one segment with empty text and proper timing
  let currentTime = 0;
  const narrationSegments = clips.map((clip, i) => {
    const segment = {
      index: i,
      text: '',
      startTime: currentTime,
      endTime: currentTime + clip.duration,
      fileDuration: clip.duration,
    };
    currentTime += clip.duration;
    return segment;
  });

  const narrationData = {
    segments: narrationSegments,
    totalDurationSeconds: currentTime,
  };

  fs.writeFileSync(
    path.join(projectDir, 'narrationData.json'),
    JSON.stringify(narrationData, null, 2)
  );

  // ── project.config.json ──
  const movieFiles = {};
  for (const [epId, filePath] of Object.entries(episodeFiles)) {
    const basename = path.basename(filePath);
    movieFiles[basename] = filePath;
  }

  const projectConfig = {
    name: config.name,
    type: 'supercut',
    query: config.query,
    fps: 30,
    width: 1920,
    height: 1080,
    movieFiles,
    totalDuration: currentTime,
    clipCount: clips.length,
  };

  fs.writeFileSync(
    path.join(projectDir, 'project.config.json'),
    JSON.stringify(projectConfig, null, 2)
  );

  console.log(`\n  Remotion composition generated in: ${projectDir}`);
  console.log(`  - scenes.ts (${clips.length} SceneGroups)`);
  console.log(`  - narrationData.json (${narrationSegments.length} segments)`);
  console.log(`  - project.config.json`);
  console.log(`  Total duration: ${currentTime.toFixed(1)}s`);

  return {
    scenesPath: path.join(projectDir, 'scenes.ts'),
    narrationPath: path.join(projectDir, 'narrationData.json'),
    configPath: path.join(projectDir, 'project.config.json'),
    totalDuration: currentTime,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve video file paths for all episodes represented in the clip list.
 */
function resolveVideoFiles(clips) {
  const episodeIds = [...new Set(clips.map(c => c.episodeId))];
  const fileMap = {};

  let mediaFiles = [];
  try {
    mediaFiles = fs.readdirSync(MEDIA_DIR);
  } catch {
    console.warn(`  Warning: Could not read MEDIA_DIR: ${MEDIA_DIR}`);
  }

  for (const epId of episodeIds) {
    const match = epId.match(/S(\d+)E(\d+)/i);
    if (!match) {
      fileMap[epId] = null;
      continue;
    }

    const found = mediaFiles.find(f =>
      new RegExp('s0?' + match[1] + 'e0?' + match[2], 'i').test(f) && f.endsWith('.mp4')
    );

    fileMap[epId] = found ? path.join(MEDIA_DIR, found) : null;
  }

  return fileMap;
}

/**
 * Sanitize an episode ID into a valid JS variable name.
 */
function sanitizeVarName(epId) {
  return epId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
}

/**
 * Format seconds as MM:SS.s
 */
function fmtTs(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

// ── CLI Output ──────────────────────────────────────────────────────

function printResults(query, clips, options) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  Supercut Builder — "${query}"`);
  console.log(`  ${clips.length} clips selected | Settings: limit=${options.limit}, per-episode=${options.maxPerEpisode}, per-scene=${options.maxPerScene}`);
  if (options.minDuration > 0) console.log(`  Duration filter: ${options.minDuration}s - ${options.maxDuration === Infinity ? 'unlimited' : options.maxDuration + 's'}`);
  console.log(`${'='.repeat(70)}\n`);

  // Episode distribution
  const epCounts = {};
  for (const clip of clips) {
    epCounts[clip.episodeId] = (epCounts[clip.episodeId] || 0) + 1;
  }
  console.log('  Episode distribution:');
  for (const [ep, count] of Object.entries(epCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${ep}: ${count} clips`);
  }

  // Shot type distribution
  const typeCounts = {};
  for (const clip of clips) {
    const t = clip.shotType || 'unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  console.log('\n  Shot types:');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type}: ${count}`);
  }

  const totalDuration = clips.reduce((s, c) => s + c.duration, 0);
  console.log(`\n  Total duration: ${totalDuration.toFixed(1)}s (${(totalDuration / 60).toFixed(1)}min)\n`);

  // Clip list
  console.log('  # | Episode  | Time       | Dur  | Type     | Subject/Action');
  console.log('  ' + '-'.repeat(78));

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const num = String(i + 1).padStart(2);
    const ep = c.episodeId.padEnd(8);
    const time = `${fmtTs(c.startSec)}-${fmtTs(c.endSec)}`;
    const dur = c.duration.toFixed(1).padStart(4) + 's';
    const type = (c.shotType || '?').padEnd(8);
    const desc = (c.subject || '') + (c.action ? ' — ' + c.action : '');
    const truncDesc = desc.length > 50 ? desc.slice(0, 47) + '...' : desc;

    let line = `  ${num} | ${ep} | ${time} | ${dur} | ${type} | ${truncDesc}`;

    if (c.dialogueText) {
      line += `\n       Dialogue (${c.dialogueSpeaker || '?'}): "${c.dialogueText.slice(0, 60)}"`;
    }

    const scoreInfo = [];
    if (c.visualScore > 0) scoreInfo.push(`vis:${c.visualScore.toFixed(1)}`);
    if (c.dialogueScore > 0) scoreInfo.push(`dlg:${c.dialogueScore.toFixed(1)}`);
    if (scoreInfo.length > 0) {
      line += `\n       Score: ${c.combinedScore.toFixed(1)} (${scoreInfo.join(', ')})`;
    }

    console.log(line);
  }

  console.log('');
}

// ── Main (CLI) ──────────────────────────────────────────────────────

async function main() {
  const opts = parseCliArgs();

  console.log(`\n  Searching for: "${opts.query}"`);
  console.log(`  Limit: ${opts.limit} | Min duration: ${opts.minDuration}s | Max duration: ${opts.maxDuration === Infinity ? 'unlimited' : opts.maxDuration + 's'}`);

  // Search and rank
  const rawClips = searchForSupercut(opts.query, {
    limit: opts.limit,
    minDuration: opts.minDuration,
    maxDuration: opts.maxDuration,
    maxPerEpisode: opts.maxPerEpisode,
    maxPerScene: opts.maxPerScene,
  });

  if (rawClips.length === 0) {
    console.error('\n  No clips found matching query. Try broader search terms.\n');
    process.exit(1);
  }

  // Apply smart pacing
  const orderedClips = applySmartPacing(rawClips);

  // Print results
  printResults(opts.query, orderedClips, opts);

  // Save project
  const projectDir = createSupercutProject(opts.output, opts.query, orderedClips, opts);

  // Generate Remotion composition if requested
  if (opts.render) {
    generateRemotionComposition(opts.output);
  }

  console.log(`  Done.\n`);
}

// ── DaVinci Resolve XML Export ───────────────────────────────────────

/**
 * Generate a DaVinci Resolve compatible FCP XML timeline.
 * Uses FCPXML version 1.9 for maximum compatibility.
 */
export function generateDaVinciXML(projectName) {
  const projectDir = path.join(ANALYSIS_DIR, '_supercuts', projectName);
  const clipsPath = path.join(projectDir, 'clips.json');
  const configPath = path.join(projectDir, 'supercut-config.json');

  if (!fs.existsSync(clipsPath)) {
    throw new Error(`No clips.json found for project "${projectName}"`);
  }

  const clips = JSON.parse(fs.readFileSync(clipsPath, 'utf-8'));
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    : { query: projectName };

  // Resolve video file paths
  const episodeFiles = resolveVideoFiles(clips);

  // Build unique asset list (one per source video file)
  const assets = {};
  let assetId = 2; // r1 is reserved for format
  for (const clip of clips) {
    const filePath = episodeFiles[clip.episodeId];
    if (!filePath || assets[filePath]) continue;
    assets[filePath] = {
      id: `r${assetId++}`,
      name: path.basename(filePath, path.extname(filePath)),
      filePath: filePath,
    };
  }

  // Timeline settings
  const fps = 30;
  const width = 1920;
  const height = 1080;
  const frameDuration = `${100}/${fps * 100}s`; // "100/3000s" for 30fps

  // Convert seconds to FCP XML rational time format
  function toTime(seconds) {
    // Use 30000/1001 timebase for 29.97fps compatibility, or simple fraction for 30fps
    const frames = Math.round(seconds * fps);
    return `${frames * 100}/${fps * 100}s`;
  }

  // Build asset-clip elements
  let timelineOffset = 0;
  const assetClipElements = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const filePath = episodeFiles[clip.episodeId];
    if (!filePath || !assets[filePath]) continue;

    const asset = assets[filePath];
    const startSec = clip.startSec || 0;
    const duration = clip.duration || (clip.endSec - clip.startSec) || 3;
    const clipName = `${clip.episodeId} — ${(clip.subject || 'Shot ' + (i + 1)).slice(0, 40)}`;

    assetClipElements.push(
      `                <asset-clip ref="${asset.id}" offset="${toTime(timelineOffset)}" name="${escapeXml(clipName)}" ` +
      `start="${toTime(startSec)}" duration="${toTime(duration)}" ` +
      `tcFormat="NDF" audioRole="dialogue"/>`
    );

    timelineOffset += duration;
  }

  const totalDuration = toTime(timelineOffset);

  // Build asset elements
  const assetElements = Object.values(assets).map(asset => {
    const fileUrl = 'file:///' + asset.filePath.replace(/\\/g, '/').replace(/ /g, '%20');
    return `        <asset id="${asset.id}" name="${escapeXml(asset.name)}" uid="${asset.id}" ` +
      `start="0s" duration="0s" hasVideo="1" format="r1" hasAudio="1" ` +
      `audioChannels="2" audioRate="48000">\n` +
      `            <media-rep kind="original-media" sig="${asset.id}" src="${fileUrl}"/>\n` +
      `        </asset>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>

<fcpxml version="1.9">
    <resources>
        <format id="r1" name="FFVideoFormat${height}p${fps}" frameDuration="${frameDuration}" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>
${assetElements.join('\n')}
    </resources>

    <library>
        <event name="${escapeXml(config.query || projectName)}">
            <project name="${escapeXml(projectName)}" uid="${projectName}" modDate="${new Date().toISOString().replace('T', ' ').slice(0, 19)} +0000">
                <sequence format="r1" duration="${totalDuration}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
                    <spine>
${assetClipElements.join('\n')}
                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>`;

  const xmlPath = path.join(projectDir, `${projectName}.fcpxml`);
  fs.writeFileSync(xmlPath, xml, 'utf-8');

  console.log(`  DaVinci Resolve XML exported: ${xmlPath}`);
  console.log(`  ${clips.length} clips, ${timelineOffset.toFixed(1)}s total`);

  return { xmlPath, clipCount: clips.length, totalDuration: timelineOffset };
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Run CLI if invoked directly
const isMainModule = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch(err => {
    console.error(`\n  Error: ${err.message}\n`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
