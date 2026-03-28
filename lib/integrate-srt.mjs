#!/usr/bin/env node
/**
 * Integrate SRT subtitles into scene/shot metadata.
 * Matches subtitle entries to shots by timestamp overlap.
 *
 * Usage: node integrate-srt.mjs S02E01 "C:\Star Trek\Star Trek TNG - S02E01 - The Child.srt"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EPISODE_ID = process.argv[2];
const SRT_FILE = process.argv[3];

if (!EPISODE_ID || !SRT_FILE) {
  console.error('Usage: node integrate-srt.mjs EPISODE_ID "path/to/subtitle.srt"');
  process.exit(1);
}

// Parse SRT format
function parseSRT(content) {
  const entries = [];
  const blocks = content.replace(/\r\n/g, '\n').split('\n\n').filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!timeMatch) continue;

    const startSec = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 +
                     parseInt(timeMatch[3]) + parseInt(timeMatch[4]) / 1000;
    const endSec = parseInt(timeMatch[5]) * 3600 + parseInt(timeMatch[6]) * 60 +
                   parseInt(timeMatch[7]) + parseInt(timeMatch[8]) / 1000;

    // Clean text: remove HTML tags, join lines
    const text = lines.slice(2).join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .trim();

    if (text) {
      entries.push({ start: startSec, end: endSec, text });
    }
  }

  return entries;
}

function parseTs(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const [m, s] = ts.split(':');
  return parseInt(m) * 60 + parseFloat(s);
}

// Main
const scenesPath = path.join(__dirname, 'gemini-analysis', EPISODE_ID, 'scenes.json');
const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));
const srtContent = fs.readFileSync(SRT_FILE, 'utf-8');
const subs = parseSRT(srtContent);

console.log(`📝 Parsed ${subs.length} subtitle entries from ${path.basename(SRT_FILE)}`);

let matchedShots = 0;
let totalDialogueLines = 0;

for (const scene of scenes) {
  // Collect dialogue for the scene level too
  const sceneStart = parseTs(scene.startTimestamp);
  const sceneEnd = parseTs(scene.endTimestamp);
  const sceneDialogue = subs.filter(s =>
    s.start < sceneEnd && s.end > sceneStart
  );
  scene.dialogue = sceneDialogue.map(s => s.text);

  if (!scene.shots) continue;

  for (const shot of scene.shots) {
    const shotStart = parseTs(shot.startTimestamp);
    const shotEnd = parseTs(shot.endTimestamp);

    // Find all subtitle entries that overlap with this shot
    const overlapping = subs.filter(s =>
      s.start < shotEnd && s.end > shotStart
    );

    if (overlapping.length > 0) {
      shot.dialogue = overlapping.map(s => ({
        text: s.text,
        start: s.start.toFixed(3),
        end: s.end.toFixed(3)
      }));
      matchedShots++;
      totalDialogueLines += overlapping.length;
    }
  }
}

// Save updated scenes
fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2));

console.log(`✅ Matched ${totalDialogueLines} dialogue lines to ${matchedShots} shots`);
console.log(`   Saved to ${scenesPath}`);
