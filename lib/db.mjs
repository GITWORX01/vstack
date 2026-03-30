#!/usr/bin/env node
/**
 * Video Metadata Database (SQLite)
 *
 * Single-file database for all video metadata. Source of truth for the AI
 * clip selector. Auto-built from per-episode scenes.json files.
 *
 * Usage:
 *   import { getDb, rebuildEpisode, search, verifyIntegrity } from './db.mjs';
 *
 * CLI:
 *   node db.mjs --rebuild                    # Rebuild from all scenes.json
 *   node db.mjs --rebuild S02E01             # Rebuild single episode
 *   node db.mjs --search "picard smiling"    # Search shots
 *   node db.mjs --verify                     # Check DB vs JSON integrity
 *   node db.mjs --stats                      # Show database stats
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'gemini-analysis', 'vstack.db');
const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');

// ── Schema ───────────────────────────────────────────────────────────

const SCHEMA = `
-- Series/show (for multi-show support)
CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Episodes
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,                    -- e.g. "S02E01"
  series_id TEXT DEFAULT 'default',
  title TEXT,
  filename TEXT,
  duration_sec REAL,
  scene_count INTEGER DEFAULT 0,
  shot_count INTEGER DEFAULT 0,
  analyzed_at TEXT,
  analysis_cost REAL DEFAULT 0,
  json_hash TEXT,                         -- MD5 of scenes.json for change detection
  custom_thumbnail TEXT,                  -- User-selected thumbnail path (overrides auto-detect)
  FOREIGN KEY (series_id) REFERENCES series(id)
);

-- Scenes
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id TEXT NOT NULL,
  scene_number INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  location TEXT,
  characters TEXT,                        -- JSON array
  mood TEXT,
  plot_significance TEXT,
  lighting TEXT,
  music TEXT,
  tags TEXT,                              -- JSON array
  supercut_potential TEXT,                 -- JSON array
  FOREIGN KEY (episode_id) REFERENCES episodes(id),
  UNIQUE(episode_id, scene_number)
);

-- Shots (the core searchable unit)
CREATE TABLE IF NOT EXISTS shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id TEXT NOT NULL,
  scene_id INTEGER NOT NULL,
  scene_number INTEGER NOT NULL,
  shot_number INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  duration_sec REAL GENERATED ALWAYS AS (end_sec - start_sec) STORED,
  shot_type TEXT,                         -- wide, medium, close-up, etc.
  subject TEXT,                           -- who/what camera is focused on
  action TEXT,                            -- what happens
  expressions TEXT,                       -- JSON object { "Character": "expression" }
  camera_movement TEXT,                   -- static, pan, tilt, etc.
  tags TEXT,                              -- JSON array
  supercut_potential TEXT,                 -- JSON array
  FOREIGN KEY (episode_id) REFERENCES episodes(id),
  FOREIGN KEY (scene_id) REFERENCES scenes(id),
  UNIQUE(episode_id, scene_number, shot_number)
);

-- Dialogue lines (one per spoken line, linked to shots)
CREATE TABLE IF NOT EXISTS dialogue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id TEXT NOT NULL,
  shot_id INTEGER,
  scene_id INTEGER NOT NULL,
  speaker TEXT,
  text TEXT NOT NULL,
  start_sec REAL,
  end_sec REAL,
  FOREIGN KEY (episode_id) REFERENCES episodes(id),
  FOREIGN KEY (shot_id) REFERENCES shots(id),
  FOREIGN KEY (scene_id) REFERENCES scenes(id)
);

-- Full-text search index on shots
CREATE VIRTUAL TABLE IF NOT EXISTS shots_fts USING fts5(
  subject, action, tags, supercut_potential, expressions,
  content='shots',
  content_rowid='id'
);

-- Full-text search index on dialogue
CREATE VIRTUAL TABLE IF NOT EXISTS dialogue_fts USING fts5(
  speaker, text,
  content='dialogue',
  content_rowid='id'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS shots_ai AFTER INSERT ON shots BEGIN
  INSERT INTO shots_fts(rowid, subject, action, tags, supercut_potential, expressions)
  VALUES (new.id, new.subject, new.action, new.tags, new.supercut_potential, new.expressions);
END;

CREATE TRIGGER IF NOT EXISTS shots_ad AFTER DELETE ON shots BEGIN
  INSERT INTO shots_fts(shots_fts, rowid, subject, action, tags, supercut_potential, expressions)
  VALUES ('delete', old.id, old.subject, old.action, old.tags, old.supercut_potential, old.expressions);
END;

CREATE TRIGGER IF NOT EXISTS dialogue_ai AFTER INSERT ON dialogue BEGIN
  INSERT INTO dialogue_fts(rowid, speaker, text)
  VALUES (new.id, new.speaker, new.text);
END;

CREATE TRIGGER IF NOT EXISTS dialogue_ad AFTER DELETE ON dialogue BEGIN
  INSERT INTO dialogue_fts(dialogue_fts, rowid, speaker, text)
  VALUES ('delete', old.id, old.speaker, old.text);
END;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_shots_episode ON shots(episode_id);
CREATE INDEX IF NOT EXISTS idx_shots_type ON shots(shot_type);
CREATE INDEX IF NOT EXISTS idx_shots_subject ON shots(subject);
CREATE INDEX IF NOT EXISTS idx_scenes_episode ON scenes(episode_id);
CREATE INDEX IF NOT EXISTS idx_scenes_location ON scenes(location);
CREATE INDEX IF NOT EXISTS idx_dialogue_speaker ON dialogue(speaker);
CREATE INDEX IF NOT EXISTS idx_dialogue_episode ON dialogue(episode_id);
`;

// ── Database Access ──────────────────────────────────────────────────

let _db = null;

export function getDb() {
  if (!_db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.exec(SCHEMA);

    // Ensure default series exists
    _db.prepare('INSERT OR IGNORE INTO series (id, title) VALUES (?, ?)').run('default', 'Default Series');
  }
  return _db;
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

// ── Timestamp Parsing ────────────────────────────────────────────────

function parseTs(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const [m, s] = ts.split(':');
  if (!s) return 0;
  return parseInt(m) * 60 + parseFloat(s);
}

import crypto from 'crypto';

function hashJson(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

// ── Rebuild Episode ──────────────────────────────────────────────────

export function rebuildEpisode(episodeId, scenesJsonPath, metadata = {}) {
  // metadata: { title, filename, duration }
  const db = getDb();

  if (!fs.existsSync(scenesJsonPath)) {
    console.log(`  ⚠️  ${scenesJsonPath} not found`);
    return false;
  }

  const rawJson = fs.readFileSync(scenesJsonPath, 'utf-8');
  const scenes = JSON.parse(rawJson);

  // Check if already up to date
  const existing = db.prepare('SELECT json_hash FROM episodes WHERE id = ?').get(episodeId);
  const newHash = crypto.createHash('md5').update(rawJson).digest('hex');
  if (existing?.json_hash === newHash) {
    return false; // no changes
  }

  // Transaction: delete old data, insert new
  const rebuild = db.transaction(() => {
    // Delete old data for this episode
    db.prepare('DELETE FROM dialogue WHERE episode_id = ?').run(episodeId);
    db.prepare('DELETE FROM shots WHERE episode_id = ?').run(episodeId);
    db.prepare('DELETE FROM scenes WHERE episode_id = ?').run(episodeId);

    // Ensure episode record exists before inserting scenes (FK constraint)
    db.prepare('INSERT OR IGNORE INTO episodes (id) VALUES (?)').run(episodeId);

    let totalShots = 0;
    let totalDialogue = 0;

    // Insert scenes
    const insertScene = db.prepare(`
      INSERT INTO scenes (episode_id, scene_number, start_sec, end_sec, location, characters, mood, plot_significance, lighting, music, tags, supercut_potential)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertShot = db.prepare(`
      INSERT INTO shots (episode_id, scene_id, scene_number, shot_number, start_sec, end_sec, shot_type, subject, action, expressions, camera_movement, tags, supercut_potential)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertDialogue = db.prepare(`
      INSERT INTO dialogue (episode_id, shot_id, scene_id, speaker, text, start_sec, end_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const scene of scenes) {
      const startSec = parseTs(scene.startTimestamp);
      const endSec = parseTs(scene.endTimestamp);

      const sceneResult = insertScene.run(
        episodeId,
        scene.sceneNumber,
        startSec,
        endSec,
        scene.location || null,
        JSON.stringify(scene.characters || []),
        scene.mood || null,
        scene.plotSignificance || null,
        scene.lighting || null,
        scene.music || null,
        JSON.stringify(scene.tags || []),
        JSON.stringify(scene.supercutPotential || [])
      );
      const sceneId = sceneResult.lastInsertRowid;

      // Insert scene-level dialogue (not assigned to shots)
      for (const line of (scene.dialogue || [])) {
        insertDialogue.run(
          episodeId, null, sceneId,
          line.speaker || null,
          line.text || '',
          parseTs(line.start),
          parseTs(line.end)
        );
        totalDialogue++;
      }

      // Insert shots
      for (const shot of (scene.shots || [])) {
        const shotStart = parseTs(shot.startTimestamp);
        const shotEnd = parseTs(shot.endTimestamp);

        const shotResult = insertShot.run(
          episodeId,
          sceneId,
          scene.sceneNumber,
          shot.shotNumber,
          shotStart,
          shotEnd,
          shot.shotType || null,
          shot.subject || null,
          shot.action || null,
          JSON.stringify(shot.characterExpressions || shot.expressions || {}),
          shot.cameraMovement || null,
          JSON.stringify(shot.tags || []),
          JSON.stringify(shot.supercutPotential || [])
        );
        const shotId = shotResult.lastInsertRowid;
        totalShots++;

        // Insert shot-level dialogue
        for (const line of (shot.dialogue || [])) {
          insertDialogue.run(
            episodeId, shotId, sceneId,
            line.speaker || null,
            line.text || '',
            parseTs(line.start),
            parseTs(line.end)
          );
          totalDialogue++;
        }
      }
    }

    // Upsert episode record with metadata
    db.prepare(`
      INSERT INTO episodes (id, title, filename, duration_sec, scene_count, shot_count, analyzed_at, json_hash)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(id) DO UPDATE SET
        title = COALESCE(excluded.title, title),
        filename = COALESCE(excluded.filename, filename),
        duration_sec = COALESCE(excluded.duration_sec, duration_sec),
        scene_count = excluded.scene_count,
        shot_count = excluded.shot_count,
        analyzed_at = excluded.analyzed_at,
        json_hash = excluded.json_hash
    `).run(episodeId, metadata.title || null, metadata.filename || null, metadata.duration || null, scenes.length, totalShots, newHash);

    return { scenes: scenes.length, shots: totalShots, dialogue: totalDialogue };
  });

  const result = rebuild();
  return result;
}

// ── Rebuild All ──────────────────────────────────────────────────────

export function rebuildAll() {
  const dirs = fs.readdirSync(ANALYSIS_DIR).filter(d => {
    const scenesPath = path.join(ANALYSIS_DIR, d, 'scenes.json');
    return fs.existsSync(scenesPath);
  });

  console.log(`\n🔨 Rebuilding database from ${dirs.length} episodes...`);
  let updated = 0;

  for (const dir of dirs.sort()) {
    const scenesPath = path.join(ANALYSIS_DIR, dir, 'scenes.json');
    const result = rebuildEpisode(dir, scenesPath);
    if (result) {
      console.log(`  ✅ ${dir}: ${result.scenes} scenes, ${result.shots} shots, ${result.dialogue} dialogue lines`);
      updated++;
    } else {
      console.log(`  ⏭️  ${dir}: up to date`);
    }
  }

  console.log(`\n  Updated: ${updated}/${dirs.length} episodes`);
  return updated;
}

// ── Search ───────────────────────────────────────────────────────────

export function search(query, options = {}) {
  const db = getDb();
  const limit = options.limit || 50;
  const episodeFilter = options.episode || null;
  const shotType = options.shotType || null;
  const character = options.character || null;
  const minDuration = options.minDuration || 0;
  const maxDuration = options.maxDuration || 9999;

  // Full-text search on shots
  let sql = `
    SELECT
      s.id, s.episode_id, s.scene_number, s.shot_number,
      s.start_sec, s.end_sec, s.duration_sec,
      s.shot_type, s.subject, s.action,
      s.expressions, s.camera_movement, s.tags, s.supercut_potential,
      sc.location, sc.mood, sc.characters AS scene_characters,
      rank
    FROM shots_fts fts
    JOIN shots s ON s.id = fts.rowid
    JOIN scenes sc ON s.scene_id = sc.id
    WHERE shots_fts MATCH ?
  `;
  const params = [query];

  if (episodeFilter) { sql += ' AND s.episode_id = ?'; params.push(episodeFilter); }
  if (shotType) { sql += ' AND s.shot_type = ?'; params.push(shotType); }
  if (character) { sql += ' AND s.subject LIKE ?'; params.push(`%${character}%`); }
  if (minDuration > 0) { sql += ' AND s.duration_sec >= ?'; params.push(minDuration); }
  if (maxDuration < 9999) { sql += ' AND s.duration_sec <= ?'; params.push(maxDuration); }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

// ── Search Dialogue ──────────────────────────────────────────────────

export function searchDialogue(query, options = {}) {
  const db = getDb();
  const limit = options.limit || 50;
  const speaker = options.speaker || null;

  let sql = `
    SELECT
      d.id, d.episode_id, d.speaker, d.text, d.start_sec, d.end_sec,
      s.shot_number, s.shot_type, s.subject, s.action, s.start_sec AS shot_start, s.end_sec AS shot_end,
      sc.scene_number, sc.location,
      rank
    FROM dialogue_fts fts
    JOIN dialogue d ON d.id = fts.rowid
    LEFT JOIN shots s ON d.shot_id = s.id
    JOIN scenes sc ON d.scene_id = sc.id
    WHERE dialogue_fts MATCH ?
  `;
  const params = [query];

  if (speaker) { sql += ' AND d.speaker LIKE ?'; params.push(`%${speaker}%`); }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

// ── Semantic Search (AI-expanded) ─────────────────────────────────────
// Takes a natural language intent and expands it into weighted synonym groups.
// Runs multiple FTS5 queries, scores results by how many groups they match,
// and returns a deduplicated, ranked list.
//
// Usage:
//   semanticSearch("picard smiling", { limit: 20 })
//   semanticSearch("worf being rude to people", { limit: 30, shotType: "close-up" })
//
// The expansion map covers common video search intents. The AI clip selector
// can also provide its own expansion groups for maximum flexibility.

const EXPANSION_MAP = {
  // Emotions — positive
  smile:    ['smile', 'grin', 'beam', 'amused', 'warm', 'happy', 'pleased', 'delighted', 'joy', 'mirth', 'cheerful', 'lighthearted'],
  laugh:    ['laugh', 'chuckle', 'giggle', 'cackle', 'mirth', 'amused', 'funny', 'humorous', 'comedy'],
  happy:    ['happy', 'joy', 'delight', 'pleased', 'satisfied', 'content', 'warm', 'cheerful', 'smile', 'grin'],
  love:     ['love', 'affection', 'tender', 'romantic', 'intimate', 'embrace', 'kiss', 'caring', 'fond'],

  // Emotions — negative
  angry:    ['angry', 'furious', 'rage', 'outraged', 'incensed', 'hostile', 'aggressive', 'confrontational', 'heated'],
  sad:      ['sad', 'grief', 'sorrow', 'mourning', 'melancholy', 'tears', 'crying', 'devastated', 'heartbroken', 'somber'],
  scared:   ['scared', 'fear', 'frightened', 'terrified', 'alarmed', 'anxious', 'nervous', 'worried', 'dread', 'horror'],
  shocked:  ['shocked', 'surprised', 'stunned', 'astonished', 'disbelief', 'startled', 'taken aback', 'wide-eyed'],
  rude:     ['rude', 'dismissive', 'curt', 'blunt', 'gruff', 'impatient', 'hostile', 'sarcastic', 'contempt', 'disdain'],

  // Actions
  fight:    ['fight', 'battle', 'combat', 'struggle', 'attack', 'punch', 'phaser', 'weapon', 'action', 'confrontation'],
  flirt:    ['flirt', 'charm', 'seductive', 'romantic', 'attraction', 'compliment', 'smooth', 'wink', 'coy'],
  command:  ['command', 'order', 'authority', 'leadership', 'captain', 'directive', 'decision', 'charge'],
  think:    ['think', 'contemplat', 'ponder', 'reflect', 'consider', 'deliberat', 'thoughtful', 'pensive', 'introspect'],

  // Visual
  closeup:  ['close-up', 'close up', 'extreme-close-up', 'face', 'portrait'],
  space:    ['space', 'stars', 'nebula', 'planet', 'orbit', 'warp', 'starfield', 'Enterprise'],
};

export function semanticSearch(intent, options = {}) {
  const db = getDb();
  const limit = options.limit || 50;
  const customExpansions = options.expansions || null;

  // Step 1: Expand the intent into query groups
  const words = intent.toLowerCase().split(/\s+/);
  const queryGroups = [];

  // Always include the raw intent as the highest-weight group
  queryGroups.push({ query: intent, weight: 3.0, source: 'exact' });

  // Expand known words into synonym groups
  for (const word of words) {
    if (EXPANSION_MAP[word]) {
      // Build FTS5 OR query from synonyms
      const ftsQuery = EXPANSION_MAP[word].map(s => `"${s}"`).join(' OR ');
      queryGroups.push({ query: ftsQuery, weight: 1.5, source: `expand:${word}` });
    }
  }

  // Add custom expansions from the AI
  if (customExpansions) {
    for (const group of customExpansions) {
      const ftsQuery = group.terms.map(s => `"${s}"`).join(' OR ');
      queryGroups.push({ query: ftsQuery, weight: group.weight || 1.0, source: `custom:${group.label}` });
    }
  }

  // Also search dialogue
  const dialogueGroups = [
    { query: intent, weight: 2.0, source: 'dialogue:exact' },
  ];

  // Step 2: Run searches and collect scored results
  const shotScores = new Map(); // shot.id -> { shot, totalScore, matchedGroups }

  for (const group of queryGroups) {
    try {
      const results = search(group.query, { ...options, limit: limit * 2 });
      for (const shot of results) {
        const existing = shotScores.get(shot.id);
        if (existing) {
          existing.totalScore += group.weight;
          existing.matchedGroups.push(group.source);
        } else {
          shotScores.set(shot.id, {
            shot,
            totalScore: group.weight,
            matchedGroups: [group.source],
          });
        }
      }
    } catch { /* FTS5 query may fail on some expansions — skip */ }
  }

  // Also search dialogue and boost matching shots
  for (const group of dialogueGroups) {
    try {
      const results = searchDialogue(group.query, { limit: limit * 2 });
      for (const line of results) {
        // Find the corresponding shot
        if (line.shot_id) {
          const existing = shotScores.get(line.shot_id);
          if (existing) {
            existing.totalScore += group.weight;
            existing.matchedGroups.push(group.source);
          }
        }
      }
    } catch { /* skip */ }
  }

  // Step 3: Sort by score, return top results
  const ranked = [...shotScores.values()]
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, limit)
    .map(entry => ({
      ...entry.shot,
      _searchScore: entry.totalScore,
      _matchedGroups: entry.matchedGroups,
    }));

  return ranked;
}

// ── Verify Integrity ─────────────────────────────────────────────────

export function verifyIntegrity() {
  const db = getDb();
  const issues = [];

  // Check each episode's JSON hash matches DB
  const dirs = fs.readdirSync(ANALYSIS_DIR).filter(d =>
    fs.existsSync(path.join(ANALYSIS_DIR, d, 'scenes.json'))
  );

  for (const dir of dirs) {
    const scenesPath = path.join(ANALYSIS_DIR, dir, 'scenes.json');
    const rawJson = fs.readFileSync(scenesPath, 'utf-8');
    const currentHash = crypto.createHash('md5').update(rawJson).digest('hex');

    const dbRecord = db.prepare('SELECT json_hash, scene_count, shot_count FROM episodes WHERE id = ?').get(dir);

    if (!dbRecord) {
      issues.push({ episode: dir, issue: 'missing from DB' });
    } else if (dbRecord.json_hash !== currentHash) {
      issues.push({ episode: dir, issue: 'DB out of sync with scenes.json' });
    }
  }

  // Check for DB episodes without JSON
  const dbEpisodes = db.prepare('SELECT id FROM episodes').all();
  for (const ep of dbEpisodes) {
    if (!fs.existsSync(path.join(ANALYSIS_DIR, ep.id, 'scenes.json'))) {
      issues.push({ episode: ep.id, issue: 'in DB but no scenes.json' });
    }
  }

  return issues;
}

// ── Stats ────────────────────────────────────────────────────────────

export function getStats() {
  const db = getDb();
  return {
    episodes: db.prepare('SELECT COUNT(*) as count FROM episodes').get().count,
    scenes: db.prepare('SELECT COUNT(*) as count FROM scenes').get().count,
    shots: db.prepare('SELECT COUNT(*) as count FROM shots').get().count,
    dialogue: db.prepare('SELECT COUNT(*) as count FROM dialogue').get().count,
    topCharacters: db.prepare(`
      SELECT subject, COUNT(*) as count FROM shots
      WHERE subject IS NOT NULL
      GROUP BY subject ORDER BY count DESC LIMIT 20
    `).all(),
    topLocations: db.prepare(`
      SELECT location, COUNT(*) as count FROM scenes
      WHERE location IS NOT NULL
      GROUP BY location ORDER BY count DESC LIMIT 20
    `).all(),
    topSpeakers: db.prepare(`
      SELECT speaker, COUNT(*) as count FROM dialogue
      WHERE speaker IS NOT NULL
      GROUP BY speaker ORDER BY count DESC LIMIT 20
    `).all(),
    shotTypes: db.prepare(`
      SELECT shot_type, COUNT(*) as count FROM shots
      WHERE shot_type IS NOT NULL
      GROUP BY shot_type ORDER BY count DESC
    `).all(),
    dbSize: fs.existsSync(DB_PATH) ? (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(2) + ' MB' : '0 MB',
  };
}

// ── Hub Queries ──────────────────────────────────────────────────────

export function getSeriesList() {
  const db = getDb();
  return db.prepare(`
    SELECT
      s.id, s.title, s.created_at,
      COUNT(DISTINCT e.id) as episode_count,
      COALESCE(SUM(e.shot_count), 0) as shot_count,
      COALESCE(SUM(e.scene_count), 0) as scene_count,
      MAX(e.analyzed_at) as last_analyzed
    FROM series s
    LEFT JOIN episodes e ON e.series_id = s.id
    GROUP BY s.id
    ORDER BY s.title
  `).all();
}

export function getEpisodes(seriesId) {
  const db = getDb();
  const filter = seriesId ? 'WHERE e.series_id = ?' : '';
  const params = seriesId ? [seriesId] : [];
  return db.prepare(`
    SELECT
      e.id, e.series_id, e.title, e.filename, e.duration_sec,
      e.scene_count, e.shot_count, e.analyzed_at, e.analysis_cost,
      (SELECT COUNT(*) FROM dialogue d WHERE d.episode_id = e.id) as dialogue_count
    FROM episodes e
    ${filter}
    ORDER BY e.id
  `).all(...params);
}

export function getEpisodeDetail(episodeId) {
  const db = getDb();
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  if (!episode) return null;

  const scenes = db.prepare(`
    SELECT id, scene_number, start_sec, end_sec, location, characters, mood, plot_significance, lighting, music, tags, supercut_potential
    FROM scenes WHERE episode_id = ? ORDER BY scene_number
  `).all(episodeId);

  const topSubjects = db.prepare(`
    SELECT subject, COUNT(*) as count FROM shots
    WHERE episode_id = ? AND subject IS NOT NULL
    GROUP BY subject ORDER BY count DESC LIMIT 10
  `).all(episodeId);

  const topSpeakers = db.prepare(`
    SELECT speaker, COUNT(*) as count FROM dialogue
    WHERE episode_id = ? AND speaker IS NOT NULL
    GROUP BY speaker ORDER BY count DESC LIMIT 10
  `).all(episodeId);

  const shotTypes = db.prepare(`
    SELECT shot_type, COUNT(*) as count FROM shots
    WHERE episode_id = ? AND shot_type IS NOT NULL
    GROUP BY shot_type ORDER BY count DESC
  `).all(episodeId);

  const dialogueCount = db.prepare('SELECT COUNT(*) as count FROM dialogue WHERE episode_id = ?').get(episodeId).count;

  return { ...episode, scenes, topSubjects, topSpeakers, shotTypes, dialogue_count: dialogueCount };
}

export function setEpisodeThumbnail(episodeId, thumbnailPath) {
  const db = getDb();
  // Add column if it doesn't exist (migration for existing DBs)
  try { db.prepare('ALTER TABLE episodes ADD COLUMN custom_thumbnail TEXT').run(); } catch {}
  db.prepare('UPDATE episodes SET custom_thumbnail = ? WHERE id = ?').run(thumbnailPath, episodeId);
}

export function getEpisodeThumbnail(episodeId) {
  // Check for user-selected custom thumbnail first
  const db = getDb();
  try {
    const custom = db.prepare('SELECT custom_thumbnail FROM episodes WHERE id = ?').get(episodeId);
    if (custom?.custom_thumbnail) return custom.custom_thumbnail;
  } catch {}

  // Auto-detect: find a recognizable character face shot

  // Best: close-up of the lead character (captain/commander)
  let shot = db.prepare(`
    SELECT scene_number, shot_number FROM shots
    WHERE episode_id = ? AND shot_type IN ('close-up', 'medium close-up')
    AND (subject LIKE '%Picard%' OR subject LIKE '%Sisko%' OR subject LIKE '%Janeway%'
         OR subject LIKE '%Kirk%' OR subject LIKE '%Archer%')
    AND subject NOT LIKE '%, %'
    AND start_sec > 60
    ORDER BY start_sec LIMIT 1
  `).get(episodeId);

  // Next: close-up of any named main character
  if (!shot) {
    shot = db.prepare(`
      SELECT scene_number, shot_number FROM shots
      WHERE episode_id = ? AND shot_type IN ('close-up', 'medium close-up')
      AND (subject LIKE '%Riker%' OR subject LIKE '%Data%' OR subject LIKE '%Troi%'
           OR subject LIKE '%Worf%' OR subject LIKE '%Geordi%' OR subject LIKE '%Crusher%'
           OR subject LIKE '%Spock%' OR subject LIKE '%Kira%' OR subject LIKE '%Odo%')
      AND subject NOT LIKE '%, %'
      AND start_sec > 60
      ORDER BY start_sec LIMIT 1
    `).get(episodeId);
  }

  // Fallback: any close-up of a single subject after 60s
  if (!shot) {
    shot = db.prepare(`
      SELECT scene_number, shot_number FROM shots
      WHERE episode_id = ? AND shot_type IN ('close-up', 'medium close-up')
      AND subject NOT LIKE '%Enterprise%' AND subject NOT LIKE '%credit%'
      AND subject NOT LIKE '%, %' AND subject NOT LIKE '%crew%'
      AND start_sec > 60
      ORDER BY start_sec LIMIT 1
    `).get(episodeId);
  }

  // Fallback: any medium shot after 60s
  if (!shot) {
    shot = db.prepare(`
      SELECT scene_number, shot_number FROM shots
      WHERE episode_id = ? AND shot_type = 'medium' AND start_sec > 60
      ORDER BY start_sec LIMIT 1
    `).get(episodeId);
  }

  // Last fallback
  if (!shot) {
    shot = db.prepare(`
      SELECT scene_number, shot_number FROM shots
      WHERE episode_id = ? ORDER BY start_sec LIMIT 1
    `).get(episodeId);
  }

  if (!shot) return null;
  return `${episodeId}/frames/sc${shot.scene_number}_sh${shot.shot_number}_first.jpg`;
}

export function getRandomThumbnail(episodeId) {
  const db = getDb();
  // Pick a random shot — skip first 60s (credits) and last 120s (end credits)
  const maxSec = db.prepare('SELECT MAX(start_sec) as m FROM shots WHERE episode_id = ?').get(episodeId);
  const upperLimit = maxSec?.m ? maxSec.m - 120 : 999999;
  const shot = db.prepare(`
    SELECT scene_number, shot_number FROM shots
    WHERE episode_id = ?
    AND start_sec > 60
    AND start_sec < ?
    ORDER BY RANDOM() LIMIT 1
  `).get(episodeId, upperLimit);

  if (!shot) return null;
  return `${episodeId}/frames/sc${shot.scene_number}_sh${shot.shot_number}_first.jpg`;
}

export function createSeries(id, title) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO series (id, title) VALUES (?, ?)').run(id, title);
  return { id, title };
}

export function assignEpisodeToSeries(episodeId, seriesId) {
  const db = getDb();
  db.prepare('UPDATE episodes SET series_id = ? WHERE id = ?').run(seriesId, episodeId);
}

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--rebuild')) {
  const episodeId = args[args.indexOf('--rebuild') + 1];
  if (episodeId && !episodeId.startsWith('-')) {
    const scenesPath = path.join(ANALYSIS_DIR, episodeId, 'scenes.json');
    const result = rebuildEpisode(episodeId, scenesPath);
    console.log(result ? `✅ ${episodeId}: ${result.scenes} scenes, ${result.shots} shots` : `⏭️  ${episodeId}: up to date or not found`);
  } else {
    rebuildAll();
  }
  closeDb();
}

else if (args.includes('--search')) {
  const query = args[args.indexOf('--search') + 1];
  if (!query) { console.error('Usage: --search "query"'); process.exit(1); }
  const results = search(query, { limit: 20 });
  console.log(`\n🔍 "${query}" — ${results.length} shots found:\n`);
  for (const r of results) {
    const dur = r.duration_sec?.toFixed(1) || '?';
    console.log(`  ${r.episode_id} sc${r.scene_number} sh${r.shot_number} [${r.shot_type}] ${dur}s`);
    console.log(`    ${r.subject}: ${r.action?.slice(0, 100)}`);
    console.log(`    📍 ${r.location} | 🎭 ${r.mood}`);
    console.log();
  }
  closeDb();
}

else if (args.includes('--find')) {
  const query = args[args.indexOf('--find') + 1];
  if (!query) { console.error('Usage: --find "natural language query"'); process.exit(1); }
  const results = semanticSearch(query, { limit: 20 });
  console.log(`\n🧠 "${query}" — ${results.length} shots found (semantic):\n`);
  for (const r of results) {
    const dur = r.duration_sec?.toFixed(1) || '?';
    const score = r._searchScore?.toFixed(1) || '?';
    const groups = r._matchedGroups?.join(', ') || '';
    console.log(`  ${r.episode_id} sc${r.scene_number} sh${r.shot_number} [${r.shot_type}] ${dur}s  (score: ${score})`);
    console.log(`    ${r.subject}: ${r.action?.slice(0, 100)}`);
    console.log(`    📍 ${r.location} | 🎭 ${r.mood} | matched: ${groups}`);
    console.log();
  }
  closeDb();
}

else if (args.includes('--search-dialogue')) {
  const query = args[args.indexOf('--search-dialogue') + 1];
  if (!query) { console.error('Usage: --search-dialogue "query"'); process.exit(1); }
  const results = searchDialogue(query, { limit: 20 });
  console.log(`\n💬 "${query}" — ${results.length} lines found:\n`);
  for (const r of results) {
    console.log(`  ${r.episode_id} sc${r.scene_number} [${r.location}]`);
    console.log(`    ${r.speaker}: "${r.text?.slice(0, 100)}"`);
    console.log();
  }
  closeDb();
}

else if (args.includes('--verify')) {
  const issues = verifyIntegrity();
  if (issues.length === 0) {
    console.log('✅ Database is in sync with all scenes.json files');
  } else {
    console.log(`⚠️  ${issues.length} issues found:`);
    issues.forEach(i => console.log(`  ${i.episode}: ${i.issue}`));
    console.log('\nRun --rebuild to fix');
  }
  closeDb();
}

else if (args.includes('--stats')) {
  const stats = getStats();
  console.log('\n📊 Video Metadata Database\n');
  console.log(`  Episodes:  ${stats.episodes}`);
  console.log(`  Scenes:    ${stats.scenes}`);
  console.log(`  Shots:     ${stats.shots}`);
  console.log(`  Dialogue:  ${stats.dialogue}`);
  console.log(`  DB size:   ${stats.dbSize}`);
  console.log('\n  Top subjects:');
  stats.topCharacters.slice(0, 10).forEach(c => console.log(`    ${c.count}x ${c.subject}`));
  console.log('\n  Top locations:');
  stats.topLocations.slice(0, 10).forEach(l => console.log(`    ${l.count}x ${l.location}`));
  console.log('\n  Top speakers:');
  stats.topSpeakers.slice(0, 10).forEach(s => console.log(`    ${s.count}x ${s.speaker}`));
  console.log('\n  Shot types:');
  stats.shotTypes.forEach(t => console.log(`    ${t.count}x ${t.shot_type}`));
  closeDb();
}

else {
  console.log('Usage: node db.mjs [--rebuild [EPISODE]] [--find "intent"] [--search "query"] [--search-dialogue "query"] [--verify] [--stats]');
}
