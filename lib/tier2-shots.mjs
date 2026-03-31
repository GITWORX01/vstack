#!/usr/bin/env node
/**
 * Tier 2 — Shot-level metadata via 2-frame image analysis
 *
 * Takes existing scenes.json (from Tier 1) and enriches shots with:
 * - shotType, subject, action, characterExpressions, cameraMovement
 * - tags, supercutPotential
 * - Dialogue matched from Tier 1 scene dialogue by timestamp
 *
 * Sends first + last frame images (not video) to Gemini.
 * Batches ~30 shots per API call for efficiency.
 *
 * Usage:
 *   node tier2-shots.mjs S02E05                           # All shots
 *   node tier2-shots.mjs S02E05 --scene 5                 # One scene
 *   node tier2-shots.mjs S02E05 --shot 5.3                # One shot (scene 5, shot 3)
 *   node tier2-shots.mjs S02E05 --region us-east1
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────

const PROJECT = process.env.GCP_PROJECT;
if (!PROJECT) { console.error('❌ GCP_PROJECT env var required'); process.exit(1); }
const MODEL = 'gemini-2.5-pro';
const MAX_OUTPUT_TOKENS = 65536;
const TEMPERATURE = 0.1;
const MAX_RETRIES = parseInt(process.argv.find(a => a.startsWith('--retries='))?.split('=')[1] || '0');
const RETRY_BASE_MS = 15000;
const BATCH_SIZE = 30; // shots per API call (60 images)

const GCLOUD_PATH = process.env.GCLOUD_PATH ||
  'C:/Users/steve/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin';

const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const EPISODE_ID = args[0];
const SCENE_FILTER = args.find(a => a === '--scene') ? parseInt(args[args.indexOf('--scene') + 1]) : null;
const SHOT_FILTER = args.find(a => a === '--shot') ? args[args.indexOf('--shot') + 1] : null;
const REGION = (args.find(a => a === '--region') ? args[args.indexOf('--region') + 1] : null) || 'us-east1';

if (!EPISODE_ID) {
  console.error('Usage: node tier2-shots.mjs EPISODE_ID [--scene N] [--shot N.N] [--region R]');
  process.exit(1);
}

const OUT_DIR = path.join(ANALYSIS_DIR, EPISODE_ID);
const FRAMES_DIR = path.join(OUT_DIR, 'frames');
const COST_LEDGER = path.join(OUT_DIR, 'cost-ledger.json');

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getToken() {
  const gcloudBin = path.join(GCLOUD_PATH, process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud');
  return execSync(`"${gcloudBin}" auth print-access-token`, { encoding: 'utf-8' }).trim();
}

function logCost(label, usage) {
  const prompt = usage.promptTokenCount || 0;
  const output = usage.candidatesTokenCount || 0;
  const thinking = usage.thoughtsTokenCount || 0;
  // Images are ≤200K so use the lower rate
  const inputRate = 1.25; // $/M for ≤200K
  const outputRate = 10.00; // $/M
  const cost = prompt * inputRate / 1e6 + (output + thinking) * outputRate / 1e6;

  let ledger = [];
  try { ledger = JSON.parse(fs.readFileSync(COST_LEDGER, 'utf-8')); } catch {}
  ledger.push({
    label, tier: 2,
    promptTokens: prompt, outputTokens: output, thinkingTokens: thinking,
    cost, timestamp: new Date().toISOString()
  });
  fs.writeFileSync(COST_LEDGER, JSON.stringify(ledger, null, 2));
  return cost;
}

function imageToBase64(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).toString('base64');
}

// ── Load scenes.json ─────────────────────────────────────────────────

function loadScenes() {
  const scenesPath = path.join(OUT_DIR, 'scenes.json');
  if (!fs.existsSync(scenesPath)) {
    console.error(`❌ scenes.json not found at ${scenesPath}. Run Tier 1 first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));
}

// ── Build shots to analyze ───────────────────────────────────────────

function getShotsToAnalyze(scenes) {
  const shots = [];

  for (const scene of scenes) {
    // Apply scene/shot filters
    if (SCENE_FILTER && scene.sceneNumber !== SCENE_FILTER) continue;

    for (const shot of (scene.shots || [])) {
      if (SHOT_FILTER) {
        const [s, sh] = SHOT_FILTER.split('.');
        if (parseInt(s) !== scene.sceneNumber || parseInt(sh) !== shot.shotNumber) continue;
      }

      // Skip shots that already have Tier 2 data (unless re-analyzing specific shot)
      if (!SHOT_FILTER && !SCENE_FILTER && shot._tier === 2) continue;

      shots.push({
        scene,
        shot,
        firstFrame: path.join(FRAMES_DIR, shot._frameFirst || `sc${scene.sceneNumber}_sh${shot.shotNumber}_first.jpg`),
        lastFrame: path.join(FRAMES_DIR, shot._frameLast || `sc${scene.sceneNumber}_sh${shot.shotNumber}_last.jpg`),
      });
    }
  }

  return shots;
}

// ── Gemini API call with images ──────────────────────────────────────

async function analyzeBatch(batchShots) {
  // Build the prompt with scene context + image pairs
  const parts = [];

  // Group by scene for context efficiency
  const byScene = {};
  for (const s of batchShots) {
    const key = s.scene.sceneNumber;
    if (!byScene[key]) byScene[key] = { scene: s.scene, shots: [] };
    byScene[key].shots.push(s);
  }

  let promptText = `Analyze these shots from a TV episode. For each shot I'm providing the FIRST and LAST frame.\n\n`;

  for (const [sceneNum, group] of Object.entries(byScene)) {
    const sc = group.scene;
    promptText += `SCENE ${sceneNum} context: ${sc.location || '?'} | Characters: ${(sc.characters || []).join(', ')} | Mood: ${sc.mood || '?'}\n`;

    for (const s of group.shots) {
      const startSec = parseTs(s.shot.startTimestamp);
      const endSec = parseTs(s.shot.endTimestamp);
      const dur = (endSec - startSec).toFixed(1);
      promptText += `  Shot ${s.shot.shotNumber} (${s.shot.startTimestamp} → ${s.shot.endTimestamp}, ${dur}s) — frames follow:\n`;

      // Add first frame image
      const firstB64 = imageToBase64(s.firstFrame);
      const lastB64 = imageToBase64(s.lastFrame);

      if (firstB64) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: firstB64 } });
        promptText += `  [FIRST FRAME of Shot ${s.shot.shotNumber}]\n`;
      }
      if (lastB64) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: lastB64 } });
        promptText += `  [LAST FRAME of Shot ${s.shot.shotNumber}]\n`;
      }
    }
    promptText += '\n';
  }

  promptText += `For EACH shot provide a JSON object with:
- sceneNumber
- shotNumber
- shotType (wide/medium/close-up/extreme-close-up/over-shoulder/two-shot/insert/establishing/effect)
- subject (who or what the camera focuses on — use character names from scene context)
- action (what happens between the first and last frame, 1-2 sentences)
- characterExpressions (object: {"CharacterName": "expression"})
- cameraMovement (static/pan/tilt/track/zoom/dolly — compare first vs last frame to determine)
- tags (array of searchable keywords)
- supercutPotential (array of compilation categories)

RULES:
- Provide data for EVERY shot listed above
- Output ONLY a JSON array [ ... ]`;

  // Build final parts array: text prompt interspersed with images
  // We need to reconstruct with images in the right positions
  const finalParts = [];
  let textIdx = 0;
  const promptLines = promptText.split('\n');
  let currentText = '';

  for (const line of promptLines) {
    if (line.includes('[FIRST FRAME of Shot') || line.includes('[LAST FRAME of Shot')) {
      // Flush text before image
      if (currentText.trim()) {
        finalParts.push({ text: currentText });
        currentText = '';
      }
      // Add the next image from parts array
      if (textIdx < parts.length) {
        finalParts.push(parts[textIdx]);
        textIdx++;
      }
    } else {
      currentText += line + '\n';
    }
  }
  // Flush remaining text
  if (currentText.trim()) {
    finalParts.push({ text: currentText });
  }

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: finalParts }],
    generationConfig: {
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    labels: {
      tier: 'tier2',
      episode: EPISODE_ID.toLowerCase()
    }
  });

  const tmpReq = path.join(OUT_DIR, '_req_tier2.json');
  fs.writeFileSync(tmpReq, body);

  const totalAttempts = MAX_RETRIES + 1; // 0 retries = 1 attempt
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    console.log(`   🔄 Attempt ${attempt}/${totalAttempts}...`);

    try {
      const token = getToken();
      const baseUrl = REGION === 'global'
        ? `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global`
        : `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}`;
      const url = `${baseUrl}/publishers/google/models/${MODEL}:generateContent`;

      const result = execSync(
        `curl -s --max-time 3600 "${url}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${tmpReq}"`,
        { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: 3660000 }
      );

      const response = JSON.parse(result);

      if (response.error) {
        console.log(`   ⚠️  API error: ${response.error.message?.slice(0, 100)}`);
        if (attempt < totalAttempts) { await sleep(RETRY_BASE_MS * attempt); continue; }
        return null;
      }

      const usage = response.usageMetadata || {};
      const cost = logCost(`tier2-batch-${batchShots.length}shots`, usage);
      console.log(`   ✅ $${cost.toFixed(4)} | ${(usage.promptTokenCount / 1000).toFixed(0)}K in | ${((usage.candidatesTokenCount || 0) / 1000).toFixed(0)}K out`);

      let text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      text = text.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) {
        console.log(`   ⚠️  No JSON array found`);
        if (attempt < MAX_RETRIES) { await sleep(10000); continue; }
        return null;
      }

      if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);
      return JSON.parse(match[0]);

    } catch (err) {
      console.log(`   ⚠️  Failed: ${err.message?.slice(0, 80)}`);
      if (attempt < totalAttempts) await sleep(RETRY_BASE_MS * attempt);
    }
  }

  if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);
  return null;
}

// ── Match dialogue to shots by timestamp ─────────────────────────────

function assignDialogueToShots(scenes) {
  let assigned = 0;
  for (const scene of scenes) {
    const sceneDialogue = scene.dialogue || [];

    for (const shot of (scene.shots || [])) {
      const shotStart = parseTs(shot.startTimestamp);
      const shotEnd = parseTs(shot.endTimestamp);

      // Find dialogue lines that fall within this shot's time range
      shot.dialogue = sceneDialogue.filter(d => {
        const dStart = parseTs(d.start);
        return dStart >= shotStart - 0.3 && dStart < shotEnd + 0.3;
      });
      assigned += shot.dialogue.length;
    }
  }
  return assigned;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Tier 2 — Shot Metadata Analysis`);
  console.log(`  ${EPISODE_ID} | Model: ${MODEL} | Region: ${REGION}`);
  if (SCENE_FILTER) console.log(`  Filter: Scene ${SCENE_FILTER}`);
  if (SHOT_FILTER) console.log(`  Filter: Shot ${SHOT_FILTER}`);
  console.log(`${'═'.repeat(60)}\n`);

  const scenes = loadScenes();
  const shotsToAnalyze = getShotsToAnalyze(scenes);

  if (shotsToAnalyze.length === 0) {
    console.log('✅ No shots need Tier 2 analysis (all already have data, or filter matched nothing)');
    return;
  }

  console.log(`📊 ${shotsToAnalyze.length} shots to analyze in ${Math.ceil(shotsToAnalyze.length / BATCH_SIZE)} batch(es)`);

  // Check frames exist
  let missingFrames = 0;
  for (const s of shotsToAnalyze) {
    if (!fs.existsSync(s.firstFrame)) missingFrames++;
    if (!fs.existsSync(s.lastFrame)) missingFrames++;
  }
  if (missingFrames > 0) {
    console.log(`⚠️  ${missingFrames} frame images missing — those shots will have limited analysis`);
  }

  // Process in batches
  const batches = [];
  for (let i = 0; i < shotsToAnalyze.length; i += BATCH_SIZE) {
    batches.push(shotsToAnalyze.slice(i, i + BATCH_SIZE));
  }

  let totalAnalyzed = 0;
  let totalCost = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const firstShot = batch[0].shot.shotNumber;
    const lastShot = batch[batch.length - 1].shot.shotNumber;

    console.log(`\n📦 Batch ${b + 1}/${batches.length}: ${batch.length} shots (${firstShot}-${lastShot})`);

    const results = await analyzeBatch(batch);

    if (results) {
      // Merge results back into scenes.json
      for (const result of results) {
        const scene = scenes.find(s => s.sceneNumber === result.sceneNumber);
        if (!scene) continue;
        const shot = scene.shots?.find(s => s.shotNumber === result.shotNumber);
        if (!shot) continue;

        // Apply Tier 2 metadata
        shot.shotType = result.shotType || shot.shotType;
        shot.subject = result.subject || shot.subject;
        shot.action = result.action || shot.action;
        shot.characterExpressions = result.characterExpressions || shot.characterExpressions;
        shot.cameraMovement = result.cameraMovement || shot.cameraMovement;
        shot.tags = result.tags || shot.tags;
        shot.supercutPotential = result.supercutPotential || shot.supercutPotential;
        shot._tier = 2;

        totalAnalyzed++;
      }
      console.log(`   📊 ${results.length} shots enriched`);
    } else {
      console.log(`   ❌ Batch failed`);
    }

    // Cooldown between batches
    if (b < batches.length - 1) {
      console.log(`   ⏳ Cooldown 10s...`);
      await sleep(10000);
    }
  }

  // Match dialogue from Tier 1 to shots
  console.log(`\n💬 Matching dialogue to shots...`);
  const dialogueAssigned = assignDialogueToShots(scenes);
  console.log(`   ✅ ${dialogueAssigned} dialogue lines assigned to shots`);

  // Save updated scenes.json
  fs.writeFileSync(path.join(OUT_DIR, 'scenes.json'), JSON.stringify(scenes, null, 2));
  console.log(`\n💾 Saved scenes.json with Tier 2 data`);

  // Cost summary
  try {
    const ledger = JSON.parse(fs.readFileSync(COST_LEDGER, 'utf-8'));
    const tier2Cost = ledger.filter(e => e.tier === 2).reduce((s, e) => s + e.cost, 0);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ✅ Tier 2 Complete!`);
    console.log(`  ${totalAnalyzed} shots enriched | ${dialogueAssigned} dialogue lines`);
    console.log(`  Tier 2 cost: $${tier2Cost.toFixed(4)}`);
    console.log(`${'═'.repeat(60)}\n`);
  } catch {}

  // Rebuild scene review report
  console.log(`📝 Rebuilding Scene Review Report...`);
  try {
    const mediaDir = process.env.MEDIA_DIR;
    const mediaFiles = fs.readdirSync(mediaDir);
    const epMatch = EPISODE_ID.match(/S(\d+)E(\d+)/i);
    if (epMatch) {
      const videoFile = mediaFiles.find(f => new RegExp('s0?' + epMatch[1] + 'e0?' + epMatch[2], 'i').test(f) && f.endsWith('.mp4'));
      if (videoFile) {
        const videoPath = path.join(mediaDir, videoFile);
        execSync(`node "${path.join(__dirname, 'rebuild-report.mjs')}" "${EPISODE_ID}" "${videoPath}"`, {
          cwd: __dirname, stdio: 'inherit', timeout: 60000,
          env: { ...process.env, VSTACK_NO_OPEN: '1' }
        });
        console.log(`✅ Report rebuilt`);
      }
    }
  } catch (e) {
    console.log(`⚠️  Report rebuild failed: ${e.message?.slice(0, 80)}`);
  }
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
