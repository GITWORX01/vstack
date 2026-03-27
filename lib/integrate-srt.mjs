#!/usr/bin/env node
/**
 * Integrate SRT subtitles into scene/shot metadata.
 *
 * Matches subtitle entries to shots by timestamp overlap and writes
 * the enriched dialogue data back into scenes.json.
 *
 * Usage:
 *   node integrate-srt.mjs EPISODE_ID "path/to/subtitle.srt"
 *
 * Requires a vstack.config.json in the current working directory.
 */

import fs from 'fs';
import path from 'path';
import { getConfig } from './config.mjs';
import { parseTs, parseSRT } from './utils.mjs';

// ── Args ─────────────────────────────────────────────────────────────

const EPISODE_ID = process.argv[2];
const SRT_FILE = process.argv[3];

if (!EPISODE_ID || !SRT_FILE) {
  console.error('Usage: node integrate-srt.mjs EPISODE_ID "path/to/subtitle.srt"');
  process.exit(1);
}

// ── Config ───────────────────────────────────────────────────────────

const cfg = getConfig();
const scenesPath = path.join(cfg.projectDir, EPISODE_ID, 'scenes.json');

if (!fs.existsSync(scenesPath)) {
  console.error(`scenes.json not found at: ${scenesPath}`);
  console.error(`Run analyze-episode.mjs first to generate scene data.`);
  process.exit(1);
}

if (!fs.existsSync(SRT_FILE)) {
  console.error(`SRT file not found: ${SRT_FILE}`);
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────

const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));
const subs = parseSRT(SRT_FILE);

console.log(`Parsed ${subs.length} subtitle entries from ${path.basename(SRT_FILE)}`);

let matchedShots = 0;
let totalDialogueLines = 0;

for (const scene of scenes) {
  // Collect dialogue at the scene level
  const sceneStart = parseTs(scene.startTimestamp);
  const sceneEnd = parseTs(scene.endTimestamp);
  const sceneDialogue = subs.filter(s => s.start < sceneEnd && s.end > sceneStart);
  scene.dialogue = sceneDialogue.map(s => s.text);

  if (!scene.shots) continue;

  for (const shot of scene.shots) {
    const shotStart = parseTs(shot.startTimestamp);
    const shotEnd = parseTs(shot.endTimestamp);

    // Find all subtitle entries that overlap with this shot
    const overlapping = subs.filter(s => s.start < shotEnd && s.end > shotStart);

    if (overlapping.length > 0) {
      shot.dialogue = overlapping.map(s => ({
        text: s.text,
        start: s.start.toFixed(3),
        end: s.end.toFixed(3),
      }));
      matchedShots++;
      totalDialogueLines += overlapping.length;
    }
  }
}

// Save updated scenes
fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2));

console.log(`Matched ${totalDialogueLines} dialogue lines to ${matchedShots} shots`);
console.log(`Saved to ${scenesPath}`);
