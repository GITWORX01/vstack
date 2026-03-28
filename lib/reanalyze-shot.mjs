#!/usr/bin/env node
/**
 * Reanalyze a single shot — splits an oversized shot into multiple shots
 * using Gemini Pass B with full SRT dialogue attribution.
 *
 * Usage: node reanalyze-shot.mjs EPISODE_ID SCENE_NUM SHOT_NUM
 * Reads config from environment or defaults.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const episodeId = process.argv[2];
const sceneNum = parseInt(process.argv[3]);
const shotNum = parseInt(process.argv[4]);

if (!episodeId || isNaN(sceneNum) || isNaN(shotNum)) {
  console.error('Usage: node reanalyze-shot.mjs EPISODE_ID SCENE_NUM SHOT_NUM');
  process.exit(1);
}

const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');
const MEDIA_DIR = process.env.MEDIA_DIR || 'C:\\Star Trek';
const GCLOUD_PATH = process.env.GCLOUD_PATH || 'C:\\Users\\steve\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin';
const REGION = process.env.GCP_REGION || 'us-east1';
const PROJECT = process.env.GCP_PROJECT || 'data-mind-456822-q3';
const MODEL = 'gemini-2.5-pro';

const ffmpegDir = path.join(__dirname, 'ffmpeg');
const subdirs = fs.readdirSync(ffmpegDir).filter(d => d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory());
const FFMPEG = path.join(ffmpegDir, subdirs[0], 'bin', 'ffmpeg.exe');

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

function writeStatus(obj) {
  fs.writeFileSync(path.join(ANALYSIS_DIR, episodeId, '_reanalyze-status.json'), JSON.stringify(obj));
}

async function main() {
  const scenesPath = path.join(ANALYSIS_DIR, episodeId, 'scenes.json');
  const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));

  const scene = scenes.find(s => s.sceneNumber === sceneNum);
  if (!scene) { writeStatus({ status: 'error', error: `Scene ${sceneNum} not found` }); process.exit(1); }

  const shotIdx = scene.shots?.findIndex(s => s.shotNumber === shotNum);
  if (shotIdx === -1 || shotIdx === undefined) { writeStatus({ status: 'error', error: `Shot ${shotNum} not found` }); process.exit(1); }

  const shot = scene.shots[shotIdx];
  const startSec = parseTs(shot.startTimestamp);
  const endSec = parseTs(shot.endTimestamp);

  console.log(`Reanalyzing Scene ${sceneNum} Shot ${shotNum}: ${shot.startTimestamp} - ${shot.endTimestamp} (${(endSec - startSec).toFixed(1)}s)`);

  // Find video file
  const mediaFiles = fs.readdirSync(MEDIA_DIR);
  const epMatch = episodeId.match(/S(\d+)E(\d+)/i);
  const videoFile = mediaFiles.find(f => new RegExp('s0?' + epMatch[1] + 'e0?' + epMatch[2], 'i').test(f) && f.endsWith('.mp4'));
  if (!videoFile) { writeStatus({ status: 'error', error: 'Video file not found' }); process.exit(1); }
  const videoPath = path.join(MEDIA_DIR, videoFile);
  const gcsUri = `gs://tng-video-analysis-east/${episodeId}.mp4`;

  // Load SRT subtitles for this time range
  let srtSection = '';
  const srtFile = mediaFiles.find(f => new RegExp('s0?' + epMatch[1] + 'e0?' + epMatch[2], 'i').test(f) && f.toLowerCase().endsWith('.srt'));
  if (srtFile) {
    const srtContent = fs.readFileSync(path.join(MEDIA_DIR, srtFile), 'utf-8');
    const blocks = srtContent.replace(/\r\n/g, '\n').split('\n\n').filter(b => b.trim());
    const subs = [];
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;
      const tm = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      if (!tm) continue;
      const st = parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseInt(tm[3]) + parseInt(tm[4]) / 1000;
      const en = parseInt(tm[5]) * 3600 + parseInt(tm[6]) * 60 + parseInt(tm[7]) + parseInt(tm[8]) / 1000;
      const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
      if (text && st >= startSec - 2 && st <= endSec + 2) {
        subs.push({ st, en, text });
      }
    }
    if (subs.length > 0) {
      srtSection = '\n\nDIALOGUE (from subtitles — identify who speaks each line by watching the video):\n' +
        subs.map(s => '[' + fmtTs(s.st) + ' -> ' + fmtTs(s.en) + '] "' + s.text + '"').join('\n');
      console.log(`Found ${subs.length} subtitle lines for this time range`);
    } else {
      console.log('No subtitle lines found in this time range');
    }
  } else {
    console.log('No SRT file found');
  }

  // Build prompt
  const prompt = `Analyze this video from ${fmtTs(startSec)} to ${fmtTs(endSec)}.

Scene context: ${scene.location || ''}. Characters: ${(scene.characters || []).join(', ')}.

For every camera cut or significant visual change, provide a shot object with:
- shotNumber (sequential starting from 1)
- startTimestamp (MM:SS.s)
- endTimestamp (MM:SS.s)
- shotType (wide/medium/close-up/extreme-close-up/over-shoulder/two-shot/insert/establishing/effect)
- subject (who/what the camera focuses on)
- action (what happens, 1-2 sentences)
- characterExpressions (object: {"Character": "expression"})
- cameraMovement (static/pan/tilt/track/zoom/dolly)
- dialogue (array of {speaker, text, start, end} — use EXACT subtitle text below, identify speaker by watching who talks on screen)
- tags (array of searchable keywords — be generous)
- supercutPotential (array of compilation categories)
${srtSection}

RULES:
- Cover EVERY second from ${fmtTs(startSec)} to ${fmtTs(endSec)}
- Continuous timestamps (shot N end = shot N+1 start)
- First shot starts at ${fmtTs(startSec)}, last shot ends at ${fmtTs(endSec)}
- Sub-second precision (MM:SS.s)
- Output ONLY a JSON array [ ... ]`;

  writeStatus({ status: 'analyzing', step: 'Getting auth token' });
  const token = execSync(`"${path.join(GCLOUD_PATH, 'gcloud')}" auth print-access-token`, { encoding: 'utf-8' }).trim();

  writeStatus({ status: 'analyzing', step: 'Sending to Gemini' });

  const reqBody = JSON.stringify({
    contents: [{ role: 'user', parts: [
      { fileData: { mimeType: 'video/mp4', fileUri: gcsUri } },
      { text: prompt }
    ]}],
    generationConfig: { temperature: 0.1, maxOutputTokens: 32768, mediaResolution: 'MEDIA_RESOLUTION_LOW' }
  });

  const tmpReq = path.join(ANALYSIS_DIR, episodeId, '_reanalyze_req.json');
  fs.writeFileSync(tmpReq, reqBody);

  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/${MODEL}:generateContent`;
  const result = execSync(
    `curl -s --max-time 600 "${url}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${tmpReq}"`,
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
  );
  if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);

  const response = JSON.parse(result);
  if (response.error) {
    writeStatus({ status: 'error', error: response.error.message?.slice(0, 200) });
    process.exit(1);
  }

  let text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
  // Strip markdown fences
  text = text.replace(/^```json\s*/m, '').replace(/```\s*$/m, '');
  // Fix common JSON issues
  text = text.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

  const m = text.match(/\[[\s\S]*\]/);
  if (!m) { writeStatus({ status: 'error', error: 'No JSON in response' }); process.exit(1); }

  const newShots = JSON.parse(m[0]);
  console.log(`Gemini returned ${newShots.length} shots`);

  // Count dialogue
  const dlgCount = newShots.reduce((s, sh) => s + (sh.dialogue?.length || 0), 0);
  console.log(`Dialogue lines: ${dlgCount}`);

  if (newShots.length <= 1) {
    writeStatus({ status: 'done', newShotCount: 1, message: 'Single shot — no splits possible' });
    process.exit(0);
  }

  writeStatus({ status: 'analyzing', step: `Updating scenes.json (${newShots.length} new shots)` });

  // Replace the shot
  scene.shots.splice(shotIdx, 1, ...newShots);
  scene.shots.forEach((sh, i) => { sh.shotNumber = i + 1; });
  fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2));

  // Extract frames for new shots
  writeStatus({ status: 'analyzing', step: 'Extracting frames' });
  const framesDir = path.join(ANALYSIS_DIR, episodeId, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  let extracted = 0;
  for (const sh of newShots) {
    const idx = scene.shots.indexOf(sh);
    const first = `sc${sceneNum}_sh${idx + 1}_first.jpg`;
    const last = `sc${sceneNum}_sh${idx + 1}_last.jpg`;
    sh._frameFirst = first;
    sh._frameLast = last;

    const ss = parseTs(sh.startTimestamp);
    const es = parseTs(sh.endTimestamp);
    try {
      execSync(`"${FFMPEG}" -ss ${ss.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${path.join(framesDir, first)}" -y`, { stdio: 'pipe', timeout: 10000 });
      execSync(`"${FFMPEG}" -ss ${es.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${path.join(framesDir, last)}" -y`, { stdio: 'pipe', timeout: 10000 });
      extracted++;
    } catch {}
  }

  // Save updated scenes
  fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2));

  // Rebuild DB
  writeStatus({ status: 'analyzing', step: 'Rebuilding database' });
  try { execSync(`node "${path.join(__dirname, 'db.mjs')}" --rebuild ${episodeId}`, { cwd: __dirname, stdio: 'pipe', timeout: 30000 }); } catch {}

  // Rebuild report
  writeStatus({ status: 'analyzing', step: 'Rebuilding report' });
  try { execSync(`node "${path.join(__dirname, 'rebuild-report.mjs')}" "${episodeId}" "${videoPath}"`, { cwd: __dirname, stdio: 'pipe', timeout: 60000 }); } catch {}

  writeStatus({
    status: 'done',
    newShotCount: newShots.length,
    dialogueLines: dlgCount,
    framesExtracted: extracted,
    message: `Split into ${newShots.length} shots with ${dlgCount} dialogue lines. Report rebuilt.`
  });

  console.log(`Done! ${newShots.length} shots, ${dlgCount} dialogue, ${extracted} frames`);
}

main().catch(err => {
  writeStatus({ status: 'error', error: err.message });
  console.error(err);
  process.exit(1);
});
