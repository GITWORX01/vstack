#!/usr/bin/env node
/**
 * Rebuild Scene Review Report from existing scenes.json data.
 *
 * Generates an interactive HTML report with scene/shot thumbnails,
 * timestamp adjustment controls, and live frame preview via the frame server.
 *
 * Usage:
 *   node rebuild-report.mjs EPISODE_ID "path/to/video.mp4"
 *
 * Requires a vstack.config.json in the current working directory.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getConfig, getFFprobePath } from './config.mjs';
import { fmtTs, fmtTsMs, getVideoDuration } from './utils.mjs';

// ── Args ─────────────────────────────────────────────────────────────

const EPISODE_ID = process.argv[2];
const LOCAL_FILE = process.argv[3];

if (!EPISODE_ID) {
  console.error('Usage: node rebuild-report.mjs EPISODE_ID ["path/to/video.mp4"]');
  process.exit(1);
}

// ── Config ───────────────────────────────────────────────────────────

const cfg = getConfig();
const OUTPUT_DIR = path.join(cfg.projectDir, EPISODE_ID);
const FRAME_SERVER_PORT = cfg.frameServerPort;

if (!fs.existsSync(path.join(OUTPUT_DIR, 'scenes.json'))) {
  console.error(`scenes.json not found in ${OUTPUT_DIR}`);
  console.error('Run analyze-episode.mjs first.');
  process.exit(1);
}

// ── Load Data ────────────────────────────────────────────────────────

const allScenes = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'scenes.json'), 'utf-8'));

let cutPointCount = 0;
const cutPointsFile = path.join(OUTPUT_DIR, 'cut-points.json');
if (fs.existsSync(cutPointsFile)) {
  cutPointCount = JSON.parse(fs.readFileSync(cutPointsFile, 'utf-8')).length;
}

const totalShots = allScenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);

let duration = 0;
if (LOCAL_FILE) {
  try {
    duration = getVideoDuration(LOCAL_FILE);
  } catch { /* duration stays 0 */ }
}

const generatedAt = new Date().toISOString();
const videoFileName = LOCAL_FILE ? path.basename(LOCAL_FILE) : 'unknown';

console.log(`Rebuilding report for ${EPISODE_ID}: ${allScenes.length} scenes, ${totalShots} shots`);

// ── Format Helpers ───────────────────────────────────────────────────

/**
 * Format seconds to MM:SS.sss for the report display.
 * @param {number} secs
 * @returns {string}
 */
function formatTs(secs) {
  return fmtTsMs(secs);
}

// ── Build Scenes HTML ────────────────────────────────────────────────

let scenesHtml = '';
for (const scene of allScenes) {
  const creditsClass = scene.isCredits ? ' credits' : '';
  const creditsBadge = scene.isCredits ? ' <span class="pill credits-badge">CREDITS</span>' : '';
  scenesHtml += `<div class="scene${creditsClass}"><div class="scene-hdr"><h2>Scene ${scene.sceneNumber}${creditsBadge}</h2>
    <span class="pill tm">${scene.startTimestamp || '?'} -> ${scene.endTimestamp || '?'}</span>
    <span class="pill loc">${scene.location || '?'}</span>
    <span class="pill mood">${scene.mood || '?'}</span>
    <span class="pill chr">${(scene.characters || []).join(', ')}</span></div>
    <div class="plot">${scene.plotSignificance || ''}</div><div class="shots">`;

  for (const shot of (scene.shots || [])) {
    const startSec = shot._snappedStart || 0;
    const endSec = shot._snappedEnd || 0;
    const dur = (endSec - startSec).toFixed(1);
    const tc = (shot.shotType || '').includes('close') ? 'tc' : (shot.shotType || '').includes('medium') ? 'tm2' : (shot.shotType || '').includes('wide') ? 'tw' : 'to';
    const exprs = shot.characterExpressions ? Object.entries(shot.characterExpressions).map(([k, v]) => `<b>${k}:</b> ${v}`).join(' &middot; ') : '';

    scenesHtml += `<div class="shot"><div class="fw"><img src="frames/${shot._frameFirst || ''}" /><div class="fl fg">${formatTs(startSec)}</div></div>
      <div class="fw"><img src="frames/${shot._frameLast || ''}" /><div class="fl fr">${formatTs(endSec)}</div></div>
      <div class="si"><div class="sh"><h4>Shot ${shot.shotNumber} <span class="st ${tc}">${shot.shotType || '?'}</span></h4>
      <span class="tt">${formatTs(startSec)} -> ${formatTs(endSec)}</span></div>
      <div class="dr">${dur}s</div>
      <div class="f"><span class="fl2">Subject</span><div class="subj">${shot.subject || '?'}</div></div>
      <div class="f"><span class="fl2">Action</span><div>${shot.action || '?'}</div></div>
      ${shot.cameraMovement ? `<div class="f"><span class="fl2">Camera</span><div class="cam">${shot.cameraMovement}</div></div>` : ''}
      ${exprs ? `<div class="f"><span class="fl2">Expressions</span><div>${exprs}</div></div>` : ''}
      ${shot.dialogue?.length ? `<div class="f dialogue"><span class="fl2">Dialogue</span><div class="dialogue-lines">${shot.dialogue.map(d => {
        if (typeof d === 'string') return `<div class="dl">"${d}"</div>`;
        const speaker = d.speaker ? `<span class="dl-speaker">${d.speaker}:</span> ` : '';
        const ts = d.start ? `<span class="dl-ts">${fmtTs(parseFloat(d.start))}</span>` : '';
        return `<div class="dl">${ts}${speaker}"${d.text}"</div>`;
      }).join('')}</div></div>` : ''}
      ${(shot.tags || []).length ? '<div class="tgs">' + shot.tags.map(t => '<span class="tag">' + t + '</span>').join('') + '</div>' : ''}
      ${(shot.supercutPotential || []).length ? '<div class="tgs">' + shot.supercutPotential.map(t => '<span class="stag">' + t + '</span>').join('') + '</div>' : ''}
      <div class="adj" data-scene="${scene.sceneNumber}" data-shot="${shot.shotNumber}" data-start="${startSec.toFixed(3)}" data-end="${endSec.toFixed(3)}" data-edge="start">
        <span class="adj-label">START</span>
        <button onclick="adjustShot(this,-100,'start')">-100ms</button>
        <button onclick="adjustShot(this,-50,'start')">-50</button>
        <button onclick="adjustShot(this,-10,'start')">-10</button>
        <span class="adj-val" id="adj-start-s${scene.sceneNumber}-sh${shot.shotNumber}">+/-0ms</span>
        <button onclick="adjustShot(this,10,'start')">+10</button>
        <button onclick="adjustShot(this,50,'start')">+50</button>
        <button onclick="adjustShot(this,100,'start')">+100ms</button>
        <span class="adj-ts" id="adjts-start-s${scene.sceneNumber}-sh${shot.shotNumber}">${formatTs(startSec)}</span>
      </div>
      <div class="adj" data-scene="${scene.sceneNumber}" data-shot="${shot.shotNumber}" data-start="${startSec.toFixed(3)}" data-end="${endSec.toFixed(3)}" data-edge="end">
        <span class="adj-label">END</span>
        <button onclick="adjustShot(this,-100,'end')">-100ms</button>
        <button onclick="adjustShot(this,-50,'end')">-50</button>
        <button onclick="adjustShot(this,-10,'end')">-10</button>
        <span class="adj-val" id="adj-end-s${scene.sceneNumber}-sh${shot.shotNumber}">+/-0ms</span>
        <button onclick="adjustShot(this,10,'end')">+10</button>
        <button onclick="adjustShot(this,50,'end')">+50</button>
        <button onclick="adjustShot(this,100,'end')">+100ms</button>
        <span class="adj-ts" id="adjts-end-s${scene.sceneNumber}-sh${shot.shotNumber}">${formatTs(endSec)}</span>
      </div>
      <div class="live-preview" id="preview-s${scene.sceneNumber}-sh${shot.shotNumber}" style="display:none">
        <div class="live-frames">
          <div class="live-frame-box"><img class="live-img" id="liveimg-start-s${scene.sceneNumber}-sh${shot.shotNumber}" /><div class="live-edge-label">START</div></div>
          <div class="live-frame-box"><img class="live-img" id="liveimg-end-s${scene.sceneNumber}-sh${shot.shotNumber}" /><div class="live-edge-label">END</div></div>
        </div>
        <div class="live-actions">
          <button class="lock-btn" onclick="lockShot('${scene.sceneNumber}','${shot.shotNumber}')">Lock In</button>
        </div>
      </div>
      </div></div>`;
  }

  if (!scene.shots || scene.shots.length === 0) {
    scenesHtml += `<div style="padding:12px;color:#666;font-style:italic">No shot data available for this scene</div>`;
  }

  scenesHtml += '</div></div>';
}

// ── Build Full HTML ──────────────────────────────────────────────────

const escapedLocalFile = LOCAL_FILE ? LOCAL_FILE.replace(/\\/g, '\\\\') : '';

const html = `<!DOCTYPE html><html><head><title>${EPISODE_ID} -- Scene Review Report</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0a0a1a;color:#e0e0e0;padding:20px 20px 60px;max-width:1300px;margin:0 auto}
h1{color:#4fc3f7;margin-bottom:5px}.sub{color:#888;margin-bottom:24px}
.stats{background:#1a1a2e;border-radius:10px;padding:16px 20px;margin-bottom:24px;display:flex;gap:30px;flex-wrap:wrap}
.stat{text-align:center}.stat-val{font-size:28px;font-weight:bold;color:#4fc3f7}.stat-lbl{font-size:11px;color:#888}
details.settings{background:#1a1a2e;border-radius:10px;margin-bottom:24px;overflow:hidden}
details.settings summary{padding:12px 20px;cursor:pointer;color:#888;font-size:13px;user-select:none}
details.settings summary:hover{color:#4fc3f7}
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#222;padding:1px}
.settings-section{background:#12122a;padding:14px 18px}
.settings-section h3{color:#4fc3f7;font-size:13px;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px}
.setting{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a1a2e;font-size:12px}
.setting-key{color:#888}.setting-val{color:#e0e0e0;font-family:monospace;font-size:11px}
.scene{background:#12122a;border-radius:12px;padding:20px;margin-bottom:20px;border-left:4px solid #4fc3f7}
.scene.credits{border-left-color:#666;opacity:0.7}
.scene.credits:hover{opacity:1}
.credits-badge{background:#666!important;color:#fff;font-weight:bold}
.scene-hdr{margin-bottom:12px}.scene-hdr h2{color:#4fc3f7;font-size:18px;margin-bottom:6px}
.pill{display:inline-block;background:#1a1a3e;padding:3px 10px;border-radius:6px;font-size:12px;margin-right:8px}
.tm{color:#ff9800;font-family:monospace}.loc{color:#81c784}.mood{color:#ffb74d;font-style:italic}.chr{color:#ce93d8}
.plot{color:#aaa;font-size:13px;line-height:1.5}
.shots{display:flex;flex-direction:column;gap:8px;margin-top:14px}
.shot{display:grid;grid-template-columns:160px 160px 1fr;gap:0;background:#1a1a2e;border-radius:8px;overflow:hidden;border-left:3px solid #333}
.shot:hover{border-left-color:#4fc3f7}
.fw{position:relative}.fw img{width:160px;height:auto;display:block}
.fl{position:absolute;bottom:2px;left:2px;background:rgba(0,0,0,.8);color:#fff;font-size:8px;padding:1px 4px;border-radius:2px;font-family:monospace}
.fg{color:#4caf50}.fr{color:#e94560}
.si{padding:8px 12px;font-size:11px;line-height:1.5}
.sh{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.sh h4{color:#4fc3f7;font-size:12px}.st{padding:1px 6px;border-radius:3px;font-size:9px;font-weight:bold}
.tc{background:#e94560;color:#fff}.tm2{background:#ff9800;color:#000}.tw{background:#4caf50;color:#000}.to{background:#555;color:#fff}
.tt{color:#ff9800;font-family:monospace;font-size:10px}.dr{color:#888;font-size:10px;margin-bottom:4px}
.f{margin-bottom:3px}.fl2{color:#555;font-size:8px;text-transform:uppercase}
.subj{color:#ce93d8;font-weight:bold}.cam{color:#81c784}
.dialogue{margin-top:4px;border-left:2px solid #ffb300;padding-left:8px}
.dialogue-lines{font-size:12px;color:#ffe082;font-style:italic}
.dl{margin-bottom:2px}.dl-ts{color:#888;font-family:monospace;font-size:9px;margin-right:6px;font-style:normal}
.dl-speaker{color:#4fc3f7;font-weight:bold;font-style:normal}
.tgs{margin-top:4px}.tag{display:inline-block;background:#333;padding:0 4px;border-radius:2px;font-size:9px;margin:1px}
.stag{display:inline-block;background:#1b5e20;padding:0 4px;border-radius:2px;font-size:9px;margin:1px;color:#a5d6a7}
.nav{position:sticky;top:0;background:#0a0a1a;padding:8px 0;z-index:10;border-bottom:1px solid #333;margin-bottom:16px}
.nav select{background:#1a1a2e;color:#eee;border:1px solid #444;padding:6px;border-radius:4px;font-size:13px}
.adj{display:flex;align-items:center;gap:4px;margin-top:4px;padding:4px 6px;background:#0f0f23;border-radius:4px;font-size:10px}
.adj button{background:#333;color:#eee;border:none;padding:2px 6px;border-radius:3px;cursor:pointer;font-size:10px;font-family:monospace}
.adj button:hover{background:#4fc3f7;color:#000}
.adj .adj-val{color:#4caf50;font-family:monospace;min-width:50px;text-align:center}
.adj .adj-label{color:#666;font-size:9px}
.adj .adj-ts{color:#888;font-family:monospace;font-size:9px;margin-left:8px}
.adj-modified{border-left-color:#ff9800 !important}
.live-preview{margin-top:8px;padding:8px;background:#0d0d20;border-radius:6px;border:1px solid #333}
.live-preview .live-frames{display:flex;gap:10px}
.live-preview .live-frame-box{position:relative;flex:1}
.live-preview .live-img{width:100%;height:auto;border-radius:4px;border:2px solid #ff9800;transition:opacity 0.15s}
.live-preview .live-edge-label{position:absolute;top:4px;left:4px;background:#ff9800;color:#000;font-size:9px;padding:1px 6px;border-radius:3px;font-weight:bold}
.live-preview .live-actions{margin-top:8px;text-align:center}
.lock-btn{background:#4caf50;color:#fff;border:none;padding:6px 20px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold}
.lock-btn:hover{background:#66bb6a}
.shot.locked{opacity:0.7;border-left-color:#4caf50 !important}
.shot.locked .adj button{pointer-events:none;opacity:0.3}
.shot.locked .lock-btn{background:#333;color:#888;cursor:default}
.shot.locked .lock-btn::after{content:' (locked)'}
.unlock-btn{background:#ff5722;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:10px;margin-left:8px}
.unlock-btn:hover{background:#ff7043}
.corrections-bar{position:fixed;bottom:0;left:0;right:0;background:#0f3460;padding:10px 20px;display:flex;justify-content:space-between;align-items:center;z-index:20;font-size:13px}
.corrections-bar button{background:#e94560;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:13px}
.corrections-bar button:hover{background:#c73e54}
</style></head><body>
<h1>${EPISODE_ID} -- Scene Review Report</h1>
<p class="sub">Full scene &amp; shot metadata with frame-precise timestamps</p>

<div class="stats">
<div class="stat"><div class="stat-val">${allScenes.length}</div><div class="stat-lbl">Scenes</div></div>
<div class="stat"><div class="stat-val">${totalShots}</div><div class="stat-lbl">Shots</div></div>
<div class="stat"><div class="stat-val">${(totalShots / Math.max(allScenes.length, 1)).toFixed(1)}</div><div class="stat-lbl">Avg Shots/Scene</div></div>
${duration > 0 ? `<div class="stat"><div class="stat-val">${(duration / 60).toFixed(1)}</div><div class="stat-lbl">Minutes</div></div>` : ''}
</div>

<details class="settings">
<summary>Generation Settings &amp; Parameters</summary>
<div class="settings-grid">
  <div class="settings-section">
    <h3>Analysis Parameters</h3>
    <div class="setting"><span class="setting-key">Model</span><span class="setting-val">${cfg.model}</span></div>
    <div class="setting"><span class="setting-key">Region</span><span class="setting-val">${cfg.gcpRegion}</span></div>
    <div class="setting"><span class="setting-key">Media Resolution</span><span class="setting-val">${cfg.mediaResolution}</span></div>
    <div class="setting"><span class="setting-key">Temperature</span><span class="setting-val">${cfg.temperature}</span></div>
    <div class="setting"><span class="setting-key">Max Output Tokens</span><span class="setting-val">${cfg.maxOutputTokens.toLocaleString()}</span></div>
    <div class="setting"><span class="setting-key">Chunk Size</span><span class="setting-val">${cfg.chunkMinutes} minutes</span></div>
    ${duration > 0 ? `<div class="setting"><span class="setting-key">Chunks Processed</span><span class="setting-val">${Math.ceil(duration / 60 / cfg.chunkMinutes)}</span></div>` : ''}
  </div>
  <div class="settings-section">
    <h3>Post-Processing</h3>
    <div class="setting"><span class="setting-key">Scene Threshold</span><span class="setting-val">${cfg.sceneDetectThreshold}</span></div>
    <div class="setting"><span class="setting-key">Cut Points Detected</span><span class="setting-val">${cutPointCount}</span></div>
    <div class="setting"><span class="setting-key">Snap Tolerance</span><span class="setting-val">${cfg.snapMaxDistance} seconds</span></div>
    <div class="setting"><span class="setting-key">Frame Extraction</span><span class="setting-val">First + Last per shot</span></div>
    <div class="setting"><span class="setting-key">Frame Resolution</span><span class="setting-val">320px wide, JPEG q:v 3</span></div>
  </div>
  <div class="settings-section">
    <h3>Source</h3>
    <div class="setting"><span class="setting-key">Episode</span><span class="setting-val">${EPISODE_ID}</span></div>
    <div class="setting"><span class="setting-key">File</span><span class="setting-val">${videoFileName}</span></div>
    ${duration > 0 ? `<div class="setting"><span class="setting-key">Duration</span><span class="setting-val">${(duration / 60).toFixed(1)} minutes</span></div>` : ''}
    <div class="setting"><span class="setting-key">Generated At</span><span class="setting-val">${generatedAt}</span></div>
  </div>
  <div class="settings-section">
    <h3>Metadata Schema</h3>
    <div class="setting"><span class="setting-key">Scene Fields</span><span class="setting-val">sceneNumber, timestamps, location, characters, mood, plotSignificance</span></div>
    <div class="setting"><span class="setting-key">Shot Fields</span><span class="setting-val">shotNumber, timestamps, shotType, subject, action, characterExpressions, cameraMovement, tags, supercutPotential</span></div>
  </div>
</div>
</details>

<div class="nav"><label>Jump to: </label><select onchange="document.getElementById('sc-'+this.value)?.scrollIntoView({behavior:'smooth'})">
<option value="">--</option>${allScenes.map(s => `<option value="${s.sceneNumber}">Scene ${s.sceneNumber} (${s.startTimestamp || '?'}) ${(s.location || '').slice(0, 30)}</option>`).join('')}
</select></div>

${scenesHtml}

<div class="corrections-bar">
  <span>Corrections: <span id="correction-count">0</span> shots adjusted</span>
  <div>
    <button onclick="resetAll()">Reset All</button>
    <button onclick="exportCorrections()">Export Corrections</button>
  </div>
</div>

<script>
const corrections = {};
const lockedShots = new Set();
const FRAME_SERVER = 'http://localhost:${FRAME_SERVER_PORT}';
const EPISODE_FILE = '${escapedLocalFile}';
let frameServerOnline = false;

fetch(FRAME_SERVER + '/health').then(r => r.json()).then(() => {
  frameServerOnline = true;
  console.log('Frame server connected');
}).catch(() => {
  console.warn('Frame server not running. Start it with: node lib/frame-server.mjs');
});

let debounceTimers = {};

function adjustShot(btn, deltaMs, edge) {
  const adj = btn.closest('.adj');
  const scene = adj.dataset.scene;
  const shot = adj.dataset.shot;
  const key = 'sc' + scene + '_sh' + shot;
  if (lockedShots.has(key)) return;
  const origStart = parseFloat(adj.dataset.start);
  const origEnd = parseFloat(adj.dataset.end);
  if (!corrections[key]) corrections[key] = { scene, shot, origStart, origEnd, startOffsetMs: 0, endOffsetMs: 0 };
  if (edge === 'start') { corrections[key].startOffsetMs += deltaMs; } else { corrections[key].endOffsetMs += deltaMs; }
  const startOffset = corrections[key].startOffsetMs;
  const endOffset = corrections[key].endOffsetMs;
  const newStart = origStart + startOffset / 1000;
  const newEnd = origEnd + endOffset / 1000;
  const startDisplay = document.getElementById('adj-start-s' + scene + '-sh' + shot);
  if (startDisplay) { startDisplay.textContent = (startOffset >= 0 ? '+' : '') + startOffset + 'ms'; startDisplay.style.color = startOffset === 0 ? '#4caf50' : '#ff9800'; }
  const endDisplay = document.getElementById('adj-end-s' + scene + '-sh' + shot);
  if (endDisplay) { endDisplay.textContent = (endOffset >= 0 ? '+' : '') + endOffset + 'ms'; endDisplay.style.color = endOffset === 0 ? '#4caf50' : '#ff9800'; }
  const startTs = document.getElementById('adjts-start-s' + scene + '-sh' + shot);
  if (startTs) { const m = Math.floor(newStart / 60); const s = newStart % 60; startTs.textContent = String(m).padStart(2,'0') + ':' + s.toFixed(3).padStart(6,'0'); startTs.style.color = startOffset === 0 ? '#888' : '#ff9800'; }
  const endTs = document.getElementById('adjts-end-s' + scene + '-sh' + shot);
  if (endTs) { const m = Math.floor(newEnd / 60); const s = newEnd % 60; endTs.textContent = String(m).padStart(2,'0') + ':' + s.toFixed(3).padStart(6,'0'); endTs.style.color = endOffset === 0 ? '#888' : '#ff9800'; }
  const shotCard = btn.closest('.shot');
  if (startOffset !== 0 || endOffset !== 0) { shotCard.classList.add('adj-modified'); } else { shotCard.classList.remove('adj-modified'); delete corrections[key]; }
  updateCount();
  if (frameServerOnline) { clearTimeout(debounceTimers[key]); debounceTimers[key] = setTimeout(() => fetchLiveFrames(scene, shot, newStart, newEnd), 200); }
}

function fetchLiveFrames(scene, shot, startSec, endSec) {
  const previewDiv = document.getElementById('preview-s' + scene + '-sh' + shot);
  const startImg = document.getElementById('liveimg-start-s' + scene + '-sh' + shot);
  const endImg = document.getElementById('liveimg-end-s' + scene + '-sh' + shot);
  if (!previewDiv) return;
  previewDiv.style.display = 'block';
  const baseUrl = FRAME_SERVER + '/frame?file=' + encodeURIComponent(EPISODE_FILE);
  if (startImg) { startImg.style.opacity = '0.5'; startImg.src = baseUrl + '&t=' + startSec.toFixed(3); startImg.onload = () => { startImg.style.opacity = '1'; }; }
  if (endImg) { endImg.style.opacity = '0.5'; endImg.src = baseUrl + '&t=' + endSec.toFixed(3); endImg.onload = () => { endImg.style.opacity = '1'; }; }
}

function lockShot(scene, shot) {
  const key = 'sc' + scene + '_sh' + shot;
  if (lockedShots.has(key)) return;
  lockedShots.add(key);
  const shotCards = document.querySelectorAll('.shot');
  for (const card of shotCards) {
    const adj = card.querySelector('.adj');
    if (adj && adj.dataset.scene === scene && adj.dataset.shot === shot) {
      card.classList.add('locked');
      const lockBtn = card.querySelector('.lock-btn');
      if (lockBtn) { lockBtn.textContent = 'Locked'; lockBtn.className = 'lock-btn'; const unlockBtn = document.createElement('button'); unlockBtn.className = 'unlock-btn'; unlockBtn.textContent = 'Unlock'; unlockBtn.onclick = () => unlockShot(scene, shot, card); lockBtn.parentNode.appendChild(unlockBtn); }
      setTimeout(() => { const preview = document.getElementById('preview-s' + scene + '-sh' + shot); if (preview) preview.style.display = 'none'; }, 500);
      if (corrections[key] && frameServerOnline) { const origStart = parseFloat(adj.dataset.start); const origEnd = parseFloat(adj.dataset.end); const newStart = origStart + (corrections[key].startOffsetMs || 0) / 1000; const newEnd = origEnd + (corrections[key].endOffsetMs || 0) / 1000; const baseUrl = FRAME_SERVER + '/frame?file=' + encodeURIComponent(EPISODE_FILE); const frameImgs = card.querySelectorAll('.fw img'); if (frameImgs[0]) frameImgs[0].src = baseUrl + '&t=' + newStart.toFixed(3); if (frameImgs[1]) frameImgs[1].src = baseUrl + '&t=' + newEnd.toFixed(3); }
      break;
    }
  }
  updateCount();
}

function unlockShot(scene, shot, card) {
  const key = 'sc' + scene + '_sh' + shot;
  lockedShots.delete(key);
  card.classList.remove('locked');
  const lockBtn = card.querySelector('.lock-btn');
  if (lockBtn) lockBtn.textContent = 'Lock In';
  const unlockBtn = card.querySelector('.unlock-btn');
  if (unlockBtn) unlockBtn.remove();
  updateCount();
}

function updateCount() {
  const corrCount = Object.keys(corrections).length;
  const lockCount = lockedShots.size;
  document.getElementById('correction-count').textContent = corrCount + ' corrections, ' + lockCount + ' locked';
}

function resetAll() {
  for (const key of Object.keys(corrections)) {
    const c = corrections[key];
    const startDisp = document.getElementById('adj-start-s' + c.scene + '-sh' + c.shot);
    const endDisp = document.getElementById('adj-end-s' + c.scene + '-sh' + c.shot);
    if (startDisp) { startDisp.textContent = '+/-0ms'; startDisp.style.color = '#4caf50'; }
    if (endDisp) { endDisp.textContent = '+/-0ms'; endDisp.style.color = '#4caf50'; }
    const startTs = document.getElementById('adjts-start-s' + c.scene + '-sh' + c.shot);
    const endTs = document.getElementById('adjts-end-s' + c.scene + '-sh' + c.shot);
    if (startTs) { startTs.style.color = '#888'; }
    if (endTs) { endTs.style.color = '#888'; }
  }
  document.querySelectorAll('.adj-modified').forEach(el => el.classList.remove('adj-modified'));
  document.querySelectorAll('.locked').forEach(el => el.classList.remove('locked'));
  document.querySelectorAll('.unlock-btn').forEach(el => el.remove());
  document.querySelectorAll('.live-preview').forEach(el => el.style.display = 'none');
  for (const key of Object.keys(corrections)) delete corrections[key];
  lockedShots.clear();
  updateCount();
}

function exportCorrections() {
  const entries = Object.values(corrections).filter(c => c.startOffsetMs !== 0 || c.endOffsetMs !== 0);
  if (entries.length === 0 && lockedShots.size === 0) { alert('No corrections to export.'); return; }
  const lines = entries.map(c => {
    const newStart = (c.origStart + c.startOffsetMs / 1000).toFixed(3);
    const newEnd = (c.origEnd + c.endOffsetMs / 1000).toFixed(3);
    let parts = ['Scene ' + c.scene + ', Shot ' + c.shot + ':'];
    if (c.startOffsetMs !== 0) parts.push('start ' + (c.startOffsetMs >= 0 ? '+' : '') + c.startOffsetMs + 'ms (' + c.origStart.toFixed(3) + 's -> ' + newStart + 's)');
    if (c.endOffsetMs !== 0) parts.push('end ' + (c.endOffsetMs >= 0 ? '+' : '') + c.endOffsetMs + 'ms (' + c.origEnd.toFixed(3) + 's -> ' + newEnd + 's)');
    if (lockedShots.has('sc' + c.scene + '_sh' + c.shot)) parts.push('[LOCKED]');
    return parts.join(' ');
  });
  const lockedOnly = [...lockedShots].filter(k => !corrections[k]).map(k => {
    const parts = k.match(/sc(\\d+)_sh(\\d+)/);
    return parts ? 'Scene ' + parts[1] + ', Shot ' + parts[2] + ': [LOCKED - no changes]' : k;
  });
  const allLines = [...lines, ...lockedOnly];
  const text = 'SCENE REVIEW CORRECTIONS\\nEpisode: ${EPISODE_ID}\\nDate: ' + new Date().toISOString().slice(0,10) + '\\nLocked: ' + lockedShots.size + '\\n\\n' + allLines.join('\\n');
  navigator.clipboard.writeText(text);
  alert('Copied ' + allLines.length + ' item(s) to clipboard!');
}
</script>
</body></html>`;

// Add scene IDs for navigation
let finalHtml = html;
for (const scene of allScenes) {
  finalHtml = finalHtml.replace(
    `<h2>Scene ${scene.sceneNumber}</h2>`,
    `<h2 id="sc-${scene.sceneNumber}">Scene ${scene.sceneNumber}</h2>`
  );
}

fs.writeFileSync(path.join(OUTPUT_DIR, 'scene-review-report.html'), finalHtml);
console.log(`Scene Review Report saved to ${path.join(OUTPUT_DIR, 'scene-review-report.html')}`);

// Try to open the report in the default browser
try {
  if (process.platform === 'win32') {
    execSync(`start "" "${path.join(OUTPUT_DIR, 'scene-review-report.html')}"`, { stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    execSync(`open "${path.join(OUTPUT_DIR, 'scene-review-report.html')}"`, { stdio: 'ignore' });
  } else {
    execSync(`xdg-open "${path.join(OUTPUT_DIR, 'scene-review-report.html')}"`, { stdio: 'ignore' });
  }
} catch { /* browser open is best-effort */ }
