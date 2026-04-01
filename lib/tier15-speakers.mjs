#!/usr/bin/env node
/**
 * Tier 1.5 — Speaker Attribution via Voice Diarization
 *
 * 1. Runs pyannote-audio speaker diarization (local, GPU-accelerated)
 * 2. Matches diarization segments to SRT dialogue by timestamp
 * 3. Labels speaker clusters using Tier 2 shot subject data
 * 4. Updates scenes.json with speaker-attributed dialogue
 *
 * Usage:
 *   node tier15-speakers.mjs S02E01
 *   node tier15-speakers.mjs S02E01 --num-speakers 8
 *
 * Requires:
 *   pip install pyannote.audio torch torchaudio
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

const args = process.argv.slice(2);
const EPISODE_ID = args[0];
const NUM_SPEAKERS = args.find(a => a === '--num-speakers') ? parseInt(args[args.indexOf('--num-speakers') + 1]) : null;

if (!EPISODE_ID) {
  console.error('Usage: node tier15-speakers.mjs EPISODE_ID [--num-speakers N]');
  process.exit(1);
}

const OUT_DIR = path.join(ANALYSIS_DIR, EPISODE_ID);
const STATUS_FILE = path.join(OUT_DIR, '_tier15-status.json');
const LOG_FILE = path.join(OUT_DIR, 'tier15.log');
const DIARIZATION_FILE = path.join(OUT_DIR, 'diarization.json');

// ── Helpers ──────────────────────────────────────────────────────────

function parseTs(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const [m, s] = ts.split(':');
  return parseInt(m) * 60 + parseFloat(s);
}

function fmtTs(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

function log(msg) {
  console.log(msg);
  fs.appendFileSync(LOG_FILE, msg + '\n');
}

function writeStatus(data) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({
    ...data,
    episodeId: EPISODE_ID,
    heartbeat: new Date().toISOString()
  }));
}

function findVideoFile() {
  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (!epMatch) return null;
  const files = fs.readdirSync(MEDIA_DIR);
  const match = files.find(f =>
    new RegExp('s0?' + epMatch[1] + 'e0?' + epMatch[2], 'i').test(f) && f.endsWith('.mp4')
  );
  return match ? path.join(MEDIA_DIR, match) : null;
}

function loadSrt() {
  const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
  if (!epMatch) return [];
  const files = fs.readdirSync(MEDIA_DIR).filter(f => f.toLowerCase().endsWith('.srt'));
  const srtFile = files.find(f => {
    // Match S02E01, S2E1, S2E01 etc — use parseInt to strip leading zeros
    const s = parseInt(epMatch[1]), e = parseInt(epMatch[2]);
    const srtEpMatch = f.match(/[Ss]0*(\d+)[Ee]0*(\d+)/);
    if (srtEpMatch && parseInt(srtEpMatch[1]) === s && parseInt(srtEpMatch[2]) === e) return true;
    const altMatch = f.match(/(\d+)x(\d+)/i);
    if (altMatch && parseInt(altMatch[1]) === parseInt(epMatch[1]) && parseInt(altMatch[2]) === parseInt(epMatch[2])) return true;
    return false;
  });
  if (!srtFile) return [];

  const content = fs.readFileSync(path.join(MEDIA_DIR, srtFile), 'utf-8');
  const entries = [];
  const blocks = content.replace(/\r\n/g, '\n').split('\n\n').filter(b => b.trim());
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const tm = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!tm) continue;
    const start = parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseInt(tm[3]) + parseInt(tm[4]) / 1000;
    const end = parseInt(tm[5]) * 3600 + parseInt(tm[6]) * 60 + parseInt(tm[7]) + parseInt(tm[8]) / 1000;
    const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
    if (text) entries.push({ start, end, text });
  }
  return entries;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  fs.writeFileSync(LOG_FILE, '');
  const startTime = Date.now();

  log(`${'═'.repeat(60)}`);
  log(`  Tier 1.5 — Speaker Diarization`);
  log(`  ${EPISODE_ID}`);
  if (NUM_SPEAKERS) log(`  Expected speakers: ${NUM_SPEAKERS}`);
  log(`${'═'.repeat(60)}\n`);

  writeStatus({ phase: 'starting' });

  // Step 1: Find video file
  const videoPath = findVideoFile();
  if (!videoPath) { log(`❌ Video not found for ${EPISODE_ID}`); process.exit(1); }
  log(`🎬 Video: ${path.basename(videoPath)}`);

  // Step 2: Load SRT
  const srtEntries = loadSrt();
  log(`📝 SRT: ${srtEntries.length} subtitle lines`);

  // Step 3: Run diarization (Python script)
  log(`\n🎤 Step 1: Running speaker diarization (pyannote-audio)...`);
  writeStatus({ phase: 'diarizing', step: 'Running pyannote-audio' });

  const pyScript = path.join(__dirname, 'tier15_diarize.py');
  const pyArgs = [pyScript, videoPath, DIARIZATION_FILE];
  if (NUM_SPEAKERS) pyArgs.push('--num-speakers', String(NUM_SPEAKERS));

  try {
    const result = execSync(`python "${pyArgs.join('" "')}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30 * 60 * 1000, // 30 min max
      env: { ...process.env }
    });
    log(result);
  } catch (err) {
    log(`❌ Diarization failed: ${err.message?.slice(0, 200)}`);
    writeStatus({ phase: 'failed', error: 'Diarization failed' });
    process.exit(1);
  }

  if (!fs.existsSync(DIARIZATION_FILE)) {
    log(`❌ Diarization output not found`);
    writeStatus({ phase: 'failed', error: 'No diarization output' });
    process.exit(1);
  }

  const diarization = JSON.parse(fs.readFileSync(DIARIZATION_FILE, 'utf-8'));
  log(`\n✅ Diarization: ${diarization.totalSpeakers} speakers, ${diarization.totalSegments} segments`);

  // Step 4: Match diarization to SRT dialogue
  log(`\n🔗 Step 2: Matching speakers to dialogue...`);
  writeStatus({ phase: 'matching', step: 'Matching speakers to SRT' });

  // For each SRT line, find which diarization speaker was talking at that timestamp
  const srtWithSpeakers = srtEntries.map(srt => {
    const mid = (srt.start + srt.end) / 2;

    // Find overlapping diarization segments
    const overlapping = diarization.segments.filter(seg =>
      seg.start <= mid && seg.end >= mid
    );

    // If no exact match, find closest
    let speaker = 'Unknown';
    if (overlapping.length > 0) {
      // Pick the one with most overlap
      let bestOverlap = 0;
      for (const seg of overlapping) {
        const overlapStart = Math.max(srt.start, seg.start);
        const overlapEnd = Math.min(srt.end, seg.end);
        const overlap = overlapEnd - overlapStart;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          speaker = seg.speaker;
        }
      }
    } else {
      // Find nearest segment
      let bestDist = Infinity;
      for (const seg of diarization.segments) {
        const dist = Math.min(Math.abs(seg.start - mid), Math.abs(seg.end - mid));
        if (dist < bestDist && dist < 2.0) { // within 2 seconds
          bestDist = dist;
          speaker = seg.speaker;
        }
      }
    }

    return { ...srt, speaker };
  });

  const matched = srtWithSpeakers.filter(s => s.speaker !== 'Unknown').length;
  log(`  ${matched}/${srtEntries.length} dialogue lines matched to speakers (${(matched / srtEntries.length * 100).toFixed(0)}%)`);

  // Step 5: Label speaker clusters using Tier 2 shot subjects
  log(`\n🏷️  Step 3: Labeling speaker clusters...`);
  writeStatus({ phase: 'labeling', step: 'Identifying speakers by shot subjects' });

  const scenes = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'scenes.json'), 'utf-8'));

  // Build the master character list from ALL scene metadata
  const allCharacters = new Set();
  for (const sc of scenes) {
    for (const char of (sc.characters || [])) {
      // Normalize: strip titles, trim
      const normalized = char.replace(/^(Captain|Commander|Lt\.\s*Commander|Lt\.|Lieutenant|Dr\.|Doctor|Counselor|Ensign|Chief)\s+/i, '').trim();
      allCharacters.add(normalized);
      allCharacters.add(char); // keep full name too
    }
  }
  log(`  Character pool (from scene metadata): ${[...allCharacters].slice(0, 15).join(', ')}${allCharacters.size > 15 ? '...' : ''}`);

  // Build a map: for each dialogue line in a close-up shot, associate the speaker ID with the shot subject
  // ONLY if the subject matches a character from the scene's character list
  const speakerVotes = {}; // { SPEAKER_00: { "Picard": 5, "Riker": 1 } }

  for (const sc of scenes) {
    // Get normalized character names for this scene
    const sceneChars = new Set();
    for (const char of (sc.characters || [])) {
      const normalized = char.replace(/^(Captain|Commander|Lt\.\s*Commander|Lt\.|Lieutenant|Dr\.|Doctor|Counselor|Ensign|Chief)\s+/i, '').trim();
      sceneChars.add(normalized.toLowerCase());
    }

    for (const sh of (sc.shots || [])) {
      if (!sh.subject) continue;
      const shotStart = parseTs(sh.startTimestamp);
      const shotEnd = parseTs(sh.endTimestamp);

      // Only use close-up / medium close-up shots for labeling (most reliable subject)
      const isCloseup = ['close-up', 'medium close-up', 'extreme-close-up'].includes(sh.shotType);
      const weight = isCloseup ? 3 : 1;

      // Find dialogue lines in this shot
      const shotDialogue = srtWithSpeakers.filter(s =>
        s.start >= shotStart - 0.5 && s.start < shotEnd + 0.5 && s.speaker !== 'Unknown'
      );

      for (const dlg of shotDialogue) {
        if (!speakerVotes[dlg.speaker]) speakerVotes[dlg.speaker] = {};
        const subject = sh.subject;
        // If subject is a single character (no comma, no "and")
        if (!subject.includes(',') && !subject.toLowerCase().includes(' and ')) {
          const charName = subject.replace(/^(Captain|Commander|Lt\.\s*Commander|Lt\.|Lieutenant|Dr\.|Doctor|Counselor|Ensign|Chief)\s+/i, '').trim();
          // ONLY vote for characters that are in the scene's character list
          if (sceneChars.has(charName.toLowerCase()) || allCharacters.has(charName)) {
            speakerVotes[dlg.speaker][charName] = (speakerVotes[dlg.speaker][charName] || 0) + weight;
          }
        }
      }
    }
  }

  // Assign labels: each speaker cluster gets the character with the most votes
  // RESTRICTED to characters that appear in scene metadata
  const speakerLabels = {};
  const usedCharacters = new Set();

  // Sort speakers by total votes (most votes first = most confident)
  const sortedSpeakers = Object.entries(speakerVotes)
    .map(([sp, votes]) => ({ sp, votes, total: Object.values(votes).reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.total - a.total);

  for (const { sp, votes } of sortedSpeakers) {
    // Get character with most votes that hasn't been assigned yet
    // MUST be from the allCharacters set
    const sorted = Object.entries(votes)
      .sort((a, b) => b[1] - a[1])
      .filter(([char]) => !usedCharacters.has(char) && allCharacters.has(char));

    if (sorted.length > 0) {
      const [bestChar, bestVotes] = sorted[0];
      speakerLabels[sp] = bestChar;
      usedCharacters.add(bestChar);
      log(`  ${sp} → ${bestChar} (${bestVotes} votes, ${Object.values(votes).reduce((s, v) => s + v, 0)} total)`);
    } else {
      speakerLabels[sp] = 'Unknown'; // Don't keep SPEAKER_XX labels — use Unknown
      log(`  ${sp} → Unknown (no match in character list)`);
    }
  }

  // Step 6: Apply labels to all dialogue
  log(`\n💬 Step 4: Updating dialogue with speaker names...`);
  writeStatus({ phase: 'applying', step: 'Updating scenes.json' });

  let updated = 0;
  for (const sc of scenes) {
    // Build this scene's valid character set
    const sceneCharSet = new Set();
    for (const char of (sc.characters || [])) {
      const normalized = char.replace(/^(Captain|Commander|Lt\.\s*Commander|Lt\.|Lieutenant|Dr\.|Doctor|Counselor|Ensign|Chief)\s+/i, '').trim();
      sceneCharSet.add(normalized);
      sceneCharSet.add(char);
    }

    for (const sh of (sc.shots || [])) {
      const shotStart = parseTs(sh.startTimestamp);
      const shotEnd = parseTs(sh.endTimestamp);

      // Rebuild dialogue with speaker labels
      // RESTRICT speakers to those listed in this scene's characters
      sh.dialogue = srtWithSpeakers
        .filter(s => s.start >= shotStart - 0.3 && s.start < shotEnd + 0.3)
        .map(s => {
          let speaker = speakerLabels[s.speaker] || 'Unknown';
          // If the assigned speaker isn't in this scene's character list, mark as Unknown
          if (speaker !== 'Unknown' && sceneCharSet.size > 0 && !sceneCharSet.has(speaker)) {
            speaker = 'Unknown';
          }
          return { speaker, text: s.text, start: fmtTs(s.start), end: fmtTs(s.end) };
        });

      updated += sh.dialogue.filter(d => d.speaker !== 'Unknown').length;
    }
  }

  // Save
  fs.writeFileSync(path.join(OUT_DIR, 'scenes.json'), JSON.stringify(scenes, null, 2));
  log(`  ✅ ${updated} dialogue lines with speaker names`);

  // Rebuild DB + report
  log(`\n📝 Rebuilding database + report...`);
  try {
    execSync(`node "${path.join(__dirname, 'db.mjs')}" --rebuild ${EPISODE_ID}`, {
      cwd: __dirname, stdio: 'pipe', timeout: 30000
    });
    log(`  ✅ Database updated`);
  } catch (e) { log(`  ⚠️  DB: ${e.message?.slice(0, 60)}`); }

  try {
    const videoFile = findVideoFile();
    execSync(`node "${path.join(__dirname, 'rebuild-report.mjs')}" "${EPISODE_ID}" "${videoFile}"`, {
      cwd: __dirname, stdio: 'pipe', timeout: 60000,
      env: { ...process.env, VSTACK_NO_OPEN: '1' }
    });
    log(`  ✅ Report rebuilt`);
  } catch (e) { log(`  ⚠️  Report: ${e.message?.slice(0, 60)}`); }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);

  log(`\n${'═'.repeat(60)}`);
  log(`  ✅ Tier 1.5 Complete!`);
  log(`  ${diarization.totalSpeakers} speakers identified`);
  log(`  ${Object.keys(speakerLabels).length} speakers labeled`);
  log(`  ${updated} dialogue lines attributed`);
  log(`  Time: ${elapsed}min`);
  log(`${'═'.repeat(60)}\n`);

  writeStatus({
    phase: 'complete',
    speakers: diarization.totalSpeakers,
    labeled: Object.keys(speakerLabels).length,
    dialogueUpdated: updated,
    elapsed: elapsed + 'min',
    speakerLabels
  });
}

main().catch(err => {
  log(`\n❌ Fatal: ${err.message}`);
  writeStatus({ phase: 'failed', error: err.message?.slice(0, 200) });
  process.exit(1);
});
