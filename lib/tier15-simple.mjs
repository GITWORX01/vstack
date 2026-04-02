#!/usr/bin/env node
/**
 * Tier 1.5 Simple — Speaker Attribution via Shot Subjects + Gemini Text Fallback
 *
 * Step 1 (FREE): If shot subject is a single character → they're the speaker
 * Step 2 (~$0.02/ep): For remaining "Unknown", Gemini text-only guesses from context
 *
 * Usage:
 *   node tier15-simple.mjs S02E01
 *   node tier15-simple.mjs S02E01 --no-gemini    # Skip Step 2 (free only)
 *   node tier15-simple.mjs S02E01 --region us-east1
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

// Config
const PROJECT = process.env.GCP_PROJECT;
const GCLOUD_PATH = process.env.GCLOUD_PATH || 'C:/Users/steve/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin';
const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');

const args = process.argv.slice(2);
const EPISODE_ID = args[0];
const NO_GEMINI = args.includes('--no-gemini');
const REGION = (args.find(a => a === '--region') ? args[args.indexOf('--region') + 1] : null) || 'us-east1';

if (!EPISODE_ID) { console.error('Usage: node tier15-simple.mjs EPISODE_ID [--no-gemini]'); process.exit(1); }

const OUT_DIR = path.join(ANALYSIS_DIR, EPISODE_ID);
const LOG_FILE = path.join(OUT_DIR, 'tier15.log');
const STATUS_FILE = path.join(OUT_DIR, '_tier15-status.json');
const COST_LEDGER = path.join(OUT_DIR, 'cost-ledger.json');

function parseTs(ts) { if (!ts || typeof ts !== 'string') return 0; const [m, s] = ts.split(':'); return parseInt(m) * 60 + parseFloat(s); }
function fmtTs(sec) { const m = Math.floor(sec / 60), s = sec % 60; return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0'); }
function log(msg) { console.log(msg); fs.appendFileSync(LOG_FILE, msg + '\n'); }
function writeStatus(data) { fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...data, episodeId: EPISODE_ID, heartbeat: new Date().toISOString() })); }

function getToken() {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return execSync(`"${path.join(GCLOUD_PATH, 'gcloud' + ext)}" auth print-access-token`, { encoding: 'utf-8' }).trim();
}

async function main() {
  fs.writeFileSync(LOG_FILE, '');
  const startTime = Date.now();

  log(`${'═'.repeat(60)}`);
  log(`  Tier 1.5 Simple — Speaker Attribution`);
  log(`  ${EPISODE_ID} | Method: Shot subjects + Gemini text fallback`);
  log(`${'═'.repeat(60)}\n`);

  writeStatus({ phase: 'starting' });

  const scenes = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'scenes.json'), 'utf-8'));

  // ── Step 1: Assign speakers from shot subjects (FREE) ──────────────
  log(`🎯 Step 1: Assigning speakers from shot subjects (FREE)...`);
  writeStatus({ phase: 'subjects', step: 'Matching shot subjects to dialogue' });

  let subjectAssigned = 0;
  let totalDialogue = 0;

  for (const sc of scenes) {
    const sceneChars = new Set();
    for (const char of (sc.characters || [])) {
      sceneChars.add(char);
      sceneChars.add(char.replace(/^(Captain|Commander|Lt\.\s*Commander|Lt\.|Lieutenant|Dr\.|Doctor|Counselor|Ensign|Chief)\s+/i, '').trim());
    }

    for (const sh of (sc.shots || [])) {
      if (!sh.dialogue?.length) continue;

      const subject = sh.subject || '';
      // Check if subject is a single character (not group/multi)
      const isSingleChar = subject && !subject.includes(',') && !subject.toLowerCase().includes(' and ') && !subject.toLowerCase().includes('crew') && !subject.toLowerCase().includes('group');

      // Normalize subject name
      let charName = null;
      if (isSingleChar) {
        const normalized = subject.replace(/^(Captain|Commander|Lt\.\s*Commander|Lt\.|Lieutenant|Dr\.|Doctor|Counselor|Ensign|Chief)\s+/i, '').trim();
        // Verify this character is in the scene
        if (sceneChars.has(normalized) || sceneChars.has(subject)) {
          charName = normalized;
        }
      }

      for (const d of sh.dialogue) {
        totalDialogue++;
        if (d.speaker === 'Unknown' && charName) {
          // Only assign if it's a close-up or medium shot (more likely the subject is speaking)
          const isCloseShot = ['close-up', 'medium close-up', 'extreme-close-up', 'medium'].includes(sh.shotType);
          if (isCloseShot) {
            d.speaker = charName;
            subjectAssigned++;
          }
        }
      }
    }
  }

  log(`  ✅ ${subjectAssigned} lines assigned from shot subjects (${totalDialogue} total)`);

  // Count remaining unknown
  let unknownCount = 0;
  const unknownByScene = {};
  for (const sc of scenes) {
    let sceneUnknown = 0;
    for (const sh of (sc.shots || [])) {
      for (const d of (sh.dialogue || [])) {
        if (d.speaker === 'Unknown') { unknownCount++; sceneUnknown++; }
      }
    }
    if (sceneUnknown > 0) unknownByScene[sc.sceneNumber] = sceneUnknown;
  }
  log(`  Remaining unknown: ${unknownCount} lines across ${Object.keys(unknownByScene).length} scenes`);

  // ── Step 2: Gemini text-only fallback for remaining unknowns ────────
  if (!NO_GEMINI && unknownCount > 0 && PROJECT) {
    log(`\n🤖 Step 2: Gemini text-only speaker guessing (~$0.02)...`);
    writeStatus({ phase: 'gemini', step: 'Text-only speaker attribution' });

    let geminiAssigned = 0;
    let geminiCost = 0;
    let scenesProcessed = 0;

    for (const sc of scenes) {
      // Skip scenes with no unknown dialogue
      const unknownLines = [];
      for (const sh of (sc.shots || [])) {
        for (let di = 0; di < (sh.dialogue || []).length; di++) {
          if (sh.dialogue[di].speaker === 'Unknown') {
            unknownLines.push({ shot: sh, dialogueIndex: di, dlg: sh.dialogue[di] });
          }
        }
      }
      if (unknownLines.length === 0) continue;

      // Build text-only prompt (no video, no images — just scene context + dialogue)
      const characters = (sc.characters || []).join(', ');
      const prompt = `Scene: ${sc.location || '?'}
Characters present: ${characters}
Mood: ${sc.mood || '?'}
Plot: ${sc.plotSignificance || '?'}

These dialogue lines are from this scene. Based on the characters present and the context, identify who most likely says each line. Respond with ONLY a JSON array of speaker names, one per line, in order.

${unknownLines.map((ul, i) => `[${i}] "${ul.dlg.text}"`).join('\n')}

Respond with ONLY a JSON array like: ["Picard", "Riker", "Data", ...]
One entry per line above, in the same order. Use exact character names from the list: ${characters}
If unsure, use "Unknown".`;

      try {
        const token = getToken();
        const baseUrl = REGION === 'global'
          ? `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global`
          : `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}`;
        const url = `${baseUrl}/publishers/google/models/gemini-2.5-pro:generateContent`;

        const body = JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
          labels: { tier: 'tier15', episode: EPISODE_ID.toLowerCase() }
        });

        const tmpReq = path.join(OUT_DIR, '_req_t15.json');
        fs.writeFileSync(tmpReq, body);

        const curlPath = tmpReq.replace(/\\/g, '/');
        const result = execSync(
          `curl -s --max-time 60 "${url}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d @"${curlPath}"`,
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 90000 }
        );
        if (fs.existsSync(tmpReq)) fs.unlinkSync(tmpReq);

        const response = JSON.parse(result);
        if (response.error) {
          log(`  ⚠️  Scene ${sc.sceneNumber}: API error — ${response.error.message?.slice(0, 60)}`);
          continue;
        }

        const usage = response.usageMetadata || {};
        const cost = (usage.promptTokenCount || 0) * 1.25 / 1e6 + ((usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)) * 10 / 1e6;
        geminiCost += cost;

        // Parse response — check ALL parts (thinking may be in separate parts)
        const parts = response.candidates?.[0]?.content?.parts || [];
        let text = parts.map(p => p.text || '').join('\n');
        text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const match = text.match(/\[[\s\S]*\]/);
        let guessCount = 0;
        if (!match) {
          log(`    ⚠️  No JSON array found. TextLen: ${text.length} StartChar: ${text.charCodeAt(0)} Text: ${text.slice(0, 150)}`);
          // Try harder — maybe there are invisible chars
          const stripped = text.replace(/[^\x20-\x7E\n\r]/g, '');
          const retryMatch = stripped.match(/\[[\s\S]*\]/);
          if (retryMatch) {
            log(`    🔄 Retry match succeeded after stripping non-ASCII`);
            const speakers = JSON.parse(retryMatch[0]);
            const sceneCharSet2 = new Set();
            for (const char of (sc.characters || [])) {
              sceneCharSet2.add(char);
              sceneCharSet2.add(char.replace(/^(Captain|Commander|Lt\.\s*Commander|Lt\.|Lieutenant|Dr\.|Doctor|Counselor|Ensign|Chief)\s+/i, '').trim());
            }
            for (let i = 0; i < Math.min(speakers.length, unknownLines.length); i++) {
              const speaker = speakers[i];
              if (!speaker || speaker === 'Unknown') continue;
              const speakerLower = speaker.toLowerCase();
              let matchedChar = null;
              if (sceneCharSet2.has(speaker)) matchedChar = speaker;
              if (!matchedChar) {
                for (const c of (sc.characters || [])) {
                  const cLower = c.toLowerCase();
                  if (cLower.includes(speakerLower) || speakerLower.includes(cLower)) { matchedChar = c; break; }
                  const cNorm = c.replace(/^(Captain|Commander|Lt\.\s*Commander|Lt\.|Lieutenant|Dr\.|Doctor|Counselor|Ensign|Chief)\s+/i, '').trim().toLowerCase();
                  if (cNorm.includes(speakerLower) || speakerLower.includes(cNorm)) { matchedChar = c; break; }
                }
              }
              if (matchedChar) { unknownLines[i].dlg.speaker = matchedChar; geminiAssigned++; guessCount++; }
            }
          }
        } else {
          const speakers = JSON.parse(match[0]);
          guessCount = speakers.length;
          // Validate against scene characters
          const sceneCharSet = new Set();
          for (const char of (sc.characters || [])) {
            sceneCharSet.add(char);
            sceneCharSet.add(char.replace(/^(Captain|Commander|Lt\.\s*Commander|Lt\.|Lieutenant|Dr\.|Doctor|Counselor|Ensign|Chief)\s+/i, '').trim());
          }

          for (let i = 0; i < Math.min(speakers.length, unknownLines.length); i++) {
            let speaker = speakers[i];
            if (!speaker || speaker === 'Unknown') continue;

            // Find matching character name from scene list
            const speakerLower = speaker.toLowerCase();
            let matchedChar = null;

            // Exact match
            if (sceneCharSet.has(speaker)) { matchedChar = speaker; }

            // Scene char contains Gemini name OR Gemini name contains scene char
            if (!matchedChar) {
              for (const c of (sc.characters || [])) {
                const cLower = c.toLowerCase();
                if (cLower.includes(speakerLower) || speakerLower.includes(cLower)) {
                  matchedChar = c; break;
                }
                // Also check normalized (strip titles)
                const cNorm = c.replace(/^(Captain|Commander|Lt\.\s*Commander|Lt\.|Lieutenant|Dr\.|Doctor|Counselor|Ensign|Chief)\s+/i, '').trim().toLowerCase();
                if (cNorm.includes(speakerLower) || speakerLower.includes(cNorm)) {
                  matchedChar = c; break;
                }
              }
            }

            if (matchedChar) {
              unknownLines[i].dlg.speaker = matchedChar;
              geminiAssigned++;
            }
          }
        }

        scenesProcessed++;
        log(`  Scene ${sc.sceneNumber}: ${unknownLines.length} lines → ${guessCount} guesses ($${cost.toFixed(4)})`);

        // Save after each scene (incremental — survives interruption)
        fs.writeFileSync(path.join(OUT_DIR, 'scenes.json'), JSON.stringify(scenes, null, 2));

        // Small cooldown
        if (scenesProcessed < Object.keys(unknownByScene).length) {
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (err) {
        log(`  ⚠️  Scene ${sc.sceneNumber}: ${err.message?.slice(0, 60)}`);
      }
    }

    log(`  ✅ ${geminiAssigned} more lines assigned by Gemini ($${geminiCost.toFixed(4)} total)`);

    // Log cost
    try {
      let ledger = [];
      try { ledger = JSON.parse(fs.readFileSync(COST_LEDGER, 'utf-8')); } catch {}
      ledger.push({ label: 'tier15-simple-gemini', tier: 1.5, cost: geminiCost, timestamp: new Date().toISOString() });
      fs.writeFileSync(COST_LEDGER, JSON.stringify(ledger, null, 2));
    } catch {}
  } else if (NO_GEMINI) {
    log(`\n⏭️  Step 2 skipped (--no-gemini)`);
  } else if (!PROJECT) {
    log(`\n⏭️  Step 2 skipped (no GCP_PROJECT)`);
  }

  // Save
  fs.writeFileSync(path.join(OUT_DIR, 'scenes.json'), JSON.stringify(scenes, null, 2));

  // Final stats
  let finalNamed = 0, finalUnknown = 0;
  for (const sc of scenes) {
    for (const sh of (sc.shots || [])) {
      for (const d of (sh.dialogue || [])) {
        if (d.speaker !== 'Unknown') finalNamed++; else finalUnknown++;
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log(`\n${'═'.repeat(60)}`);
  log(`  ✅ Tier 1.5 Simple Complete!`);
  log(`  Named: ${finalNamed} | Unknown: ${finalUnknown} | Total: ${finalNamed + finalUnknown}`);
  log(`  Time: ${elapsed}s`);
  log(`${'═'.repeat(60)}\n`);

  writeStatus({ phase: 'complete', named: finalNamed, unknown: finalUnknown, elapsed: elapsed + 's' });

  // Rebuild DB + report
  log(`📝 Rebuilding...`);
  try {
    execSync(`node "${path.join(__dirname, 'db.mjs')}" --rebuild ${EPISODE_ID}`, { cwd: __dirname, stdio: 'pipe', timeout: 30000 });
    log(`  ✅ Database updated`);
  } catch (e) { log(`  ⚠️  DB: ${e.message?.slice(0, 60)}`); }

  // Find video for report rebuild
  const settingsPath = path.join(OUT_DIR, 'settings.json');
  let videoPath = null;
  if (fs.existsSync(settingsPath)) {
    try { videoPath = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).videoPath; } catch {}
  }
  if (videoPath) {
    try {
      execSync(`node "${path.join(__dirname, 'rebuild-report.mjs')}" "${EPISODE_ID}" "${videoPath}"`, {
        cwd: __dirname, stdio: 'pipe', timeout: 60000, env: { ...process.env, VSTACK_NO_OPEN: '1' }
      });
      log(`  ✅ Report rebuilt`);
    } catch (e) { log(`  ⚠️  Report: ${e.message?.slice(0, 60)}`); }
  }
}

main().catch(err => {
  log(`\n❌ Fatal: ${err.message}`);
  writeStatus({ phase: 'failed', error: err.message?.slice(0, 200) });
  process.exit(1);
});
