/**
 * Rebuild Scene Review Report from existing scenes.json data.
 * Uses the updated template with settings dropdown + adjustment controls.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EPISODE_ID = process.argv[2] || 'S02E01';
const OUTPUT_DIR = path.join(__dirname, 'gemini-analysis', EPISODE_ID);
const LOCAL_FILE = process.argv[3] || 'C:\\Star Trek\\Star Trek Tng S02e01 The Child (1080P X265 Joy).mp4';

// Extract episode title from DB or filename
let EPISODE_TITLE = '';
try {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(__dirname, 'gemini-analysis', 'vstack.db'), { readonly: true });
  const row = db.prepare('SELECT title FROM episodes WHERE id = ?').get(EPISODE_ID);
  if (row?.title) EPISODE_TITLE = row.title;
  db.close();
} catch {}
if (!EPISODE_TITLE) {
  // Fallback: parse from filename (e.g. "Star Trek Tng S02e01 The Child (1080P).mp4" -> "The Child")
  const match = LOCAL_FILE.match(/S\d+e\d+\s+(.+?)(?:\s*\(|\.mp4)/i);
  if (match) EPISODE_TITLE = match[1].trim();
}

// Legacy constants — not used by report builder (reads from scenes.json only)

const ffmpegDir = path.join(__dirname, 'ffmpeg');
const subdirs = fs.readdirSync(ffmpegDir).filter(d => d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory());
const FFPROBE = path.join(ffmpegDir, subdirs[0], 'bin', 'ffprobe.exe');

function getVideoDuration() {
  return parseFloat(execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${LOCAL_FILE}"`, { encoding: 'utf-8' }).trim());
}

function formatTs(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

function fmtTs2(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function parseTs(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const parts = ts.split(':');
  if (parts.length !== 2) return 0;
  return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
}

// Load existing data
const allScenes = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'scenes.json'), 'utf-8'));
const cutPointsPath = path.join(OUTPUT_DIR, 'cut-points.json');
const cutPoints = fs.existsSync(cutPointsPath) ? JSON.parse(fs.readFileSync(cutPointsPath, 'utf-8')) : [];

const totalShots = allScenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
const totalCost = 0;
const totalTime = 0;
const cutPointCount = cutPoints.length;
const duration = getVideoDuration();
const generatedAt = new Date().toISOString();

console.log(`Rebuilding report for ${EPISODE_ID}: ${allScenes.length} scenes, ${totalShots} shots`);

// Build scenes HTML
const sceneColors = ['#4fc3f7', '#e94560', '#a5d6a7', '#ff9800', '#ce93d8', '#ffcc80', '#80cbc4', '#ef5350', '#81d4fa', '#ffab91', '#b39ddb', '#c5e1a5'];
let scenesHtml = '';
for (let i = 0; i < allScenes.length; i++) {
  const scene = allScenes[i];
  const borderColor = sceneColors[i % sceneColors.length];
  const creditsClass = scene.isCredits ? ' credits' : '';
  const creditsBadge = scene.isCredits ? ' <span class="pill credits-badge">CREDITS</span>' : '';
  const charsJson = JSON.stringify(scene.characters || []).replace(/"/g, '&quot;');
  scenesHtml += `<div class="scene${creditsClass}" style="border-left-color:${borderColor}" data-characters="${charsJson}"><div class="scene-hdr"><h2>Scene ${scene.sceneNumber}${creditsBadge}</h2>
    <span class="pill tm">${scene.startTimestamp || '?'} → ${scene.endTimestamp || '?'}</span>
    <span class="pill loc">${scene.location || '?'}</span>
    <span class="pill mood">${scene.mood || '?'}</span>
    <span class="pill chr">${(scene.characters || []).join(', ')}</span></div>
    <div class="plot">${scene.plotSignificance || ''}</div>
    <div class="scene-details">
      ${scene.lighting ? `<div class="sd"><span class="sd-label">Lighting</span> ${scene.lighting}</div>` : ''}
      ${scene.music ? `<div class="sd"><span class="sd-label">Music</span> ${scene.music}</div>` : ''}
      ${scene.costuming ? `<div class="sd"><span class="sd-label">Costumes</span> ${scene.costuming}</div>` : ''}
      ${(scene.tags || []).length ? `<div class="sd"><span class="sd-label">Tags</span> <span class="scene-tags">${scene.tags.map(t => '<span class="tag">' + t + '</span>').join(' ')}</span></div>` : ''}
      ${(scene.supercutPotential || []).length ? `<div class="sd"><span class="sd-label">Supercut</span> <span class="scene-tags">${scene.supercutPotential.map(t => '<span class="stag">' + t + '</span>').join(' ')}</span></div>` : ''}
    </div>
    <div class="tier2-controls">
      <button class="shot-edit-btn" onclick="editSceneJson(${scene.sceneNumber})">{ } Edit Scene</button>
      <button class="tier2-scene-btn" onclick="analyzeTier2(${scene.sceneNumber})">&#9889; Analyze Scene ${scene.sceneNumber}</button>
      <span class="tier2-progress" id="t2-progress-sc${scene.sceneNumber}"></span>
    </div>
    <div class="shots">`;

  for (const shot of (scene.shots || [])) {
    const startSec = shot._snappedStart || parseTs(shot.startTimestamp) || 0;
    const endSec = shot._snappedEnd || parseTs(shot.endTimestamp) || 0;
    const dur = (endSec - startSec).toFixed(1);
    const tc = (shot.shotType || '').includes('close') ? 'tc' : (shot.shotType || '').includes('medium') ? 'tm2' : (shot.shotType || '').includes('wide') ? 'tw' : 'to';
    const exprs = shot.characterExpressions ? Object.entries(shot.characterExpressions).map(([k, v]) => `<b>${k}:</b> ${v}`).join(' &middot; ') : '';

    const subjectStr = typeof shot.subject === 'string' ? shot.subject : (shot.subject ? JSON.stringify(shot.subject) : '?');
    const typeStr = typeof shot.shotType === 'string' ? shot.shotType : (shot.shotType ? JSON.stringify(shot.shotType) : '?');
    const shotSubjectEsc = subjectStr.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const shotTypeEsc = typeStr.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const playOnclick = `onclick="playShot(${scene.sceneNumber},${shot.shotNumber},${startSec},${endSec},'${shotSubjectEsc}','${shotTypeEsc}')"`;
    scenesHtml += `<div class="shot" data-sc="${scene.sceneNumber}" data-sh="${shot.shotNumber}" data-start="${startSec.toFixed(3)}" data-end="${endSec.toFixed(3)}"><label class="shot-check"><input type="checkbox" class="shot-cb" onchange="updateJoinBtn()" value="${scene.sceneNumber}-${shot.shotNumber}"></label><div class="fw" ${playOnclick}><img src="frames/${shot._frameFirst || ''}" /><div class="fl fg">▶ ${formatTs(startSec)}</div></div>
      <div class="fw" ${playOnclick}><img src="frames/${shot._frameLast || ''}" /><div class="fl fr">◼ ${formatTs(endSec)}</div></div>
      <div class="si"><div class="sh"><h4>Shot ${shot.shotNumber} <span class="st ${tc}">${shot.shotType || '?'}</span> <span class="dur">${dur}s</span></h4>
      <span class="tt">${formatTs(startSec)} → ${formatTs(endSec)}</span></div>
      <div class="f"><span class="fl2">Subject</span><div class="subj">${shot.subject || '?'}</div></div>
      <div class="f"><span class="fl2">Action</span><div>${shot.action || '?'}</div></div>
      ${shot.cameraMovement ? `<div class="f"><span class="fl2">Camera</span><div class="cam">${shot.cameraMovement}</div></div>` : ''}
      ${exprs ? `<div class="f"><span class="fl2">Expressions</span><div>${exprs}</div></div>` : ''}
      ${shot.dialogue?.length ? `<div class="f dialogue"><span class="fl2">Dialogue</span><div class="dialogue-lines" data-episode="${EPISODE_ID}" data-scene="${scene.sceneNumber}" data-shot="${shot.shotNumber}">${shot.dialogue.map((d, dIdx) => {
        if (typeof d === 'string') return `<div class="dl" data-dlidx="${dIdx}">"${d}"<button class="dl-delete" onclick="deleteDialogueLine(this, ${scene.sceneNumber}, ${shot.shotNumber}, ${dIdx})" title="Delete line">&times;</button></div>`;
        const speakerEsc = (d.speaker || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const speaker = d.speaker ? `<span class="dl-speaker" ondblclick="editSpeaker(this, ${scene.sceneNumber})" data-dlidx="${dIdx}">${d.speaker}:</span> ` : '';
        const tsSec = typeof d.start === 'string' && d.start.includes(':') ? parseTs(d.start) : parseFloat(d.start || 0);
        const ts = d.start ? `<span class="dl-ts">${fmtTs2(tsSec)}</span> ` : '';
        const isFirst = dIdx === 0;
        const isLast = dIdx === shot.dialogue.length - 1;
        const moveUp = isFirst ? `<button class="dl-move-btn" onclick="moveDialogue(this, 'up', ${scene.sceneNumber}, ${shot.shotNumber}, ${dIdx})" title="Move to previous shot">&#8593;</button>` : '';
        const moveDown = isLast ? `<button class="dl-move-btn" onclick="moveDialogue(this, 'down', ${scene.sceneNumber}, ${shot.shotNumber}, ${dIdx})" title="Move to next shot">&#8595;</button>` : '';
        const textEsc = (d.text || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        return `<div class="dl" data-dlidx="${dIdx}">${moveUp}${moveDown}${ts}${speaker}<span class="dl-text" ondblclick="editDialogueText(this, ${scene.sceneNumber}, ${shot.shotNumber}, ${dIdx})">"${textEsc}"</span><button class="dl-delete" onclick="deleteDialogueLine(this, ${scene.sceneNumber}, ${shot.shotNumber}, ${dIdx})" title="Delete line">&times;</button></div>`;
      }).join('')}</div></div>` : ''}
      <div class="tgs" data-tagtype="tags" data-episode="${EPISODE_ID}" data-scene="${scene.sceneNumber}" data-shot="${shot.shotNumber}">${(shot.tags || []).map(t => '<span class="tag" ondblclick="editTag(this)">' + t + '</span>').join('')}<span class="tag-add-btn" onclick="addTagInput(this)" title="Add tag">+</span></div>
      ${(shot.supercutPotential || []).length ? '<div class="tgs">' + shot.supercutPotential.map(t => '<span class="stag">' + t + '</span>').join('') + '</div>' : ''}
      <div class="adj" data-scene="${scene.sceneNumber}" data-shot="${shot.shotNumber}" data-start="${startSec.toFixed(3)}" data-end="${endSec.toFixed(3)}" data-edge="start">
        <span class="adj-label">START</span>
        <button onclick="adjustShot(this,-1000,'start')">-1s</button>
        <button onclick="adjustShot(this,-500,'start')">-500ms</button>
        <button onclick="adjustShot(this,-100,'start')">-100</button>
        <button onclick="adjustShot(this,-50,'start')">-50</button>
        <button onclick="adjustShot(this,-10,'start')">-10</button>
        <span class="adj-val" id="adj-start-s${scene.sceneNumber}-sh${shot.shotNumber}">±0ms</span>
        <button onclick="adjustShot(this,10,'start')">+10</button>
        <button onclick="adjustShot(this,50,'start')">+50</button>
        <button onclick="adjustShot(this,100,'start')">+100</button>
        <button onclick="adjustShot(this,500,'start')">+500ms</button>
        <button onclick="adjustShot(this,1000,'start')">+1s</button>
        <span class="adj-ts" id="adjts-start-s${scene.sceneNumber}-sh${shot.shotNumber}">${formatTs(startSec)}</span>
        <button class="adj-reset" onclick="resetEdge(this,'start')" title="Reset to original">&#8634;</button>
      </div>
      <div class="adj" data-scene="${scene.sceneNumber}" data-shot="${shot.shotNumber}" data-start="${startSec.toFixed(3)}" data-end="${endSec.toFixed(3)}" data-edge="end">
        <span class="adj-label">END</span>
        <button onclick="adjustShot(this,-1000,'end')">-1s</button>
        <button onclick="adjustShot(this,-500,'end')">-500ms</button>
        <button onclick="adjustShot(this,-100,'end')">-100</button>
        <button onclick="adjustShot(this,-50,'end')">-50</button>
        <button onclick="adjustShot(this,-10,'end')">-10</button>
        <span class="adj-val" id="adj-end-s${scene.sceneNumber}-sh${shot.shotNumber}">±0ms</span>
        <button onclick="adjustShot(this,10,'end')">+10</button>
        <button onclick="adjustShot(this,50,'end')">+50</button>
        <button onclick="adjustShot(this,100,'end')">+100</button>
        <button onclick="adjustShot(this,500,'end')">+500ms</button>
        <button onclick="adjustShot(this,1000,'end')">+1s</button>
        <span class="adj-ts" id="adjts-end-s${scene.sceneNumber}-sh${shot.shotNumber}">${formatTs(endSec)}</span>
        <button class="adj-reset" onclick="resetEdge(this,'end')" title="Reset to original">&#8634;</button>
      </div>
      <button class="shot-edit-btn" onclick="editShotJson(${scene.sceneNumber},${shot.shotNumber})">{ } Edit</button>
      ${shot._tier !== 2 ? `<button class="shot-analyze-btn" onclick="analyzeTier2(${scene.sceneNumber},${shot.shotNumber})">&#9889; Analyze</button>` : ''}
      </div></div>`;
  }

  if (!scene.shots || scene.shots.length === 0) {
    scenesHtml += `<div style="padding:12px;color:#666;font-style:italic">No shot data available for this scene (Gemini returned scene-level metadata only)</div>`;
  }

  scenesHtml += '</div></div>';
}

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${EPISODE_ID} — Scene Review Report</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/codemirror.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/theme/material-darker.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/dialog/dialog.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/search/matchesonscrollbar.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/codemirror.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/mode/javascript/javascript.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/edit/matchbrackets.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/edit/closebrackets.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/fold/foldcode.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/fold/foldgutter.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/fold/brace-fold.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/search/search.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/search/searchcursor.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/search/jump-to-line.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/dialog/dialog.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/mode/overlay.min.js"><\/script>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0a0a1a;color:#e0e0e0;padding:20px 20px 60px;max-width:1300px;margin:0 auto}
h1{color:#4fc3f7;margin-bottom:5px}.sub{color:#888;margin-bottom:24px}
.stats{background:#1a1a2e;border-radius:10px;padding:16px 20px;margin-bottom:24px;display:flex;gap:30px;flex-wrap:wrap}
.stat{text-align:center}.stat-val{font-size:28px;font-weight:bold;color:#4fc3f7}.stat-lbl{font-size:11px;color:#888}
details.settings{background:#1a1a2e;border-radius:10px;margin-bottom:24px;overflow:hidden}
details.settings summary{padding:12px 20px;cursor:pointer;color:#888;font-size:13px;user-select:none}
details.settings summary:hover{color:#4fc3f7}
details.settings summary::marker{color:#4fc3f7}
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
.plot{color:#aaa;font-size:13px;line-height:1.5;margin-bottom:8px}
.scene-details{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;padding:8px 12px;background:#0d0d1a;border-radius:6px;font-size:12px}
.sd{color:#999}.sd-label{color:#666;font-size:10px;text-transform:uppercase;min-width:70px;display:inline-block}
.scene-tags{display:inline}.tag{display:inline-block;background:#333;padding:0 5px;border-radius:3px;font-size:10px;margin:1px;color:#ccc}
.stag{display:inline-block;background:#1b5e20;padding:0 5px;border-radius:3px;font-size:10px;margin:1px;color:#a5d6a7}
.shots{display:flex;flex-direction:column;gap:8px;margin-top:14px}
.shot{display:grid;grid-template-columns:24px 160px 160px 1fr;gap:0;background:#1a1a2e;border-radius:8px;overflow:hidden;border-left:3px solid #333}
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
.nav{position:sticky;top:0;background:#0a0a1a;padding:8px 0;z-index:10;border-bottom:1px solid #333;margin-bottom:16px;display:flex;align-items:center;gap:12px}
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
.shot-edit-btn{background:none;border:1px solid #444;color:#888;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:10px;font-family:monospace;margin-top:6px}
.shot-edit-btn:hover{border-color:#4fc3f7;color:#4fc3f7}
.shot-analyze-btn{background:none;border:1px solid #ff9800;color:#ff9800;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:10px;margin-top:6px;margin-left:4px}
.shot-analyze-btn:hover{background:#ff9800;color:#000}
.tier2-controls{display:flex;gap:8px;align-items:center;margin-bottom:12px;padding:8px 12px;background:#1a1a2e;border-radius:6px}
.tier2-controls button{padding:6px 14px;border-radius:4px;border:none;cursor:pointer;font-size:12px;font-weight:bold}
.tier2-scene-btn{background:#ff9800;color:#000}
.tier2-all-btn{background:#4fc3f7;color:#000}
.tier2-log-btn{background:#333;color:#eee}
.tier2-progress{color:#ff9800;font-size:12px;margin-left:8px}
.tier2-log-panel{background:#0a0a15;border:1px solid #333;border-radius:6px;padding:10px;margin-top:8px;max-height:300px;overflow-y:auto;font-family:monospace;font-size:11px;color:#a0a0a0;white-space:pre-wrap;display:none}
.shot-editor{margin-top:8px;width:100%}
.shot-editor textarea{width:100%;min-height:200px;max-height:500px;background:#0a0a15;color:#e0e0e0;border:1px solid #333;border-radius:6px;padding:10px;font-family:monospace;font-size:11px;line-height:1.5;resize:vertical;tab-size:2}
.shot-editor textarea:focus{border-color:#4fc3f7;outline:none}
.shot-editor .se-toolbar{display:flex;gap:6px;margin-top:6px;align-items:center}
.shot-editor .se-toolbar button{font-size:11px;padding:4px 10px;border-radius:3px;border:none;cursor:pointer}
.shot-editor .se-save{background:#4caf50;color:#fff}
.shot-editor .se-save:hover{background:#66bb6a}
.shot-editor .se-cancel{background:#333;color:#aaa}
.shot-editor .se-cancel:hover{background:#444}
.shot-editor .se-status{font-size:10px;color:#888;margin-left:auto}
.shot-editor .se-error{color:#e94560;font-size:10px;margin-top:4px}
.cancel-btn{background:#333;color:#aaa;border:none;padding:6px 16px;border-radius:4px;cursor:pointer;font-size:12px;margin-left:6px}
.cancel-btn:hover{background:#e94560;color:#fff}
.shot.locked{opacity:0.7;border-left-color:#4caf50 !important}
.shot.locked .adj button{pointer-events:none;opacity:0.3}
.shot.locked .lock-btn{background:#333;color:#888;cursor:default}
.shot.locked .lock-btn::after{content:' (locked)'}
.unlock-btn{background:#ff5722;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:10px;margin-left:8px}
.unlock-btn:hover{background:#ff7043}
.corrections-bar{position:fixed;bottom:0;left:0;right:0;background:#0f3460;padding:10px 20px;display:flex;justify-content:space-between;align-items:center;z-index:20;font-size:13px}
.corrections-bar button{background:#e94560;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:13px}
.corrections-bar button:hover{background:#c73e54}
.apply-btn{background:#4caf50 !important}.apply-btn:hover{background:#66bb6a !important}
.apply-btn.loading{opacity:0.6;pointer-events:none}
.revert-btn{background:#ff9800 !important}.revert-btn:hover{background:#ffb74d !important}
.revert-btn.loading{opacity:0.6;pointer-events:none}
.reanalyze-btn{background:#1a1a2e;color:#4fc3f7;border:1px solid #333;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:10px;margin-top:4px}
.reanalyze-btn:hover{background:#0d3b66;border-color:#4fc3f7}
.reanalyze-btn.loading{opacity:0.5;pointer-events:none}
.vp-icon{position:fixed;bottom:80px;right:20px;width:50px;height:50px;background:#1a1a2e;border:1px solid #333;border-radius:50%;z-index:30;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 4px 16px rgba(0,0,0,0.5)}
.vp-icon:hover{background:#333;border-color:#4fc3f7}
.video-panel{position:fixed;bottom:60px;right:20px;width:420px;background:#0d0d1a;border:1px solid #333;border-radius:12px;z-index:30;box-shadow:0 8px 32px rgba(0,0,0,0.6);transition:box-shadow 0.3s;overflow:hidden}
.vp-header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#1a1a2e;border-bottom:1px solid #333;cursor:move}
.vp-header-btns{display:flex;gap:4px}
.vp-header-btns button{background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:3px}
.vp-header-btns button:hover{color:#4fc3f7;background:#333}
.vp-toggle{background:none;border:none;color:#4fc3f7;font-size:16px;cursor:pointer;padding:4px}
.vp-content{display:flex;flex-direction:column;padding:10px 12px}
.vp-info{font-size:12px;color:#888;padding:4px 0;min-height:24px}
.vp-info .vp-label{color:#4fc3f7;font-weight:bold}
.vp-info .vp-subject{color:#ce93d8}
.vp-video-wrap{position:relative}
#vp-video{width:100%;border-radius:6px;background:#000}
.vp-timecode{position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.85);color:#4fc3f7;font-family:monospace;font-size:12px;padding:2px 8px;border-radius:4px;pointer-events:none}
.vp-actions{display:flex;align-items:center;justify-content:center;gap:10px;padding:6px 0}
.vp-btn{background:#1a1a2e;border:1px solid #333;color:#4fc3f7;cursor:pointer;font-size:16px;padding:6px 12px;border-radius:6px}
.vp-btn:hover{background:#333}
.vp-controls{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;color:#aaa}
.vp-speed{background:#333;color:#eee;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px}
.vp-speed.active{background:#4fc3f7;color:#000}
.vp-sep{color:#444}
.fw img{cursor:pointer}
.shot-check{display:flex;align-items:flex-start;padding:8px 4px 0 0;flex-shrink:0}
.shot-cb{width:16px;height:16px;cursor:pointer;accent-color:#4fc3f7}
.shot-cb:checked{accent-color:#ff9800}
.join-btn{background:#ff9800;color:#000;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:13px;display:none}
.join-btn:hover{background:#ffb74d}
.join-btn.visible{display:inline-block}
.join-count{color:#ff9800;font-size:12px;margin-right:8px;display:none}
.join-count.visible{display:inline}
.unselect-btn{background:#333;color:#aaa;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:12px;display:none}
.unselect-btn:hover{background:#555;color:#fff}
.unselect-btn.visible{display:inline-block}
.search-box{display:flex;align-items:center;gap:6px;flex:1;max-width:500px}
.search-scope{background:#1a1a2e;color:#aaa;border:1px solid #444;padding:6px;border-radius:4px;font-size:12px;cursor:pointer}
#search-input{background:#1a1a2e;color:#eee;border:1px solid #444;padding:6px 10px;border-radius:4px;font-size:13px;width:100%}
#search-input:focus{border-color:#4fc3f7;outline:none}
#search-count{color:#888;font-size:11px;white-space:nowrap}
#search-clear{background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:0 4px}
#search-clear:hover{color:#e94560}
.shot.search-hidden{display:none !important}
.scene.search-hidden{display:none !important}
.dur{color:#ff9800;font-size:11px;font-family:monospace}
.adj-reset{background:none;border:none;color:#666;cursor:pointer;font-size:14px;padding:0 4px}.adj-reset:hover{color:#e94560}
.json-editor-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:200;display:flex;flex-direction:column}
.json-editor-toolbar{display:flex;gap:8px;padding:10px 16px;background:#111;border-bottom:1px solid #333;align-items:center}
.json-editor-toolbar button{background:#333;color:#eee;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px}
.json-editor-toolbar button:hover{background:#4fc3f7;color:#000}
.json-editor-toolbar .save-btn{background:#4caf50;color:#fff}
.json-editor-toolbar .save-btn:hover{background:#66bb6a}
.json-editor-toolbar .revert-btn{background:#ff5722;color:#fff}
.json-editor-status{padding:4px 16px;background:#0d0d1a;font-size:11px;font-family:monospace;display:flex;gap:16px;border-bottom:1px solid #222}
.json-editor-status .valid{color:#4caf50}
.json-editor-status .invalid{color:#e94560}
.json-editor-area{flex:1;padding:0}
.json-editor-area{flex:1;overflow:hidden}
.json-editor-area .CodeMirror{height:100%;background:#0a0a1a;font-size:13px;line-height:1.5}
.json-editor-area .CodeMirror-gutters{background:#0d0d1a;border-right:1px solid #222}
.json-editor-area .cm-property{color:#888}
.json-editor-area .cm-key-sceneNumber{color:#ff9800}
.json-editor-area .cm-key-shotNumber{color:#ff9800}
.json-editor-area .cm-key-startTimestamp{color:#4caf50}
.json-editor-area .cm-key-endTimestamp{color:#e94560}
.json-editor-area .cm-key-location{color:#ce93d8}
.json-editor-area .cm-key-characters{color:#ce93d8}
.json-editor-area .cm-key-mood{color:#ffab91}
.json-editor-area .cm-key-plotSignificance{color:#a5d6a7}
.json-editor-area .cm-key-lighting{color:#fff59d}
.json-editor-area .cm-key-music{color:#f48fb1}
.json-editor-area .cm-key-costuming{color:#80cbc4}
.json-editor-area .cm-key-tags{color:#81d4fa}
.json-editor-area .cm-key-supercutPotential{color:#b39ddb}
.json-editor-area .cm-key-shots{color:#4fc3f7;font-weight:bold}
.json-editor-area .cm-key-shotType{color:#ffcc80}
.json-editor-area .cm-key-subject{color:#ef9a9a}
.json-editor-area .cm-key-action{color:#c5e1a5}
.json-editor-area .cm-key-characterExpressions{color:#f0b27a}
.json-editor-area .cm-key-cameraMovement{color:#aed581}
.json-editor-area .cm-key-dialogue{color:#4dd0e1;font-weight:bold}
.json-editor-area .cm-key-speaker{color:#e1bee7}
.json-editor-area .cm-key-text{color:#dcedc8}
.json-editor-area .cm-key-start{color:#4caf50}
.json-editor-area .cm-key-end{color:#e94560}
.json-editor-area .cm-string{color:#c3e88d}
.json-editor-area .cm-number{color:#f78c6c}
.json-editor-area .cm-atom{color:#ff5370}
.json-editor-area .cm-bracket{color:#89ddff}
.json-editor-area .CodeMirror-matchingbracket{color:#fff !important;background:rgba(79,195,247,0.3);border-bottom:1px solid #4fc3f7}
.json-editor-area .CodeMirror-selected{background:rgba(79,195,247,0.15)}
.json-editor-area .CodeMirror-cursor{border-left:2px solid #4fc3f7}
.json-editor-area .CodeMirror-activeline-background{background:rgba(255,255,255,0.03)}
.json-editor-area .CodeMirror-foldgutter{width:14px}
.json-editor-area .CodeMirror-foldgutter-open:after{content:'\\25BE';color:#555;font-size:12px}
.json-editor-area .CodeMirror-foldgutter-folded:after{content:'\\25B8';color:#4fc3f7;font-size:12px}
.json-editor-area .CodeMirror-foldgutter-open,.json-editor-area .CodeMirror-foldgutter-folded{cursor:pointer;text-align:center}
.json-jump-highlight{background:rgba(79,195,247,0.2) !important;transition:background 2s ease-out}
.cm-fold-scene{color:#ff9800;background:#1a1500;padding:1px 6px;border-radius:3px;font-size:12px;font-weight:bold;cursor:pointer}
.cm-fold-shot{color:#81d4fa;background:#0d1520;padding:1px 4px;border-radius:2px;font-size:11px;cursor:pointer}
.dl-speaker{cursor:pointer;border-bottom:1px dashed transparent;transition:border-color 0.2s}
.dl-speaker:hover{border-bottom-color:#4fc3f7}
.dl-text{cursor:pointer;border-bottom:1px dashed transparent;transition:border-color 0.2s}
.dl-text:hover{border-bottom-color:#ff9800}
.speaker-dropdown{position:absolute;background:#1a1a2e;border:1px solid #4fc3f7;border-radius:6px;padding:4px 0;z-index:100;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,0.6);max-height:240px;overflow-y:auto}
.speaker-dropdown .sp-option{padding:5px 12px;cursor:pointer;font-size:12px;color:#eee;white-space:nowrap}
.speaker-dropdown .sp-option:hover{background:#333;color:#4fc3f7}
.speaker-dropdown .sp-option.sp-active{color:#4fc3f7;font-weight:bold}
.speaker-dropdown .sp-custom-row{padding:4px 8px;border-top:1px solid #333;margin-top:2px}
.speaker-dropdown .sp-custom-row input{background:#0d0d1a;color:#eee;border:1px solid #444;padding:3px 6px;border-radius:3px;font-size:11px;width:100%}
.speaker-dropdown .sp-custom-row input:focus{border-color:#4fc3f7;outline:none}
.dl-move-btn{background:none;border:1px solid #444;color:#888;font-size:9px;padding:0 4px;border-radius:2px;cursor:pointer;margin-right:4px;line-height:1.4;vertical-align:middle}
.dl-move-btn:hover{border-color:#4fc3f7;color:#4fc3f7}
.shot-editor-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:200;display:flex;align-items:center;justify-content:center}
.shot-editor-modal{background:#0d0d1a;border:1px solid #333;border-radius:12px;width:700px;max-width:90vw;max-height:85vh;display:flex;flex-direction:column;overflow:hidden}
.shot-editor-modal .sem-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#111;border-bottom:1px solid #333}
.shot-editor-modal .sem-header h3{color:#4fc3f7;font-size:14px;margin:0}
.shot-editor-modal .sem-close{background:none;border:none;color:#888;cursor:pointer;font-size:18px;padding:4px 8px}
.shot-editor-modal .sem-close:hover{color:#e94560}
.shot-editor-modal .sem-body{flex:1;overflow:auto;display:flex;flex-direction:column;min-height:0}
.shot-editor-modal .sem-body .CodeMirror{flex:1;height:auto;min-height:200px;max-height:60vh;background:#0a0a1a;font-size:12px;line-height:1.5}
.shot-editor-modal .sem-body .CodeMirror-gutters{background:#0d0d1a;border-right:1px solid #222}
.shot-editor-modal .sem-toolbar{display:flex;gap:6px;padding:10px 16px;background:#111;border-top:1px solid #333;align-items:center}
.shot-editor-modal .sem-toolbar button{font-size:11px;padding:5px 12px;border-radius:4px;border:none;cursor:pointer}
.shot-editor-modal .sem-toolbar .se-save{background:#4caf50;color:#fff}
.shot-editor-modal .sem-toolbar .se-save:hover{background:#66bb6a}
.shot-editor-modal .sem-toolbar .se-cancel{background:#333;color:#aaa}
.shot-editor-modal .sem-toolbar .se-cancel:hover{background:#444}
.shot-editor-modal .sem-toolbar .se-error{color:#e94560;font-size:10px;margin-left:auto}
.offset-preview-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:150;display:flex;align-items:center;justify-content:center}
.offset-preview-modal{background:#0d0d1a;border:1px solid #333;border-radius:10px;padding:16px;width:500px;max-width:90vw}
.offset-preview-modal .opm-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.offset-preview-modal .opm-header h4{color:#4fc3f7;font-size:13px;margin:0}
.offset-preview-modal .opm-close{background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:2px 6px}
.offset-preview-modal .opm-close:hover{color:#e94560}
.offset-preview-modal .opm-frames{display:flex;gap:10px}
.offset-preview-modal .opm-frame-box{position:relative;flex:1}
.offset-preview-modal .opm-frame-box img{width:100%;border-radius:4px;border:2px solid #ff9800;transition:opacity 0.15s}
.offset-preview-modal .opm-edge-label{position:absolute;top:4px;left:4px;background:#ff9800;color:#000;font-size:9px;padding:1px 6px;border-radius:3px;font-weight:bold}
.offset-preview-modal .opm-actions{margin-top:10px;text-align:center}
.offset-preview-modal .opm-adj-controls{margin-top:10px;padding:8px;background:#111;border-radius:6px}
.offset-preview-modal .opm-adj-row{display:flex;align-items:center;gap:4px;margin-bottom:6px;font-size:10px}
.offset-preview-modal .opm-adj-row:last-child{margin-bottom:0}
.offset-preview-modal .opm-adj-row button{background:#333;color:#eee;border:none;padding:2px 6px;border-radius:3px;cursor:pointer;font-size:10px;font-family:monospace}
.offset-preview-modal .opm-adj-row button:hover{background:#4fc3f7;color:#000}
.offset-preview-modal .opm-adj-label{color:#666;font-size:9px;min-width:36px}
.offset-preview-modal .opm-adj-val{color:#4caf50;font-family:monospace;min-width:50px;text-align:center}
.offset-preview-modal .opm-adj-ts{color:#888;font-family:monospace;font-size:9px;margin-left:6px}
.dl-delete{background:none;border:none;color:#e94560;cursor:pointer;font-size:13px;padding:0 3px;margin-left:6px;opacity:0.5;font-style:normal;vertical-align:middle;line-height:1}
.dl-delete:hover{opacity:1}
.dl{display:flex;align-items:baseline;flex-wrap:wrap}
.tag-add-btn{display:inline-block;background:#222;color:#4fc3f7;border:1px dashed #555;padding:0 5px;border-radius:2px;font-size:11px;margin:1px;cursor:pointer;line-height:1.4}
.tag-add-btn:hover{background:#333;border-color:#4fc3f7}
.tag-add-input{background:#111;color:#eee;border:1px solid #4fc3f7;padding:0 4px;border-radius:2px;font-size:9px;margin:1px;width:80px;outline:none}
.tag[contenteditable="true"]{outline:1px solid #4fc3f7;background:#222}
.confirm-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:200;display:flex;align-items:center;justify-content:center}
.confirm-modal{background:#0d0d1a;border:1px solid #e94560;border-radius:10px;padding:20px;width:340px;text-align:center}
.confirm-modal p{color:#eee;margin-bottom:16px;font-size:13px}
.confirm-modal button{padding:6px 20px;border:none;border-radius:4px;cursor:pointer;font-size:12px;margin:0 6px}
.confirm-modal .cm-yes{background:#e94560;color:#fff}
.confirm-modal .cm-yes:hover{background:#ff6b81}
.confirm-modal .cm-no{background:#333;color:#aaa}
.confirm-modal .cm-no:hover{background:#444}
</style></head><body>
<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
<h1 style="margin:0">📋 ${EPISODE_ID} — Scene Review Report</h1>
<button id="revert-btn-top" onclick="revertToOriginal()" style="display:none;background:#e94560;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold">↩ Revert to Original</button>
</div>
<p class="sub">${EPISODE_TITLE ? EPISODE_TITLE + ' — ' : ''}Full episode scene &amp; shot metadata with frame-perfect timestamps</p>

<div class="stats">
<div class="stat"><div class="stat-val">${allScenes.length}</div><div class="stat-lbl">Scenes</div></div>
<div class="stat"><div class="stat-val">${totalShots}</div><div class="stat-lbl">Shots</div></div>
<div class="stat"><div class="stat-val">${(totalShots / Math.max(allScenes.length, 1)).toFixed(1)}</div><div class="stat-lbl">Avg Shots/Scene</div></div>
<div class="stat"><div class="stat-val">$${totalCost.toFixed(2)}</div><div class="stat-lbl">Analysis Cost</div></div>
<div class="stat"><div class="stat-val">${totalTime}s</div><div class="stat-lbl">Analysis Time</div></div>
</div>

<!-- Settings moved to Hub episode page -->

<div class="nav"><a href="/" style="color:#888;text-decoration:none;margin-right:10px;font-size:12px" title="Media Library">◀ Hub</a><span style="color:#4fc3f7;font-weight:bold;margin-right:4px">${EPISODE_ID}</span>${EPISODE_TITLE ? `<span style="color:#888;font-size:12px;margin-right:12px">${EPISODE_TITLE}</span>` : ''}<label>Jump to: </label><select onchange="document.getElementById('sc-'+this.value)?.scrollIntoView({behavior:'smooth'})">
<option value="">--</option>${allScenes.map(s => `<option value="${s.sceneNumber}">Scene ${s.sceneNumber} (${s.startTimestamp || '?'}) ${(s.location || '').slice(0, 30)}</option>`).join('')}
</select>
<button onclick="openJsonEditor()" style="background:#1a1a2e;color:#4fc3f7;border:1px solid #333;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-family:monospace">{ } Edit JSON</button>
<button onclick="analyzeTier2All()" style="background:#ff9800;color:#000;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold">&#9889; Tier 2: All Shots</button>
<button onclick="toggleTier2Log()" style="background:#333;color:#eee;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px">&#128462; Log</button>
<div class="search-box">
  <select id="search-scope" onchange="debounceSearch()" class="search-scope">
    <option value="shots" selected>Shots</option>
    <option value="scenes">Scenes</option>
    <option value="both">Both</option>
  </select>
  <input type="text" id="search-input" placeholder="Search..." oninput="debounceSearch()">
  <span id="search-count"></span>
  <button id="search-clear" onclick="clearSearch()" style="display:none">&times;</button>
</div>
</div>

${scenesHtml}

<div class="corrections-bar">
  <span>Corrections: <span id="correction-count">0</span> shots adjusted</span>
  <div>
    <span class="join-count" id="join-count"></span>
    <button class="unselect-btn" id="unselect-btn" onclick="unselectAll()">Unselect All</button>
    <button class="join-btn" id="join-btn" onclick="joinShots()">⊕ Join Selected Shots</button>
    <button onclick="resetAll()">Reset All</button>
    <button onclick="exportCorrections()">📋 View Pending Changes</button>
    <button onclick="applyCorrections()" class="apply-btn">✅ Apply Corrected Timestamps</button>
  </div>
</div>

<script>
// Check if backup exists on load — show revert button if so
fetch('/api/backup-status/${EPISODE_ID}')
  .then(r => r.json())
  .then(status => {
    if (status.exists) {
      const btn = document.getElementById('revert-btn-top');
      if (btn) { btn.style.display = 'inline-block'; btn.title = 'Backup from ' + status.date; }
    }
  })
  .catch(() => {}); // no server = no revert

async function revertToOriginal() {
  const btn = document.getElementById('revert-btn-top');
  if (!confirm('Revert ALL changes to the original analysis?\\n\\nThis will:\\n- Restore scenes.json from backup\\n- Re-extract ALL frame images\\n- Rebuild the database\\n- Remove the backup file\\n\\nThis cannot be undone.')) return;

  btn.textContent = '\\u23f3 Reverting...';
  btn.classList.add('loading');

  try {
    const resp = await fetch('/api/revert/${EPISODE_ID}', { method: 'POST' });
    const result = await resp.json();

    if (result.success) {
      alert(result.message + '\\n\\nPage will reload.');
      window.location.reload();
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (e) {
    btn.textContent = '\\u21a9 Revert to Original';
    btn.classList.remove('loading');
    alert('Revert failed: ' + e.message);
  }
}

function fmtT(sec) { const m=Math.floor(sec/60),s=sec%60; return String(m).padStart(2,'0')+':'+s.toFixed(3).padStart(6,'0'); }

const corrections = {};
const lockedShots = new Set();
const FRAME_SERVER = 'http://localhost:3333';
const EPISODE_FILE = '${LOCAL_FILE.replace(/\\/g, '\\\\')}';
let frameServerOnline = false;

// Check if frame server is running
fetch(FRAME_SERVER + '/health').then(r => r.json()).then(() => {
  frameServerOnline = true;
  console.log('Frame server connected');
}).catch(() => {
  console.warn('Frame server not running. Start it with: node tng-data/frame-server.mjs');
});

let debounceTimers = {};

function adjustShot(btn, deltaMs, edge) {
  const adj = btn.closest('.adj');
  const scene = adj.dataset.scene;
  const shot = adj.dataset.shot;
  const key = 'sc' + scene + '_sh' + shot;

  // Don't adjust locked shots
  if (lockedShots.has(key)) return;

  const origStart = parseFloat(adj.dataset.start);
  const origEnd = parseFloat(adj.dataset.end);

  if (!corrections[key]) corrections[key] = { scene, shot, origStart, origEnd, startOffsetMs: 0, endOffsetMs: 0 };

  if (edge === 'start') {
    corrections[key].startOffsetMs += deltaMs;
  } else {
    corrections[key].endOffsetMs += deltaMs;
  }

  const startOffset = corrections[key].startOffsetMs;
  const endOffset = corrections[key].endOffsetMs;
  const newStart = origStart + startOffset / 1000;
  const newEnd = origEnd + endOffset / 1000;

  // Update start offset display
  const startDisplay = document.getElementById('adj-start-s' + scene + '-sh' + shot);
  if (startDisplay) {
    startDisplay.textContent = (startOffset >= 0 ? '+' : '') + startOffset + 'ms';
    startDisplay.style.color = startOffset === 0 ? '#4caf50' : '#ff9800';
  }

  // Update end offset display
  const endDisplay = document.getElementById('adj-end-s' + scene + '-sh' + shot);
  if (endDisplay) {
    endDisplay.textContent = (endOffset >= 0 ? '+' : '') + endOffset + 'ms';
    endDisplay.style.color = endOffset === 0 ? '#4caf50' : '#ff9800';
  }

  // Update timestamp displays
  const startTs = document.getElementById('adjts-start-s' + scene + '-sh' + shot);
  if (startTs) {
    const m = Math.floor(newStart / 60); const s = newStart % 60;
    startTs.textContent = String(m).padStart(2,'0') + ':' + s.toFixed(3).padStart(6,'0');
    startTs.style.color = startOffset === 0 ? '#888' : '#ff9800';
  }
  const endTs = document.getElementById('adjts-end-s' + scene + '-sh' + shot);
  if (endTs) {
    const m = Math.floor(newEnd / 60); const s = newEnd % 60;
    endTs.textContent = String(m).padStart(2,'0') + ':' + s.toFixed(3).padStart(6,'0');
    endTs.style.color = endOffset === 0 ? '#888' : '#ff9800';
  }

  const shotCard = btn.closest('.shot');
  if (startOffset !== 0 || endOffset !== 0) {
    shotCard.classList.add('adj-modified');
  } else {
    shotCard.classList.remove('adj-modified');
    delete corrections[key];
  }
  updateCount();

  // Debounce live frame fetch
  if (frameServerOnline) {
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(() => fetchLiveFrames(scene, shot, newStart, newEnd), 200);
  }
}

var offsetPreviewModal = null;
var offsetPreviewScene = null;
var offsetPreviewShot = null;

function fetchLiveFrames(scene, shot, startSec, endSec) {
  var baseUrl = FRAME_SERVER + '/frame?file=' + encodeURIComponent(EPISODE_FILE);

  // Create or reuse the offset preview modal
  if (!offsetPreviewModal || offsetPreviewScene !== scene || offsetPreviewShot !== shot) {
    closeOffsetPreviewModal();
    offsetPreviewScene = scene;
    offsetPreviewShot = shot;

    var overlay = document.createElement('div');
    overlay.className = 'offset-preview-modal-overlay';
    overlay.id = 'offset-preview-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) return; /* don't close on frame clicks */ };

    var modal = document.createElement('div');
    modal.className = 'offset-preview-modal';

    var hdr = document.createElement('div');
    hdr.className = 'opm-header';
    hdr.innerHTML = '<h4>Offset Preview \\u2014 Scene ' + scene + ' Shot ' + shot + '</h4><button class="opm-close" onclick="closeOffsetPreviewModal()">\\u2715</button>';
    modal.appendChild(hdr);

    var frames = document.createElement('div');
    frames.className = 'opm-frames';
    frames.innerHTML = '<div class="opm-frame-box"><img id="opm-start-img" /><div class="opm-edge-label">START</div></div>' +
      '<div class="opm-frame-box"><img id="opm-end-img" /><div class="opm-edge-label">END</div></div>';
    modal.appendChild(frames);

    // Adjustment controls inside modal
    var adjControls = document.createElement('div');
    adjControls.className = 'opm-adj-controls';
    adjControls.innerHTML =
      '<div class="opm-adj-row">' +
        '<span class="opm-adj-label">START</span>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,-1000,\\x27start\\x27)">-1s</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,-500,\\x27start\\x27)">-500ms</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,-100,\\x27start\\x27)">-100</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,-50,\\x27start\\x27)">-50</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,-10,\\x27start\\x27)">-10</button>' +
        '<span class="opm-adj-val" id="opm-adj-start-val">\\u00b10ms</span>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,10,\\x27start\\x27)">+10</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,50,\\x27start\\x27)">+50</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,100,\\x27start\\x27)">+100</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,500,\\x27start\\x27)">+500ms</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,1000,\\x27start\\x27)">+1s</button>' +
        '<span class="opm-adj-ts" id="opm-adj-start-ts"></span>' +
      '</div>' +
      '<div class="opm-adj-row">' +
        '<span class="opm-adj-label">END</span>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,-1000,\\x27end\\x27)">-1s</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,-500,\\x27end\\x27)">-500ms</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,-100,\\x27end\\x27)">-100</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,-50,\\x27end\\x27)">-50</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,-10,\\x27end\\x27)">-10</button>' +
        '<span class="opm-adj-val" id="opm-adj-end-val">\\u00b10ms</span>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,10,\\x27end\\x27)">+10</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,50,\\x27end\\x27)">+50</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,100,\\x27end\\x27)">+100</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,500,\\x27end\\x27)">+500ms</button>' +
        '<button onclick="adjustShotFromModal(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27,1000,\\x27end\\x27)">+1s</button>' +
        '<span class="opm-adj-ts" id="opm-adj-end-ts"></span>' +
      '</div>';
    modal.appendChild(adjControls);

    var actions = document.createElement('div');
    actions.className = 'opm-actions';
    actions.innerHTML = '<button class="lock-btn" onclick="lockShot(\\x27' + scene + '\\x27,\\x27' + shot + '\\x27); closeOffsetPreviewModal();">\\u2713 Lock In</button>';
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    offsetPreviewModal = overlay;
  }

  // Update modal timestamp displays
  updateModalTimestamps(scene, shot, startSec, endSec);

  var startImg = document.getElementById('opm-start-img');
  var endImg = document.getElementById('opm-end-img');

  if (startImg) {
    startImg.style.opacity = '0.5';
    startImg.src = baseUrl + '&t=' + startSec.toFixed(3);
    startImg.onload = function() { startImg.style.opacity = '1'; };
  }
  if (endImg) {
    endImg.style.opacity = '0.5';
    endImg.src = baseUrl + '&t=' + endSec.toFixed(3);
    endImg.onload = function() { endImg.style.opacity = '1'; };
  }
}

function closeOffsetPreviewModal() {
  if (offsetPreviewModal) {
    offsetPreviewModal.remove();
    offsetPreviewModal = null;
    offsetPreviewScene = null;
    offsetPreviewShot = null;
  }
}

function updateModalTimestamps(scene, shot, startSec, endSec) {
  var key = 'sc' + scene + '_sh' + shot;
  var corr = corrections[key];
  var startOffset = corr ? corr.startOffsetMs : 0;
  var endOffset = corr ? corr.endOffsetMs : 0;

  var startValEl = document.getElementById('opm-adj-start-val');
  if (startValEl) {
    startValEl.textContent = (startOffset >= 0 ? '+' : '') + startOffset + 'ms';
    startValEl.style.color = startOffset === 0 ? '#4caf50' : '#ff9800';
  }
  var endValEl = document.getElementById('opm-adj-end-val');
  if (endValEl) {
    endValEl.textContent = (endOffset >= 0 ? '+' : '') + endOffset + 'ms';
    endValEl.style.color = endOffset === 0 ? '#4caf50' : '#ff9800';
  }
  var startTsEl = document.getElementById('opm-adj-start-ts');
  if (startTsEl) {
    var m = Math.floor(startSec / 60); var s = startSec % 60;
    startTsEl.textContent = String(m).padStart(2,'0') + ':' + s.toFixed(3).padStart(6,'0');
    startTsEl.style.color = startOffset === 0 ? '#888' : '#ff9800';
  }
  var endTsEl = document.getElementById('opm-adj-end-ts');
  if (endTsEl) {
    var m2 = Math.floor(endSec / 60); var s2 = endSec % 60;
    endTsEl.textContent = String(m2).padStart(2,'0') + ':' + s2.toFixed(3).padStart(6,'0');
    endTsEl.style.color = endOffset === 0 ? '#888' : '#ff9800';
  }
}

function adjustShotFromModal(scene, shot, deltaMs, edge) {
  // Find the matching adj div on the page to delegate to adjustShot
  var shotCards = document.querySelectorAll('.shot');
  for (var i = 0; i < shotCards.length; i++) {
    var adj = shotCards[i].querySelector('.adj[data-edge="' + edge + '"]');
    if (adj && adj.dataset.scene === scene && adj.dataset.shot === shot) {
      var btn = adj.querySelector('button');
      adjustShot(btn, deltaMs, edge);
      return;
    }
  }
}

function lockShot(scene, shot) {
  const key = 'sc' + scene + '_sh' + shot;

  if (lockedShots.has(key)) return;
  lockedShots.add(key);

  // Find the shot card and lock it
  const shotCards = document.querySelectorAll('.shot');
  for (const card of shotCards) {
    const adj = card.querySelector('.adj');
    if (adj && adj.dataset.scene === scene && adj.dataset.shot === shot) {
      card.classList.add('locked');

      // Replace lock button with unlock
      const lockBtn = card.querySelector('.lock-btn');
      if (lockBtn) {
        lockBtn.textContent = '✓ Locked';
        lockBtn.className = 'lock-btn';

        // Add unlock button next to it
        const unlockBtn = document.createElement('button');
        unlockBtn.className = 'unlock-btn';
        unlockBtn.textContent = 'Unlock';
        unlockBtn.onclick = () => unlockShot(scene, shot, card);
        lockBtn.parentNode.appendChild(unlockBtn);
      }

      // Close the offset preview modal if open
      setTimeout(() => {
        closeOffsetPreviewModal();
      }, 500);

      // Update the static first/last frame images to the corrected timestamps
      if (corrections[key] && frameServerOnline) {
        const origStart = parseFloat(adj.dataset.start);
        const origEnd = parseFloat(adj.dataset.end);
        const newStart = origStart + (corrections[key].startOffsetMs || 0) / 1000;
        const newEnd = origEnd + (corrections[key].endOffsetMs || 0) / 1000;
        const baseUrl = FRAME_SERVER + '/frame?file=' + encodeURIComponent(EPISODE_FILE);

        // Replace static frame images
        const frameImgs = card.querySelectorAll('.fw img');
        if (frameImgs[0]) frameImgs[0].src = baseUrl + '&t=' + newStart.toFixed(3);
        if (frameImgs[1]) frameImgs[1].src = baseUrl + '&t=' + newEnd.toFixed(3);
      }
      break;
    }
  }
  updateCount();
}

function unlockShot(scene, shot, card) {
  const key = 'sc' + scene + '_sh' + shot;
  lockedShots.delete(key);
  card.classList.remove('locked');

  // Restore lock button
  const lockBtn = card.querySelector('.lock-btn');
  if (lockBtn) lockBtn.textContent = '✓ Lock In';
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
    if (startDisp) { startDisp.textContent = '±0ms'; startDisp.style.color = '#4caf50'; }
    if (endDisp) { endDisp.textContent = '±0ms'; endDisp.style.color = '#4caf50'; }
    const startTs = document.getElementById('adjts-start-s' + c.scene + '-sh' + c.shot);
    const endTs = document.getElementById('adjts-end-s' + c.scene + '-sh' + c.shot);
    if (startTs) { startTs.style.color = '#888'; }
    if (endTs) { endTs.style.color = '#888'; }
  }
  document.querySelectorAll('.adj-modified').forEach(el => el.classList.remove('adj-modified'));
  document.querySelectorAll('.locked').forEach(el => el.classList.remove('locked'));
  document.querySelectorAll('.unlock-btn').forEach(el => el.remove());
  closeOffsetPreviewModal();
  for (const key of Object.keys(corrections)) delete corrections[key];
  lockedShots.clear();
  updateCount();
}

function exportCorrections() {
  const offsetEntries = Object.values(corrections).filter(c => c.type !== 'join' && (c.startOffsetMs !== 0 || c.endOffsetMs !== 0));
  const joinEntries = Object.values(corrections).filter(c => c.type === 'join');

  if (offsetEntries.length === 0 && joinEntries.length === 0 && lockedShots.size === 0) { alert('No corrections to export.'); return; }

  const lines = offsetEntries.map(c => {
    const newStart = (c.origStart + c.startOffsetMs / 1000).toFixed(3);
    const newEnd = (c.origEnd + c.endOffsetMs / 1000).toFixed(3);
    let parts = ['Scene ' + c.scene + ', Shot ' + c.shot + ':'];
    if (c.startOffsetMs !== 0) parts.push('start ' + (c.startOffsetMs >= 0 ? '+' : '') + c.startOffsetMs + 'ms (' + c.origStart.toFixed(3) + 's -> ' + newStart + 's)');
    if (c.endOffsetMs !== 0) parts.push('end ' + (c.endOffsetMs >= 0 ? '+' : '') + c.endOffsetMs + 'ms (' + c.origEnd.toFixed(3) + 's -> ' + newEnd + 's)');
    if (lockedShots.has('sc' + c.scene + '_sh' + c.shot)) parts.push('[LOCKED]');
    return parts.join(' ');
  });

  const joinLines = joinEntries.map(c => {
    let line = 'JOIN Scene ' + c.scene + ', Shots ' + c.firstShot + '-' + c.lastShot + ' (' + fmtT(c.newStart) + ' -> ' + fmtT(c.newEnd) + ')';
    if (c.resolved && Object.keys(c.resolved).length > 0) {
      line += '\\n  Resolved: ' + Object.entries(c.resolved).map(([k,v]) => k + '="' + v + '"').join(', ');
    }
    return line;
  });

  const lockedOnly = [...lockedShots].filter(k => !corrections[k]).map(k => {
    const parts = k.match(/sc(\\d+)_sh(\\d+)/);
    return parts ? 'Scene ' + parts[1] + ', Shot ' + parts[2] + ': [LOCKED - no changes]' : k;
  });

  const allLines = [...lines, ...joinLines, ...lockedOnly];

  if (allLines.length === 0) {
    alert('No pending changes.');
    return;
  }

  // Show in a modal instead of clipboard
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:200;display:flex;align-items:center;justify-content:center';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  var modal = document.createElement('div');
  modal.style.cssText = 'background:#1a1a2e;border-radius:12px;padding:24px;width:600px;max-width:90vw;max-height:80vh;overflow-y:auto;border:1px solid #333';

  var title = document.createElement('h3');
  title.style.cssText = 'color:#4fc3f7;margin-bottom:12px';
  title.textContent = 'Pending Changes (' + allLines.length + ')';
  modal.appendChild(title);

  var summary = document.createElement('div');
  summary.style.cssText = 'color:#888;font-size:12px;margin-bottom:12px';
  summary.textContent = offsetEntries.length + ' timestamp corrections, ' + joinEntries.length + ' joins, ' + lockedOnly.length + ' locked';
  modal.appendChild(summary);

  allLines.forEach(function(line) {
    var row = document.createElement('div');
    row.style.cssText = 'padding:6px 8px;margin-bottom:4px;background:#0a0a1a;border-radius:4px;font-family:monospace;font-size:11px;color:#eee;border-left:3px solid ' + (line.startsWith('JOIN') ? '#ff9800' : line.includes('LOCKED') ? '#4caf50' : '#4fc3f7');
    row.textContent = line;
    modal.appendChild(row);
  });

  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:16px;justify-content:flex-end';

  var copyBtn = document.createElement('button');
  copyBtn.style.cssText = 'background:#333;color:#eee;border:none;padding:8px 16px;border-radius:4px;cursor:pointer';
  copyBtn.textContent = '📋 Copy to Clipboard';
  copyBtn.onclick = function() {
    var text = 'SCENE REVIEW CORRECTIONS\\nEpisode: ${EPISODE_ID}\\nDate: ' + new Date().toISOString().slice(0,10) + '\\n\\n' + allLines.join('\\n');
    navigator.clipboard.writeText(text);
    copyBtn.textContent = '✅ Copied!';
    setTimeout(function() { copyBtn.textContent = '📋 Copy to Clipboard'; }, 2000);
  };
  btnRow.appendChild(copyBtn);

  var closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'background:#4fc3f7;color:#000;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:bold';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = function() { overlay.remove(); };
  btnRow.appendChild(closeBtn);

  modal.appendChild(btnRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

async function applyCorrections() {
  const offsetEntries = Object.values(corrections).filter(c => c.type !== 'join' && (c.startOffsetMs !== 0 || c.endOffsetMs !== 0));

  if (offsetEntries.length === 0) {
    alert('No timestamp corrections to apply. Use the \\u00b1ms buttons to adjust shot timestamps first.');
    return;
  }

  const btn = document.querySelector('.apply-btn');
  if (!confirm('Apply ' + offsetEntries.length + ' correction(s) to scenes.json?\\n\\nThis will:\\n- Update timestamps in scenes.json\\n- Re-extract affected frame images\\n- Rebuild the database index')) return;

  btn.textContent = '⏳ Applying...';
  btn.classList.add('loading');

  try {
    const payload = {
      episodeId: '${EPISODE_ID}',
      corrections: offsetEntries.map(c => ({
        scene: c.scene,
        shot: c.shot,
        startOffsetMs: c.startOffsetMs || 0,
        endOffsetMs: c.endOffsetMs || 0
      }))
    };

    const resp = await fetch('/api/apply-corrections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await resp.json();

    if (result.success) {
      btn.textContent = '✅ Applied!';
      btn.classList.remove('loading');

      // Refresh affected frame images (cache bust)
      const bust = Date.now();
      offsetEntries.forEach(c => {
        const imgs = document.querySelectorAll('img[src*="sc' + c.scene + '_sh' + c.shot + '_"]');
        imgs.forEach(img => { img.src = img.src.split('?')[0] + '?v=' + bust; });
      });

      // Clear applied corrections
      offsetEntries.forEach(c => {
        const key = 'sc' + c.scene + '_sh' + c.shot;
        delete corrections[key];
        lockedShots.delete(key);
      });
      updateCount();

      alert(result.message + '\\n\\nFrame images refreshed. Corrections have been cleared.');
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (e) {
    btn.textContent = '❌ Failed';
    btn.classList.remove('loading');
    alert('Failed to apply corrections: ' + e.message);
    setTimeout(() => { btn.textContent = '✅ Apply Corrected Timestamps'; }, 3000);
  }
}

// --- Reanalyze Shot ---
async function reanalyzeShot(scene, shot, btn) {
  const origText = btn.textContent;
  if (!confirm('Reanalyze Scene ' + scene + ' Shot ' + shot + '?\\n\\nThis will:\\n- Send the shot\\'s time range to Gemini 2.5 Pro\\n- Split it into finer shots based on camera cuts\\n- Re-extract frames and rebuild the report\\n- Cost: ~$0.15-0.30\\n\\nThe page will reload when complete.')) return;

  btn.textContent = '\\u23f3 Starting...';
  btn.classList.add('loading');

  try {
    // Start the background job
    const resp = await fetch('/api/reanalyze-shot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId: '${EPISODE_ID}', sceneNumber: scene, shotNumber: shot })
    });

    const startResult = await resp.json();
    if (startResult.error) { throw new Error(startResult.error); }

    // Poll for completion
    btn.textContent = '\\u23f3 Analyzing...';
    const pollInterval = setInterval(async () => {
      try {
        const statusResp = await fetch('/api/reanalyze-status/${EPISODE_ID}');
        const status = await statusResp.json();

        if (status.step) btn.textContent = '\\u23f3 ' + status.step;

        if (status.status === 'done') {
          clearInterval(pollInterval);
          alert(status.message || 'Reanalysis complete!');
          window.location.reload();
        } else if (status.status === 'error') {
          clearInterval(pollInterval);
          throw new Error(status.error || 'Unknown error');
        }
      } catch (e) {
        clearInterval(pollInterval);
        btn.textContent = origText;
        btn.classList.remove('loading');
        alert('Reanalyze failed: ' + e.message);
      }
    }, 2000); // Poll every 2 seconds
  } catch (e) {
    btn.textContent = origText;
    btn.classList.remove('loading');
    alert('Reanalyze failed: ' + e.message);
  }
}

// --- Video Panel (Floating) ---
let vpStartSec = 0, vpEndSec = 0;
let vpTimeCheck = null;
let vpTimecodeRAF = null;

function vpClose() {
  const panel = document.getElementById('video-panel');
  const video = document.getElementById('vp-video');
  if (video && !video.paused) video.pause();
  clearInterval(vpTimeCheck);
  cancelAnimationFrame(vpTimecodeRAF);
  // Hide panel, show icon
  panel.style.display = 'none';
  document.getElementById('vp-icon').style.display = 'flex';
}

function vpOpen() {
  const panel = document.getElementById('video-panel');
  panel.style.display = '';
  panel.style.right = '20px';
  panel.style.bottom = '60px';
  panel.style.left = 'auto';
  panel.style.top = 'auto';
  document.getElementById('vp-icon').style.display = 'none';
}

function vpFmtClip(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + s.toFixed(1).padStart(4, '0');
}

function vpUpdateTimecode() {
  const video = document.getElementById('vp-video');
  const tc = document.getElementById('vp-timecode');
  if (!video || !tc) return;
  const elapsed = Math.max(0, video.currentTime - vpStartSec);
  const duration = Math.max(0, vpEndSec - vpStartSec);
  tc.textContent = vpFmtClip(elapsed) + ' / ' + vpFmtClip(duration);
  if (!video.paused) vpTimecodeRAF = requestAnimationFrame(vpUpdateTimecode);
}

function vpStartPlayback() {
  const video = document.getElementById('vp-video');
  video.play();
  cancelAnimationFrame(vpTimecodeRAF);
  vpTimecodeRAF = requestAnimationFrame(vpUpdateTimecode);
  clearInterval(vpTimeCheck);
  vpTimeCheck = setInterval(() => {
    if (video.currentTime >= vpEndSec) {
      if (document.getElementById('vp-loop').checked) {
        video.currentTime = vpStartSec;
      } else {
        video.pause();
        clearInterval(vpTimeCheck);
      }
    }
  }, 100);
}

function playShot(scene, shot, startSec, endSec, subject, shotType) {
  // Show the panel
  document.getElementById('video-panel').style.display = '';
  document.getElementById('vp-icon').style.display = 'none';

  const video = document.getElementById('vp-video');
  const info = document.getElementById('vp-info');

  // Apply frame offsets to compensate for keyframe-based seeking
  // +0.7s on start (seek slightly later to land inside the shot, not the previous one)
  // -0.7s on end (stop slightly earlier to not show the next shot)
  var VP_START_OFFSET = 0.1;
  var VP_END_OFFSET = 0.1;
  vpStartSec = startSec + VP_START_OFFSET;
  vpEndSec = endSec - VP_END_OFFSET;
  info.innerHTML = '<span class="vp-label">Scene ' + scene + ' Shot ' + shot + '</span> [' + shotType + '] <span class="vp-subject">' + subject + '</span> (' + (endSec - startSec).toFixed(1) + 's)';

  const videoUrl = FRAME_SERVER + '/video?file=' + encodeURIComponent(EPISODE_FILE);

  if (!video.src || video.src === '' || video.src === window.location.href) {
    // First load — set source with preload
    video.preload = 'auto';
    video.src = videoUrl;
  }

  // Always: seek first, wait for data at that position, then play
  video.pause();
  video.currentTime = startSec;

  function tryPlay() {
    // Check if we have enough data buffered at the seek position
    const buffered = video.buffered;
    let ready = false;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= startSec && buffered.end(i) >= startSec + 0.5) {
        ready = true;
        break;
      }
    }
    if (ready || video.readyState >= 3) {
      vpStartPlayback();
    } else {
      // Wait for more data
      video.addEventListener('canplay', function onCan() {
        video.removeEventListener('canplay', onCan);
        vpStartPlayback();
      }, { once: true });
      // Fallback timeout — play anyway after 500ms
      setTimeout(() => {
        if (video.paused) vpStartPlayback();
      }, 500);
    }
  }

  video.addEventListener('seeked', function onSeeked() {
    video.removeEventListener('seeked', onSeeked);
    tryPlay();
  }, { once: true });
}

function vpReplay() {
  const video = document.getElementById('vp-video');
  if (!video || !video.src) return;
  video.currentTime = vpStartSec;
  video.play();
  cancelAnimationFrame(vpTimecodeRAF);
  vpTimecodeRAF = requestAnimationFrame(vpUpdateTimecode);
  clearInterval(vpTimeCheck);
  vpTimeCheck = setInterval(() => {
    if (video.currentTime >= vpEndSec) {
      if (document.getElementById('vp-loop').checked) {
        video.currentTime = vpStartSec;
      } else {
        video.pause();
        clearInterval(vpTimeCheck);
      }
    }
  }, 100);
}

function vpSpeed(rate) {
  document.getElementById('vp-video').playbackRate = rate;
  document.querySelectorAll('.vp-speed').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
}

function vpPlayPause() {
  const video = document.getElementById('vp-video');
  if (!video || !video.src) return;
  if (video.paused) {
    vpStartPlayback();
  } else {
    video.pause();
    clearInterval(vpTimeCheck);
  }
}

function vpStop() {
  const video = document.getElementById('vp-video');
  if (!video || !video.src) return;
  video.pause();
  video.currentTime = vpStartSec;
  clearInterval(vpTimeCheck);
  cancelAnimationFrame(vpTimecodeRAF);
  vpUpdateTimecode();
}

function vpMute() {
  const video = document.getElementById('vp-video');
  if (!video) return;
  video.muted = !video.muted;
  document.getElementById('vp-mute').innerHTML = video.muted ? '&#128263;' : '&#128264;';
}

// Update play/pause button icon
function vpUpdatePlayBtn() {
  const video = document.getElementById('vp-video');
  const btn = document.getElementById('vp-playpause');
  if (video && btn) btn.innerHTML = video.paused ? '&#9654;' : '&#9208;';
}

// Update timecode on pause/play
document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('vp-video');
  if (video) {
    video.addEventListener('pause', () => { cancelAnimationFrame(vpTimecodeRAF); vpUpdateTimecode(); vpUpdatePlayBtn(); });
    video.addEventListener('play', () => { vpTimecodeRAF = requestAnimationFrame(vpUpdateTimecode); vpUpdatePlayBtn(); });
    video.addEventListener('seeked', vpUpdateTimecode);

    // Make player draggable by header
    const panel = document.getElementById('video-panel');
    const header = panel.querySelector('.vp-header');
    let isDragging = false, dragX = 0, dragY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      dragX = e.clientX - panel.offsetLeft;
      dragY = e.clientY - panel.offsetTop;
      panel.style.transition = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panel.style.left = (e.clientX - dragX) + 'px';
      panel.style.top = (e.clientY - dragY) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      isDragging = false;
      panel.style.transition = 'all 0.3s';
    });
  }
});

// --- Search / Filter ---
let searchTimer = null;

function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(filterShots, 150);
}

function filterShots() {
  const query = document.getElementById('search-input').value.toLowerCase().trim();
  const scope = document.getElementById('search-scope').value;
  const clearBtn = document.getElementById('search-clear');
  const countEl = document.getElementById('search-count');

  clearBtn.style.display = query ? 'block' : 'none';

  if (!query) {
    document.querySelectorAll('.shot, .scene').forEach(el => el.classList.remove('search-hidden'));
    countEl.textContent = '';
    return;
  }

  let visible = 0, total = 0;
  const searchScenes = scope === 'scenes' || scope === 'both';
  const searchShots = scope === 'shots' || scope === 'both';

  document.querySelectorAll('.scene').forEach(sceneEl => {
    let sceneHasMatch = false;

    // Check scene-level text
    let sceneMatch = false;
    if (searchScenes) {
      const sceneText = (sceneEl.querySelector('.scene-hdr')?.textContent || '').toLowerCase() +
                        (sceneEl.querySelector('.plot')?.textContent || '').toLowerCase() +
                        (sceneEl.querySelector('.scene-details')?.textContent || '').toLowerCase();
      sceneMatch = sceneText.includes(query);
    }

    sceneEl.querySelectorAll('.shot').forEach(shotEl => {
      total++;
      let shotMatch = false;
      if (searchShots) {
        shotMatch = shotEl.textContent.toLowerCase().includes(query);
      }

      if (shotMatch || sceneMatch) {
        shotEl.classList.remove('search-hidden');
        sceneHasMatch = true;
        visible++;
      } else {
        shotEl.classList.add('search-hidden');
      }
    });

    if (sceneHasMatch || (sceneMatch && scope === 'scenes')) {
      sceneEl.classList.remove('search-hidden');
      if (sceneMatch && scope === 'scenes') {
        // In scenes-only mode, show all shots when the scene matches
        sceneEl.querySelectorAll('.shot').forEach(s => { s.classList.remove('search-hidden'); visible++; });
      }
    } else {
      sceneEl.classList.add('search-hidden');
    }
  });

  const label = scope === 'scenes' ? 'scenes' : 'shots';
  countEl.textContent = visible + ' of ' + total + ' ' + label;
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  filterShots();
}

// --- Cancel (reset both edges and hide preview) ---
function cancelShot(scene, shot) {
  const key = 'sc' + scene + '_sh' + shot;
  if (lockedShots.has(key)) return;
  const c = corrections[key];
  if (!c) {
    // No corrections — just close the preview modal
    closeOffsetPreviewModal();
    return;
  }
  // Reset both edges
  ['start','end'].forEach(edge => {
    const origVal = edge === 'start' ? c.origStart : c.origEnd;
    const d = document.getElementById('adj-' + edge + '-s' + scene + '-sh' + shot);
    if (d) { d.textContent = '\\u00b10ms'; d.style.color = '#4caf50'; }
    const t = document.getElementById('adjts-' + edge + '-s' + scene + '-sh' + shot);
    if (t) { t.textContent = fmtT(origVal); t.style.color = '#888'; }
    // Reset frame image
    if (frameServerOnline) {
      const base = FRAME_SERVER + '/frame?file=' + encodeURIComponent(EPISODE_FILE);
      const shotCards = document.querySelectorAll('.shot');
      for (const card of shotCards) {
        const adj = card.querySelector('.adj');
        if (adj && adj.dataset.scene === scene && adj.dataset.shot === shot) {
          const imgs = card.querySelectorAll('.fw img');
          if (edge === 'start' && imgs[0]) imgs[0].src = base + '&t=' + origVal.toFixed(3);
          if (edge === 'end' && imgs[1]) imgs[1].src = base + '&t=' + origVal.toFixed(3);
        }
      }
    }
  });
  delete corrections[key];
  // Remove modified class and hide preview
  const shotCards = document.querySelectorAll('.shot');
  for (const card of shotCards) {
    const adj = card.querySelector('.adj');
    if (adj && adj.dataset.scene === scene && adj.dataset.shot === shot) {
      card.classList.remove('adj-modified');
    }
  }
  const p = document.getElementById('preview-s' + scene + '-sh' + shot);
  if (p) p.style.display = 'none';
  updateCount();
}

// --- Join Shots ---
function updateJoinBtn() {
  const checked = document.querySelectorAll('.shot-cb:checked');
  const joinBtn = document.getElementById('join-btn');
  const joinCount = document.getElementById('join-count');
  const unselectBtn = document.getElementById('unselect-btn');
  if (checked.length >= 2) {
    joinBtn.classList.add('visible');
    joinCount.classList.add('visible');
    joinCount.textContent = checked.length + ' selected';
  } else {
    joinBtn.classList.remove('visible');
    joinCount.classList.remove('visible');
    joinCount.textContent = '';
  }
  if (checked.length >= 1) {
    unselectBtn.classList.add('visible');
  } else {
    unselectBtn.classList.remove('visible');
  }
}

function unselectAll() {
  document.querySelectorAll('.shot-cb:checked').forEach(cb => { cb.checked = false; });
  updateJoinBtn();
}

function joinShots() {
  const checked = [...document.querySelectorAll('.shot-cb:checked')];
  if (checked.length < 2) { alert('Select at least 2 shots to join.'); return; }

  // Get scene/shot info for each checked box
  const items = checked.map(cb => {
    const shotEl = cb.closest('.shot');
    return {
      scene: parseInt(shotEl.dataset.sc),
      shot: parseInt(shotEl.dataset.sh),
      start: parseFloat(shotEl.dataset.start),
      end: parseFloat(shotEl.dataset.end),
      el: shotEl,
      cb: cb
    };
  });

  // Check all shots are in the same scene
  const scenes = new Set(items.map(i => i.scene));
  if (scenes.size > 1) {
    alert('Cannot join shots from different scenes.\\n\\nSelected shots span scenes: ' + [...scenes].sort((a,b)=>a-b).join(', ') + '\\n\\nPlease select shots within a single scene only.');
    return;
  }

  // Sort by shot number
  items.sort((a, b) => a.shot - b.shot);

  // Check shots are consecutive
  for (let i = 1; i < items.length; i++) {
    if (items[i].shot !== items[i-1].shot + 1) {
      alert('Shots must be consecutive to join.\\n\\nSelected: ' + items.map(i => 'Shot ' + i.shot).join(', ') + '\\n\\nThere are gaps between these shot numbers.');
      return;
    }
  }

  const sceneNum = items[0].scene;
  const firstShot = items[0].shot;
  const lastShot = items[items.length - 1].shot;
  const newStart = items[0].start;
  const newEnd = items[items.length - 1].end;
  const dur = (newEnd - newStart).toFixed(1);

  // Collect metadata from each shot's DOM — extract every field reliably
  function getShotMeta(el) {
    const meta = {
      subject: '',
      shotType: '',
      action: '',
      camera: '',
      expressions: '',
      dialogue: '',
    };

    // Subject
    const subjEl = el.querySelector('.subj');
    if (subjEl) meta.subject = subjEl.textContent.trim();

    // Shot type
    const stEl = el.querySelector('.st');
    if (stEl) meta.shotType = stEl.textContent.trim();

    // Camera
    const camEl = el.querySelector('.cam');
    if (camEl) meta.camera = camEl.textContent.trim();

    // Walk all .f fields to find action and expressions by their label
    el.querySelectorAll('.f').forEach(f => {
      const label = (f.querySelector('.fl2')?.textContent || '').trim().toLowerCase();
      const value = [...f.querySelectorAll('div:not(.fl2), span:not(.fl2)')].map(e => e.textContent.trim()).join(' ').trim();
      if (label === 'action') meta.action = value || (f.textContent.replace(/action/i, '').trim());
      if (label === 'expressions') meta.expressions = value || (f.textContent.replace(/expressions/i, '').trim());
    });

    // Dialogue
    const dlLines = el.querySelectorAll('.dl');
    if (dlLines.length > 0) {
      meta.dialogue = [...dlLines].map(d => d.textContent.trim()).join(' | ');
    }

    return meta;
  }

  const metas = items.map(i => ({ shot: i.shot, ...getShotMeta(i.el) }));

  // Build conflicts for ALL metadata fields — always show resolution when values differ
  const fields = [
    { key: 'subject', label: 'Subject' },
    { key: 'shotType', label: 'Shot Type' },
    { key: 'action', label: 'Action' },
    { key: 'camera', label: 'Camera Movement' },
    { key: 'expressions', label: 'Expressions' },
    { key: 'dialogue', label: 'Dialogue' },
  ];
  const conflicts = [];
  for (const { key, label } of fields) {
    const vals = metas.map(m => m[key]).filter(Boolean);
    const unique = [...new Set(vals)];
    if (unique.length > 1) {
      conflicts.push({ field: key, label, values: unique, metas });
    } else if (unique.length === 1) {
      // No conflict — all same value, no resolution needed
    }
  }

  // If no conflicts, auto-execute with combine-all defaults
  if (conflicts.length === 0) {
    autoJoin(items, metas, conflicts, sceneNum, firstShot, lastShot, newStart, newEnd, dur);
    return;
  }

  // Show dialog for conflict resolution
  showJoinDialog(items, metas, conflicts, sceneNum, firstShot, lastShot, newStart, newEnd, dur);
}

function autoJoin(items, metas, conflicts, sceneNum, firstShot, lastShot, newStart, newEnd, dur) {
  // Create a fake dialog element with stored data so executeJoin works
  const dialog = document.createElement('div');
  dialog.id = 'join-dialog';
  dialog.style.display = 'none';
  dialog._joinData = { items, metas, conflicts, sceneNum, firstShot, lastShot, newStart, newEnd, dur };
  document.body.appendChild(dialog);
  executeJoin();
}

function showJoinDialog(items, metas, conflicts, sceneNum, firstShot, lastShot, newStart, newEnd, dur) {
  // Remove old dialog if any
  const old = document.getElementById('join-dialog');
  if (old) old.remove();

  const dialog = document.createElement('div');
  dialog.id = 'join-dialog';
  dialog.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:60;display:flex;align-items:center;justify-content:center';

  let conflictHtml = '';
  if (conflicts.length > 0) {
    conflictHtml = '<div style="margin:16px 0"><h4 style="color:#ff9800;margin-bottom:10px">Resolve Conflicts (' + conflicts.length + ' fields differ)</h4>';
    for (const c of conflicts) {
      const isLong = c.field === 'action' || c.field === 'dialogue' || c.field === 'expressions';
      conflictHtml += '<div style="margin-bottom:12px;padding:10px;background:#1a1a2e;border-radius:6px">';
      conflictHtml += '<div style="color:#ff9800;font-size:12px;font-weight:bold;margin-bottom:6px">' + (c.label || c.field) + '</div>';

      // Combine all option (DEFAULT)
      conflictHtml += '<label style="display:block;padding:6px 0;cursor:pointer;font-size:12px;border-bottom:1px solid #222">' +
        '<input type="radio" name="join-' + c.field + '" value="combine" checked style="margin-right:6px">' +
        '<span style="color:#4fc3f7;font-weight:bold">Combine all values</span></label>';

      // Option for each unique value
      for (let i = 0; i < c.values.length; i++) {
        const shotNums = c.metas.filter(m => m[c.field] === c.values[i]).map(m => m.shot).join(', ');
        const displayVal = isLong ? c.values[i].slice(0, 200) + (c.values[i].length > 200 ? '...' : '') : c.values[i];
        conflictHtml += '<label style="display:block;padding:4px 0;cursor:pointer;font-size:12px;border-bottom:1px solid #222">' +
          '<input type="radio" name="join-' + c.field + '" value="' + i + '" style="margin-right:6px;vertical-align:top;margin-top:2px">' +
          '<span style="color:#ce93d8">Shot ' + shotNums + ':</span> ' +
          '<span style="color:#ddd">' + displayVal + '</span></label>';
      }

      // Custom option
      const inputType = isLong ? 'textarea' : 'input type="text"';
      const inputStyle = isLong
        ? 'style="background:#0d0d1a;color:#eee;border:1px solid #444;padding:4px 6px;border-radius:3px;font-size:12px;width:100%;height:40px;resize:vertical;margin-top:4px;display:block"'
        : 'style="background:#0d0d1a;color:#eee;border:1px solid #444;padding:3px 6px;border-radius:3px;font-size:12px;width:300px"';
      conflictHtml += '<label style="display:block;padding:4px 0;cursor:pointer;font-size:12px">' +
        '<input type="radio" name="join-' + c.field + '" value="custom" style="margin-right:6px">' +
        '<span style="color:#81c784">Custom:</span> ' +
        (isLong
          ? '<textarea id="join-custom-' + c.field + '" ' + inputStyle + ' placeholder="Type custom value..."></textarea>'
          : '<input type="text" id="join-custom-' + c.field + '" ' + inputStyle + ' placeholder="Type custom value...">') +
        '</label>';

      conflictHtml += '</div>';
    }
    conflictHtml += '</div>';
  } else {
    conflictHtml = '<div style="color:#4caf50;margin:12px 0">No conflicts — all shots have matching metadata.</div>';
  }

  // Shot preview summary
  let previewHtml = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">';
  for (const item of items) {
    const imgs = item.el.querySelectorAll('.fw img');
    const src = imgs[0]?.src || '';
    previewHtml += '<div style="text-align:center"><img src="' + src + '" style="width:80px;border-radius:4px;border:1px solid #333"><div style="font-size:9px;color:#888">Shot ' + item.shot + '</div></div>';
  }
  previewHtml += '</div>';

  dialog.innerHTML = '<div style="background:#0d0d1a;padding:24px;border-radius:12px;max-width:600px;max-height:80vh;overflow-y:auto;border:1px solid #333">' +
    '<h3 style="color:#4fc3f7;margin-bottom:8px">Join Shots ' + firstShot + '-' + lastShot + '</h3>' +
    '<div style="color:#888;font-size:12px">Scene ' + sceneNum + ' | ' + fmtT(newStart) + ' \\u2192 ' + fmtT(newEnd) + ' (' + dur + 's)</div>' +
    previewHtml +
    conflictHtml +
    '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid #333">' +
    '<button onclick="document.getElementById(\\x27join-dialog\\x27).remove()" style="background:#333;color:#aaa;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:13px">Cancel</button>' +
    '<button onclick="executeJoin()" style="background:#ff9800;color:#000;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold">\\u2713 Join Shots Now</button>' +
    '</div></div>';

  // Store data for executeJoin
  dialog._joinData = { items, metas, conflicts, sceneNum, firstShot, lastShot, newStart, newEnd, dur };
  document.body.appendChild(dialog);
}

function executeJoin() {
  const dialog = document.getElementById('join-dialog');
  if (!dialog) return;
  const { items, metas, conflicts, sceneNum, firstShot, lastShot, newStart, newEnd, dur } = dialog._joinData;

  // Resolve conflicts
  const resolved = {};
  for (const c of conflicts) {
    const selected = document.querySelector('input[name="join-' + c.field + '"]:checked');
    if (!selected) continue;
    if (selected.value === 'combine') {
      resolved[c.field] = c.values.join('; ');
    } else if (selected.value === 'custom') {
      resolved[c.field] = document.getElementById('join-custom-' + c.field)?.value || c.values[0];
    } else {
      resolved[c.field] = c.values[parseInt(selected.value)];
    }
  }

  dialog.remove();

  // Apply join visually
  const first = items[0];
  const rest = items.slice(1);

  first.el.dataset.end = newEnd.toFixed(3);
  const endTs = first.el.querySelector('[id^=adjts-end]');
  if (endTs) endTs.textContent = fmtT(newEnd);

  const lastItem = items[items.length - 1];
  const firstImgs = first.el.querySelectorAll('.fw img');
  const lastImgs = lastItem.el.querySelectorAll('.fw img');
  if (firstImgs[1] && lastImgs[1]) firstImgs[1].src = lastImgs[1].src;

  const endLabel = first.el.querySelectorAll('.fl');
  if (endLabel[1]) endLabel[1].textContent = '\\u25fc ' + fmtT(newEnd);

  const durBadge = first.el.querySelector('.dur');
  if (durBadge) durBadge.textContent = dur + 's';

  const ttSpan = first.el.querySelector('.tt');
  if (ttSpan) ttSpan.textContent = fmtT(newStart) + ' \\u2192 ' + fmtT(newEnd);

  // For non-conflicting fields, combine values from all shots (keep all data)
  const allFields = ['subject', 'shotType', 'action', 'camera', 'expressions', 'dialogue'];
  for (const field of allFields) {
    if (!resolved[field]) {
      // No conflict resolution chosen — combine all unique values
      const vals = metas.map(m => m[field]).filter(Boolean);
      const unique = [...new Set(vals)];
      if (unique.length > 1) {
        resolved[field] = unique.join('; ');
      } else if (unique.length === 1) {
        resolved[field] = unique[0];
      }
    }
  }

  // Apply all resolved metadata to the first shot's display
  if (resolved.subject) {
    const subj = first.el.querySelector('.subj');
    if (subj) subj.textContent = resolved.subject;
  }
  if (resolved.shotType) {
    const st = first.el.querySelector('.st');
    if (st) st.textContent = resolved.shotType;
  }
  if (resolved.action) {
    // Find the Action field div
    first.el.querySelectorAll('.f').forEach(f => {
      const label = (f.querySelector('.fl2')?.textContent || '').trim().toLowerCase();
      if (label === 'action') {
        const div = f.querySelector('div:not(.fl2)');
        if (div) div.textContent = resolved.action;
      }
    });
  }
  if (resolved.camera) {
    const cam = first.el.querySelector('.cam');
    if (cam) cam.textContent = resolved.camera;
  }
  if (resolved.expressions) {
    first.el.querySelectorAll('.f').forEach(f => {
      const label = (f.querySelector('.fl2')?.textContent || '').trim().toLowerCase();
      if (label === 'expressions') {
        const div = f.querySelector('div:not(.fl2)');
        if (div) div.innerHTML = resolved.expressions;
      }
    });
  }
  if (resolved.dialogue) {
    // Find or create dialogue section
    let dlSection = first.el.querySelector('.dialogue');
    if (!dlSection) {
      // Create a dialogue section if the first shot didn't have one
      const si = first.el.querySelector('.si');
      if (si) {
        const newDl = document.createElement('div');
        newDl.className = 'f dialogue';
        newDl.innerHTML = '<span class="fl2">Dialogue</span><div class="dialogue-lines"></div>';
        // Insert before the adjustment controls
        const firstAdj = si.querySelector('.adj');
        if (firstAdj) si.insertBefore(newDl, firstAdj);
        else si.appendChild(newDl);
        dlSection = newDl;
      }
    }
    if (dlSection) {
      const dlLines = dlSection.querySelector('.dialogue-lines');
      if (dlLines) {
        dlLines.innerHTML = resolved.dialogue.split(' | ').map(line => '<div class="dl">' + line + '</div>').join('');
      }
    }
  }

  first.el.style.borderLeftColor = '#ff9800';
  first.el.querySelector('h4').innerHTML += ' <span style="color:#ff9800;font-size:10px">(joined ' + items.length + ' shots)</span>';

  rest.forEach(item => {
    item.el.style.display = 'none';
    item.el.classList.add('joined-hidden');
  });

  // Record the join as a correction with resolved metadata
  const joinKey = 'join-sc' + sceneNum + '-sh' + firstShot + '-' + lastShot;
  corrections[joinKey] = {
    type: 'join',
    scene: sceneNum,
    firstShot: firstShot,
    lastShot: lastShot,
    origShots: items.map(i => i.shot),
    newStart: newStart,
    newEnd: newEnd,
    resolved: resolved
  };

  document.querySelectorAll('.shot-cb:checked').forEach(cb => { cb.checked = false; });
  updateJoinBtn();
  updateCount();

  // Save the join to scenes.json via API
  saveJoinToServer(sceneNum, firstShot, lastShot, newStart, newEnd, resolved, items);
}

function saveJoinToServer(sceneNum, firstShot, lastShot, newStart, newEnd, resolved, items) {
  fetch('/api/source-json/${EPISODE_ID}')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var scenes = JSON.parse(data.json);
      var scene = scenes.find(function(s) { return s.sceneNumber === parseInt(sceneNum); });
      if (!scene || !scene.shots) throw new Error('Scene not found');

      // Find the shots to join
      var shotNums = items.map(function(i) { return parseInt(i.shot); });
      var firstIdx = scene.shots.findIndex(function(s) { return s.shotNumber === shotNums[0]; });
      if (firstIdx === -1) throw new Error('First shot not found');

      // Build merged shot from the first shot
      var merged = JSON.parse(JSON.stringify(scene.shots[firstIdx]));
      var lastShotObj = scene.shots.find(function(s) { return s.shotNumber === shotNums[shotNums.length - 1]; });

      // Update timestamps
      merged.endTimestamp = lastShotObj ? lastShotObj.endTimestamp : merged.endTimestamp;
      merged._frameLast = lastShotObj ? lastShotObj._frameLast : merged._frameLast;

      // Apply resolved metadata
      if (resolved.subject) merged.subject = resolved.subject;
      if (resolved.shotType) merged.shotType = resolved.shotType;
      if (resolved.action) merged.action = resolved.action;
      if (resolved.camera) merged.cameraMovement = resolved.camera;
      if (resolved.expressions) {
        // Merge expression objects from all shots
        merged.characterExpressions = {};
        scene.shots.filter(function(s) { return shotNums.includes(s.shotNumber); }).forEach(function(s) {
          if (s.characterExpressions) {
            Object.entries(s.characterExpressions).forEach(function(entry) {
              var existing = merged.characterExpressions[entry[0]];
              merged.characterExpressions[entry[0]] = existing ? existing + ', ' + entry[1] : entry[1];
            });
          }
        });
      }
      if (resolved.dialogue) {
        // Combine dialogue arrays from all shots
        merged.dialogue = [];
        scene.shots.filter(function(s) { return shotNums.includes(s.shotNumber); }).forEach(function(s) {
          if (s.dialogue) merged.dialogue = merged.dialogue.concat(s.dialogue);
        });
      }

      // Merge tags and supercutPotential
      var allTags = new Set();
      var allSupercut = new Set();
      scene.shots.filter(function(s) { return shotNums.includes(s.shotNumber); }).forEach(function(s) {
        (s.tags || []).forEach(function(t) { allTags.add(t); });
        (s.supercutPotential || []).forEach(function(t) { allSupercut.add(t); });
      });
      merged.tags = [...allTags];
      merged.supercutPotential = [...allSupercut];

      // Remove joined shots and keep merged
      scene.shots = scene.shots.filter(function(s) { return !shotNums.includes(s.shotNumber) || s.shotNumber === shotNums[0]; });
      scene.shots[scene.shots.findIndex(function(s) { return s.shotNumber === shotNums[0]; })] = merged;

      // Renumber shots
      scene.shots.forEach(function(s, i) { s.shotNumber = i + 1; });

      // Save back
      return fetch('/api/save-json/${EPISODE_ID}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: JSON.stringify(scenes, null, 2) })
      });
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (result.success) {
        // Reload after save completes
        setTimeout(function() { location.reload(); }, 1500);
      } else {
        alert('Join saved visually but failed to persist: ' + (result.error || 'unknown'));
      }
    })
    .catch(function(e) {
      alert('Join saved visually but failed to persist: ' + e.message);
    });
}

// --- Per-Edge Reset ---
function resetEdge(btn, edge) {
  const adj = btn.closest('.adj');
  const scene = adj.dataset.scene;
  const shot = adj.dataset.shot;
  const key = 'sc' + scene + '_sh' + shot;
  if (lockedShots.has(key)) return;

  if (!corrections[key]) return;

  if (edge === 'start') corrections[key].startOffsetMs = 0;
  else corrections[key].endOffsetMs = 0;

  const origVal = edge === 'start' ? corrections[key].origStart : corrections[key].origEnd;

  const d = document.getElementById('adj-' + edge + '-s' + scene + '-sh' + shot);
  if (d) { d.textContent = '\\u00b10ms'; d.style.color = '#4caf50'; }
  const t = document.getElementById('adjts-' + edge + '-s' + scene + '-sh' + shot);
  if (t) {
    const m = Math.floor(origVal / 60); const s = origVal % 60;
    t.textContent = String(m).padStart(2,'0') + ':' + s.toFixed(3).padStart(6,'0');
    t.style.color = '#888';
  }

  if (corrections[key].startOffsetMs === 0 && corrections[key].endOffsetMs === 0) {
    delete corrections[key];
    btn.closest('.shot')?.classList.remove('adj-modified');
  }

  // Update the frame thumbnail to show the original timestamp
  if (frameServerOnline) {
    const base = FRAME_SERVER + '/frame?file=' + encodeURIComponent(EPISODE_FILE);
    const shotCard = btn.closest('.shot');
    if (shotCard) {
      const imgs = shotCard.querySelectorAll('.fw img');
      if (edge === 'start' && imgs[0]) imgs[0].src = base + '&t=' + origVal.toFixed(3);
      if (edge === 'end' && imgs[1]) imgs[1].src = base + '&t=' + origVal.toFixed(3);
    }
  }

  // Close preview modal if no corrections remain
  if (!corrections[key]) closeOffsetPreviewModal();

  updateCount();
}

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  if (document.activeElement === document.getElementById('search-input') || (cmEditor && cmEditor.hasFocus()) || (shotEditorCm && shotEditorCm.hasFocus())) return;
  // Also skip if any textarea or input is focused (shot JSON editor)
  if (document.activeElement && (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT')) return;

  const video = document.getElementById('vp-video');
  if (!video) return;

  // Only handle video shortcuts when player panel is visible
  const panel = document.getElementById('video-panel');
  if (!panel || panel.style.display === 'none') {
    if (e.key === '?') { toggleHelp(); }
    return;
  }

  if (e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  if (e.code === 'ArrowLeft') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 1); }
  if (e.code === 'ArrowRight') { e.preventDefault(); video.currentTime += 1; }
  if (e.key === '?') { toggleHelp(); }
});

function toggleHelp() {
  let h = document.getElementById('help-overlay');
  if (!h) {
    h = document.createElement('div');
    h.id = 'help-overlay';
    h.innerHTML = '<div class="help-box"><h3>Keyboard Shortcuts</h3><table>' +
      '<tr><td>Space</td><td>Play / Pause</td></tr>' +
      '<tr><td>\\u2190 \\u2192</td><td>Seek \\u00b11 second</td></tr>' +
      '<tr><td>?</td><td>Toggle this help</td></tr>' +
      '</table><p style="color:#888;margin-top:12px">Click any frame thumbnail to play that shot</p></div>';
    h.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:50;display:flex;align-items:center;justify-content:center';
    h.querySelector('.help-box').style.cssText = 'background:#1a1a2e;padding:24px 32px;border-radius:12px;color:#eee;font-size:14px';
    h.querySelectorAll('td').forEach((td,i) => { if(i%2===0) td.style.cssText='padding:4px 16px 4px 0;color:#4fc3f7;font-family:monospace'; else td.style.padding='4px 0'; });
    h.onclick = () => h.remove();
    document.body.appendChild(h);
  } else {
    h.remove();
  }
}

// --- JSON Editor Modal ---
let jsonEditorOriginal = '';
let jsonEditorBackup = '';
let jsonValidateTimer = null;
let cmEditor = null;

// ── Per-Shot JSON Editor ─────────────────────────────────────────────

var shotEditorCm = null;

function editSceneJson(sceneNum) {
  closeShotEditorModal();

  fetch('/api/source-json/${EPISODE_ID}')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var scenes = JSON.parse(data.json);
      var scene = scenes.find(function(s) { return s.sceneNumber === sceneNum; });
      if (!scene) { alert('Scene ' + sceneNum + ' not found'); return; }

      // Remove internal fields from shots for cleaner editing
      var editCopy = JSON.parse(JSON.stringify(scene));
      (editCopy.shots || []).forEach(function(sh) {
        delete sh._frameFirst; delete sh._frameLast;
        delete sh._origStart; delete sh._origEnd;
        delete sh._snapDistStart; delete sh._snapDistEnd;
        delete sh._snappedStart; delete sh._snappedEnd;
      });

      var jsonStr = JSON.stringify(editCopy, null, 2);

      var overlay = document.createElement('div');
      overlay.className = 'shot-editor-modal-overlay';
      overlay.id = 'shot-editor-modal-overlay';

      var modal = document.createElement('div');
      modal.className = 'shot-editor-modal';
      modal.style.maxWidth = '900px';

      var hdr = document.createElement('div');
      hdr.className = 'sem-header';
      hdr.innerHTML = '<h3>Edit Scene ' + sceneNum + ' \\u2014 ' + (scene.location || '').slice(0,30) + '</h3><button class="sem-close" onclick="closeShotEditorModal()">\\u2715</button>';
      modal.appendChild(hdr);

      var body = document.createElement('div');
      body.className = 'sem-body';
      var cmContainer = document.createElement('div');
      cmContainer.style.cssText = 'flex:1;overflow:hidden';
      body.appendChild(cmContainer);
      modal.appendChild(body);

      var errorDiv = document.createElement('div');
      errorDiv.className = 'sem-error';
      modal.appendChild(errorDiv);

      var toolbar = document.createElement('div');
      toolbar.className = 'sem-toolbar';
      var saveBtn = document.createElement('button');
      saveBtn.className = 'save-btn';
      saveBtn.textContent = 'Save';
      saveBtn.onclick = function() {
        try {
          var edited = JSON.parse(shotEditorCm.getValue());
          // Merge edited scene back
          var idx = scenes.findIndex(function(s) { return s.sceneNumber === sceneNum; });
          if (idx === -1) { errorDiv.textContent = 'Scene not found'; return; }
          // Restore internal fields from original shots
          (edited.shots || []).forEach(function(sh, i) {
            var orig = (scenes[idx].shots || [])[i];
            if (orig) {
              sh._frameFirst = orig._frameFirst;
              sh._frameLast = orig._frameLast;
            }
          });
          scenes[idx] = edited;
          saveBtn.textContent = 'Saving...';
          saveBtn.disabled = true;

          fetch('/api/save-json/${EPISODE_ID}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ json: JSON.stringify(scenes, null, 2) })
          }).then(function(r) { return r.json(); }).then(function(result) {
            if (result.success) {
              closeShotEditorModal();
              location.reload();
            } else {
              errorDiv.textContent = 'Save failed: ' + (result.error || 'unknown');
              saveBtn.textContent = 'Save';
              saveBtn.disabled = false;
            }
          });
        } catch(e) {
          errorDiv.textContent = 'Invalid JSON: ' + e.message;
        }
      };
      toolbar.appendChild(saveBtn);

      var cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = closeShotEditorModal;
      toolbar.appendChild(cancelBtn);

      var formatBtn = document.createElement('button');
      formatBtn.textContent = 'Format';
      formatBtn.onclick = function() {
        try {
          var parsed = JSON.parse(shotEditorCm.getValue());
          shotEditorCm.setValue(JSON.stringify(parsed, null, 2));
        } catch(e) { errorDiv.textContent = 'Cannot format: ' + e.message; }
      };
      toolbar.appendChild(formatBtn);

      modal.appendChild(toolbar);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      shotEditorCm = CodeMirror(cmContainer, {
        value: jsonStr,
        mode: 'application/json',
        theme: 'material-darker',
        lineNumbers: true,
        lineWrapping: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        foldGutter: true,
        gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
        extraKeys: {
          'Ctrl-S': function() { saveBtn.click(); },
          'Escape': closeShotEditorModal,
          'Ctrl-F': 'findPersistent'
        }
      });

      setTimeout(function() { shotEditorCm.refresh(); }, 100);
    });
}

function editShotJson(sceneNum, shotNum) {
  // Close existing shot editor modal if open
  closeShotEditorModal();

  // Fetch the current shot JSON from the full scenes.json
  fetch('/api/source-json/${EPISODE_ID}')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var scenes = JSON.parse(data.json);
      var scene = scenes.find(function(s) { return s.sceneNumber === sceneNum; });
      if (!scene) { alert('Scene ' + sceneNum + ' not found'); return; }
      var shot = (scene.shots || []).find(function(s) { return s.shotNumber === shotNum; });
      if (!shot) { alert('Shot ' + shotNum + ' not found in scene ' + sceneNum); return; }

      // Remove internal fields for cleaner editing
      var editCopy = JSON.parse(JSON.stringify(shot));
      delete editCopy._frameFirst;
      delete editCopy._frameLast;
      delete editCopy._origStart;
      delete editCopy._origEnd;
      delete editCopy._snapDistStart;
      delete editCopy._snapDistEnd;
      delete editCopy._snappedStart;
      delete editCopy._snappedEnd;

      var jsonStr = JSON.stringify(editCopy, null, 2);

      // Build modal overlay
      var overlay = document.createElement('div');
      overlay.className = 'shot-editor-modal-overlay';
      overlay.id = 'shot-editor-modal-overlay';

      var modal = document.createElement('div');
      modal.className = 'shot-editor-modal';

      // Header
      var hdr = document.createElement('div');
      hdr.className = 'sem-header';
      hdr.innerHTML = '<h3>Edit Shot \\u2014 Scene ' + sceneNum + ' Shot ' + shotNum + '</h3><button class="sem-close" onclick="closeShotEditorModal()">\\u2715</button>';
      modal.appendChild(hdr);

      // Body (CodeMirror area)
      var body = document.createElement('div');
      body.className = 'sem-body';
      var cmContainer = document.createElement('div');
      cmContainer.style.cssText = 'flex:1;overflow:hidden';
      body.appendChild(cmContainer);
      modal.appendChild(body);

      // Error display
      var errorDiv = document.createElement('div');
      errorDiv.style.cssText = 'padding:0 16px;min-height:18px';
      errorDiv.className = 'se-error';
      modal.appendChild(errorDiv);

      // Toolbar
      var toolbar = document.createElement('div');
      toolbar.className = 'sem-toolbar';

      var saveBtn = document.createElement('button');
      saveBtn.className = 'se-save';
      saveBtn.textContent = 'Save Shot';
      saveBtn.id = 'sem-save-btn';
      toolbar.appendChild(saveBtn);

      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'se-cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = function() { closeShotEditorModal(); };
      toolbar.appendChild(cancelBtn);

      var formatBtn = document.createElement('button');
      formatBtn.className = 'se-cancel';
      formatBtn.textContent = 'Format';
      toolbar.appendChild(formatBtn);

      var status = document.createElement('span');
      status.style.cssText = 'font-size:10px;color:#888;margin-left:auto';
      status.textContent = '${EPISODE_ID} / Scene ' + sceneNum + ', Shot ' + shotNum;
      toolbar.appendChild(status);

      modal.appendChild(toolbar);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // Init CodeMirror
      shotEditorCm = CodeMirror(cmContainer, {
        value: jsonStr,
        mode: { name: 'javascript', json: true },
        theme: 'material-darker',
        lineNumbers: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        tabSize: 2,
        extraKeys: {
          'Ctrl-S': function() { saveBtn.click(); },
          'Escape': function() { closeShotEditorModal(); }
        }
      });

      shotEditorCm.on('change', function() {
        try {
          JSON.parse(shotEditorCm.getValue());
          errorDiv.textContent = '';
        } catch(e) {
          errorDiv.textContent = 'Invalid JSON: ' + e.message;
        }
      });

      // Wire up save
      saveBtn.onclick = function() {
        var newShot;
        try { newShot = JSON.parse(shotEditorCm.getValue()); } catch(e) { errorDiv.textContent = 'Invalid JSON: ' + e.message; return; }
        saveShotJson(sceneNum, shotNum, { value: shotEditorCm.getValue() }, errorDiv, saveBtn);
      };

      // Wire up format
      formatBtn.onclick = function() {
        try {
          var parsed = JSON.parse(shotEditorCm.getValue());
          shotEditorCm.setValue(JSON.stringify(parsed, null, 2));
          errorDiv.textContent = '';
        } catch(e) {
          errorDiv.textContent = e.message;
        }
      };

      setTimeout(function() { shotEditorCm.refresh(); shotEditorCm.focus(); }, 100);
    })
    .catch(function(e) { alert('Failed to load: ' + e.message); });
}

function closeShotEditorModal() {
  shotEditorCm = null;
  var overlay = document.getElementById('shot-editor-modal-overlay');
  if (overlay) overlay.remove();
}

function saveShotJson(sceneNum, shotNum, textarea, errorDiv, saveBtn) {
  var newShot;
  try {
    newShot = JSON.parse(textarea.value);
  } catch(e) {
    errorDiv.textContent = 'Invalid JSON: ' + e.message;
    return;
  }

  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;

  // Fetch full scenes.json, update this shot, save back
  fetch('/api/source-json/${EPISODE_ID}')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var scenes = JSON.parse(data.json);
      var scene = scenes.find(function(s) { return s.sceneNumber === sceneNum; });
      if (!scene) throw new Error('Scene not found');
      var shotIdx = (scene.shots || []).findIndex(function(s) { return s.shotNumber === shotNum; });
      if (shotIdx === -1) throw new Error('Shot not found');

      // Preserve internal fields from original
      var orig = scene.shots[shotIdx];
      newShot._frameFirst = orig._frameFirst;
      newShot._frameLast = orig._frameLast;
      if (orig._origStart) newShot._origStart = orig._origStart;
      if (orig._origEnd) newShot._origEnd = orig._origEnd;
      if (orig._snapDistStart) newShot._snapDistStart = orig._snapDistStart;
      if (orig._snapDistEnd) newShot._snapDistEnd = orig._snapDistEnd;

      // Ensure shotNumber stays correct
      newShot.shotNumber = shotNum;

      scene.shots[shotIdx] = newShot;

      return fetch('/api/save-json/${EPISODE_ID}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: JSON.stringify(scenes, null, 2) })
      });
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (result.success) {
        saveBtn.textContent = '✅ Saved!';
        saveBtn.style.background = '#4caf50';
        errorDiv.textContent = result.message || '';
        errorDiv.style.color = '#4caf50';
        // Reload page after brief delay
        setTimeout(function() { location.reload(); }, 1500);
      } else {
        throw new Error(result.error || 'Save failed');
      }
    })
    .catch(function(e) {
      errorDiv.textContent = e.message;
      saveBtn.textContent = 'Save Shot';
      saveBtn.disabled = false;
    });
}

function openJsonEditor() {
  const overlay = document.createElement('div');
  overlay.className = 'json-editor-overlay';
  overlay.id = 'json-editor-overlay';
  overlay.innerHTML =
    '<div class="json-editor-toolbar">' +
      '<button class="save-btn" onclick="jsonEditorSave()">Save</button>' +
      '<button onclick="jsonEditorCancel()">Cancel</button>' +
      '<button onclick="jsonEditorFormat()">Format JSON</button>' +
      '<button onclick="jsonEditorFold()">Fold All</button>' +
      '<button onclick="jsonEditorUnfold()">Unfold All</button>' +
      '<button class="revert-btn" onclick="jsonEditorRevert()">Revert to Backup</button>' +
      '<span style="margin-left:12px;color:#888;font-size:11px">Jump to:</span>' +
      '<input id="json-jump-input" type="text" placeholder="scene.shot (e.g. 5.3)" style="width:80px;background:#222;color:#eee;border:1px solid #444;padding:3px 6px;border-radius:3px;font-size:11px;font-family:monospace" onkeydown="if(event.keyCode===13)jsonEditorJump()">' +
      '<button onclick="jsonEditorJump()" style="padding:3px 8px">Go</button>' +
      '<span style="flex:1"></span>' +
      '<span style="color:#888;font-size:12px">Editing: ${EPISODE_ID}/scenes.json</span>' +
    '</div>' +
    '<div class="json-editor-status" id="json-editor-status">' +
      '<span id="json-editor-lines">Lines: 0</span>' +
      '<span id="json-editor-chars">Chars: 0</span>' +
      '<span id="json-editor-valid" class="valid">\\u2713 Valid JSON</span>' +
      '<span id="json-editor-cursor">Ln 1, Col 1</span>' +
    '</div>' +
    '<div class="json-editor-area" id="json-editor-area"></div>';
  document.body.appendChild(overlay);

  const area = document.getElementById('json-editor-area');

  // Custom overlay mode that colorizes JSON keys by name
  CodeMirror.defineMode('json-colored-keys', function(config) {
    const base = CodeMirror.getMode(config, { name: 'javascript', json: true });
    return CodeMirror.overlayMode(base, {
      token: function(stream, state) {
        // Match "keyName": pattern
        if (stream.match(/"(sceneNumber|shotNumber)"\\s*:/)) return 'key-sceneNumber';
        if (stream.match(/"(startTimestamp|start)"\\s*:/)) return 'key-startTimestamp';
        if (stream.match(/"(endTimestamp|end)"\\s*:/)) return 'key-endTimestamp';
        if (stream.match(/"location"\\s*:/)) return 'key-location';
        if (stream.match(/"characters"\\s*:/)) return 'key-characters';
        if (stream.match(/"mood"\\s*:/)) return 'key-mood';
        if (stream.match(/"plotSignificance"\\s*:/)) return 'key-plotSignificance';
        if (stream.match(/"lighting"\\s*:/)) return 'key-lighting';
        if (stream.match(/"music"\\s*:/)) return 'key-music';
        if (stream.match(/"costuming"\\s*:/)) return 'key-costuming';
        if (stream.match(/"tags"\\s*:/)) return 'key-tags';
        if (stream.match(/"supercutPotential"\\s*:/)) return 'key-supercutPotential';
        if (stream.match(/"shots"\\s*:/)) return 'key-shots';
        if (stream.match(/"shotType"\\s*:/)) return 'key-shotType';
        if (stream.match(/"subject"\\s*:/)) return 'key-subject';
        if (stream.match(/"action"\\s*:/)) return 'key-action';
        if (stream.match(/"characterExpressions"\\s*:/)) return 'key-characterExpressions';
        if (stream.match(/"cameraMovement"\\s*:/)) return 'key-cameraMovement';
        if (stream.match(/"dialogue"\\s*:/)) return 'key-dialogue';
        if (stream.match(/"speaker"\\s*:/)) return 'key-speaker';
        if (stream.match(/"text"\\s*:/)) return 'key-text';
        stream.next();
        return null;
      }
    });
  });

  // Custom fold widget maker — shows context info for folded JSON blocks
  function makeFoldWidget(from, to) {
    var firstLine = cmEditor ? cmEditor.getLine(from.line) : '';
    var nextLine = cmEditor ? (cmEditor.getLine(from.line + 1) || '') : '';
    var label = '{...}';

    if (nextLine.indexOf('"sceneNumber"') >= 0) {
      // Scene fold — show scene info
      var num = (nextLine.match(/"sceneNumber"\\s*:\\s*(\\d+)/) || [])[1] || '?';
      var loc = '';
      for (var p = from.line + 1; p < Math.min(from.line + 8, to.line); p++) {
        var pl = cmEditor.getLine(p) || '';
        var lm = pl.match(/"location"\\s*:\\s*"([^"]+)"/);
        if (lm) { loc = lm[1].substring(0, 40); break; }
      }
      label = 'Scene ' + num + (loc ? ' \\u2014 ' + loc : '') + ' (' + (to.line - from.line) + ' lines)';
    } else if (nextLine.indexOf('"shotNumber"') >= 0) {
      // Shot fold — show shot info
      var sn = (nextLine.match(/"shotNumber"\\s*:\\s*(\\d+)/) || [])[1] || '?';
      var st = '', subj = '';
      for (var p = from.line + 1; p < Math.min(from.line + 10, to.line); p++) {
        var pl = cmEditor.getLine(p) || '';
        var tm = pl.match(/"shotType"\\s*:\\s*"([^"]+)"/);
        var sm = pl.match(/"subject"\\s*:\\s*"([^"]+)"/);
        if (tm) st = tm[1];
        if (sm) subj = sm[1].substring(0, 35);
      }
      label = 'Shot ' + sn + (st ? ' [' + st + ']' : '') + (subj ? ' ' + subj : '');
    }

    var widget = document.createElement('span');
    widget.textContent = ' ' + label + ' ';
    widget.className = nextLine.indexOf('"sceneNumber"') >= 0 ? 'cm-fold-scene' : 'cm-fold-shot';
    return widget;
  }

  cmEditor = CodeMirror(area, {
    value: 'Loading...',
    mode: 'json-colored-keys',
    theme: 'material-darker',
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    foldGutter: true,
    foldOptions: {
      rangeFinder: CodeMirror.fold.brace,
      widget: function(from, to) { return makeFoldWidget(from, to); }
    },
    gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
    tabSize: 2,
    extraKeys: {
      'Ctrl-S': function() { jsonEditorSave(); },
      'Escape': function() { jsonEditorCancel(); }
    }
  });

  cmEditor.on('change', function() {
    clearTimeout(jsonValidateTimer);
    jsonValidateTimer = setTimeout(function() { jsonEditorValidate(); }, 500);
    jsonEditorUpdateStats();
  });

  cmEditor.on('cursorActivity', function() {
    var cursor = cmEditor.getCursor();
    var el = document.getElementById('json-editor-cursor');
    if (el) el.textContent = 'Ln ' + (cursor.line + 1) + ', Col ' + (cursor.ch + 1);
  });

  // Fetch the source JSON
  fetch('/api/source-json/${EPISODE_ID}')
    .then(r => r.json())
    .then(data => {
      const content = typeof data.json === 'string' ? data.json : JSON.stringify(data.json, null, 2);
      cmEditor.setValue(content);
      jsonEditorOriginal = content;
      jsonEditorValidate();
      jsonEditorUpdateStats();
      cmEditor.refresh();
      cmEditor.focus();
    })
    .catch(err => {
      cmEditor.setValue('// Error loading JSON: ' + err.message);
    });
}

function jsonEditorUpdateStats() {
  if (!cmEditor) return;
  const text = cmEditor.getValue();
  const lines = text.split('\\n').length;
  const chars = text.length;
  document.getElementById('json-editor-lines').textContent = 'Lines: ' + lines;
  document.getElementById('json-editor-chars').textContent = 'Chars: ' + chars;
}

function jsonEditorValidate() {
  const indicator = document.getElementById('json-editor-valid');
  if (!cmEditor || !indicator) return;
  try {
    JSON.parse(cmEditor.getValue());
    indicator.className = 'valid';
    indicator.textContent = '\\u2713 Valid JSON';
  } catch (e) {
    indicator.className = 'invalid';
    let msg = e.message || 'Invalid JSON';
    const lineMatch = msg.match(/position (\\d+)/);
    if (lineMatch) {
      const pos = parseInt(lineMatch[1]);
      const cmPos = cmEditor.posFromIndex(pos);
      msg = '\\u2717 Invalid: ' + msg + ' (line ' + (cmPos.line + 1) + ')';
    } else {
      msg = '\\u2717 Invalid: ' + msg;
    }
    indicator.textContent = msg;
  }
}

function jsonEditorFormat() {
  if (!cmEditor) return;
  try {
    const parsed = JSON.parse(cmEditor.getValue());
    cmEditor.setValue(JSON.stringify(parsed, null, 2));
    jsonEditorValidate();
    jsonEditorUpdateStats();
  } catch (e) {
    alert('Cannot format: JSON is invalid.\\n\\n' + e.message);
  }
}

function jsonEditorFold() {
  if (!cmEditor) return;
  jsonEditorUnfold();
  var lc = cmEditor.lineCount();
  // Step 1: fold shots first (6-space indent braces)
  for (var i = lc - 1; i >= 0; i--) {
    var line = cmEditor.getLine(i);
    if (line === '      {') cmEditor.foldCode(CodeMirror.Pos(i, 0), null, 'fold');
  }
  // Step 2: fold scenes (2-space indent braces) — shots inside are already folded
  lc = cmEditor.lineCount();
  for (var i = lc - 1; i >= 0; i--) {
    var line = cmEditor.getLine(i);
    if (line === '  {') cmEditor.foldCode(CodeMirror.Pos(i, 0), null, 'fold');
  }
}

function jsonEditorUnfold() {
  if (!cmEditor) return;
  for (var i = 0; i < cmEditor.lineCount(); i++) {
    cmEditor.foldCode(CodeMirror.Pos(i, 0), null, 'unfold');
  }
}

function jsonEditorJump() {
  if (!cmEditor) return;
  var input = document.getElementById('json-jump-input');
  if (!input) return;
  var val = input.value.trim();
  if (!val) return;

  var parts = val.split('.');
  var targetScene = parseInt(parts[0]);
  var targetShot = parts[1] ? parseInt(parts[1]) : null;

  if (isNaN(targetScene)) { alert('Enter a scene number (e.g. 5) or scene.shot (e.g. 5.3)'); return; }

  // Search for the line containing "sceneNumber": N
  var lineCount = cmEditor.lineCount();
  var foundScene = -1;
  var foundShot = -1;

  for (var i = 0; i < lineCount; i++) {
    var line = cmEditor.getLine(i);
    if (!line) continue;

    // Match "sceneNumber": N
    var sceneMatch = line.match(/"sceneNumber"\\s*:\\s*(\\d+)/);
    if (sceneMatch && parseInt(sceneMatch[1]) === targetScene) {
      foundScene = i;
      if (!targetShot) break;

      // Look for shot within this scene
      for (var j = i + 1; j < lineCount; j++) {
        var shotLine = cmEditor.getLine(j);
        if (!shotLine) continue;
        // If we hit the next scene, stop
        if (shotLine.match(/"sceneNumber"\\s*:/)) break;
        var shotMatch = shotLine.match(/"shotNumber"\\s*:\\s*(\\d+)/);
        if (shotMatch && parseInt(shotMatch[1]) === targetShot) {
          foundShot = j;
          break;
        }
      }
      break;
    }
  }

  var targetLine = foundShot >= 0 ? foundShot : foundScene;
  if (targetLine < 0) {
    alert('Scene ' + targetScene + (targetShot ? ' Shot ' + targetShot : '') + ' not found');
    return;
  }

  // Unfold to make the line visible, then jump
  jsonEditorUnfold();
  cmEditor.setCursor(targetLine, 0);
  cmEditor.scrollIntoView({ line: targetLine, ch: 0 }, 100);
  cmEditor.focus();

  // Flash the line
  cmEditor.addLineClass(targetLine, 'background', 'json-jump-highlight');
  setTimeout(function() { cmEditor.removeLineClass(targetLine, 'background', 'json-jump-highlight'); }, 2000);
}

async function jsonEditorSave() {
  if (!cmEditor) return;
  try {
    JSON.parse(cmEditor.getValue());
  } catch (e) {
    alert('Cannot save: JSON is invalid.\\n\\n' + e.message);
    return;
  }

  // Show progress overlay
  const overlay = document.getElementById('json-editor-overlay');
  const prog = document.createElement('div');
  prog.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:210;color:#4fc3f7;font-size:18px';
  prog.textContent = 'Saving...';
  overlay.appendChild(prog);

  try {
    const resp = await fetch('/api/save-json/${EPISODE_ID}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: cmEditor.getValue() })
    });
    const result = await resp.json();
    if (result.success) {
      window.location.reload();
    } else {
      throw new Error(result.error || 'Save failed');
    }
  } catch (e) {
    prog.remove();
    alert('Save failed: ' + e.message);
  }
}

function jsonEditorCancel() {
  if (cmEditor && cmEditor.getValue() !== jsonEditorOriginal) {
    if (!confirm('You have unsaved changes. Discard them?')) return;
  }
  cmEditor = null;
  const overlay = document.getElementById('json-editor-overlay');
  if (overlay) overlay.remove();
}

async function jsonEditorRevert() {
  if (!cmEditor) return;
  if (!confirm('Load the backup version? This will replace the current editor contents.')) return;
  try {
    const resp = await fetch('/api/source-json/${EPISODE_ID}?backup=true');
    const data = await resp.json();
    const content = typeof data.json === 'string' ? data.json : JSON.stringify(data.json, null, 2);
    cmEditor.setValue(content);
    jsonEditorValidate();
    jsonEditorUpdateStats();
  } catch (e) {
    alert('Failed to load backup: ' + e.message);
  }
}

// ── Tier 2 Analysis (Modal Log Viewer) ──────────────────────────
var tier2Polling = null;
var tier2LogOffset = 0;
var tier2Modal = null;
var tier2AutoScroll = true;

function analyzeTier2(sceneNum, shotNum) {
  var body = { episodeId: '${EPISODE_ID}' };
  if (shotNum) {
    body.shot = sceneNum + '.' + shotNum;
  } else {
    body.scene = sceneNum;
  }
  startTier2(body, shotNum ? 'Scene ' + sceneNum + ' Shot ' + shotNum : 'Scene ' + sceneNum);
}

function analyzeTier2All() {
  startTier2({ episodeId: '${EPISODE_ID}' }, 'All Shots');
}

function startTier2(body, label) {
  // Open modal immediately
  openTier2Modal(label || 'Tier 2');
  tier2LogOffset = 0;

  fetch('/api/tier2/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { appendTier2Log('\\u274c Error: ' + data.error); return; }
    appendTier2Log('\\u2705 Analysis started\\n');
    pollTier2();
  })
  .catch(function(e) { appendTier2Log('\\u274c Failed: ' + e.message); });
}

function openTier2Modal(label) {
  closeTier2Modal();

  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:300;display:flex;align-items:center;justify-content:center';

  var modal = document.createElement('div');
  modal.style.cssText = 'width:90vw;max-width:1000px;height:80vh;background:#0a0a0a;border:1px solid #333;border-radius:10px;display:flex;flex-direction:column;overflow:hidden';

  // Header
  var hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#111;border-bottom:1px solid #333';
  var title = document.createElement('span');
  title.style.cssText = 'color:#4fc3f7;font-weight:700;font-size:0.85rem;font-family:monospace';
  title.textContent = '\\uD83D\\uDDA5 ${EPISODE_ID} \\u2014 Tier 2: ' + label;
  var meta = document.createElement('span');
  meta.id = 'tier2-modal-meta';
  meta.style.cssText = 'color:#888;font-size:0.7rem';
  meta.textContent = 'Starting...';
  var closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:4px 8px';
  closeBtn.textContent = '\\u2715';
  closeBtn.onclick = closeTier2Modal;
  hdr.appendChild(title);
  hdr.appendChild(meta);
  hdr.appendChild(closeBtn);
  modal.appendChild(hdr);

  // Log body
  var logBody = document.createElement('div');
  logBody.id = 'tier2-modal-body';
  logBody.style.cssText = 'flex:1;overflow-y:auto;padding:12px 16px;font-family:\\'Cascadia Code\\',\\'Fira Code\\',Consolas,monospace;font-size:11px;line-height:1.6;color:#ccc;white-space:pre-wrap;word-break:break-all';
  logBody.addEventListener('scroll', function() {
    tier2AutoScroll = (logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight) < 50;
  });
  modal.appendChild(logBody);

  // Footer
  var footer = document.createElement('div');
  footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:#111;border-top:1px solid #333;font-size:0.7rem;color:#888';
  var footerLeft = document.createElement('span');
  footerLeft.id = 'tier2-modal-footer';
  footerLeft.textContent = 'Waiting...';
  var cancelBtn = document.createElement('button');
  cancelBtn.textContent = '\\u2716 Cancel';
  cancelBtn.style.cssText = 'background:#e94560;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold';
  cancelBtn.onclick = function() {
    if (!confirm('Cancel Tier 2 analysis?')) return;
    fetch('/api/tier2/cancel/${EPISODE_ID}', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        appendTier2Log('\\n\\u2716 ' + (data.message || 'Cancelled'));
        if (tier2Polling) { clearInterval(tier2Polling); tier2Polling = null; }
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelled';
        cancelBtn.style.background = '#333';
      })
      .catch(function(e) { appendTier2Log('\\u274c Cancel failed: ' + e.message); });
  };
  var footerRight = document.createElement('span');
  footerRight.textContent = 'Auto-scroll: ON';
  footer.appendChild(footerLeft);
  footer.appendChild(cancelBtn);
  footer.appendChild(footerRight);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  tier2Modal = overlay;
}

function closeTier2Modal() {
  if (tier2Polling) { clearInterval(tier2Polling); tier2Polling = null; }
  if (tier2Modal) { tier2Modal.remove(); tier2Modal = null; }
}

function appendTier2Log(text) {
  var body = document.getElementById('tier2-modal-body');
  if (!body) return;
  var lines = text.split('\\n');
  lines.forEach(function(line) {
    if (!line && !line.trim) return;
    var div = document.createElement('div');
    div.style.padding = '1px 0';
    if (/error|failed|\\u274c|\\u26d4/i.test(line)) div.style.color = '#e94560';
    else if (/warning|\\u26a0|retry|attempt/i.test(line)) div.style.color = '#ff9800';
    else if (/\\u2705|complete|success/i.test(line)) div.style.color = '#4caf50';
    else if (/\\uD83D\\uDCE6|batch/i.test(line)) div.style.color = '#4fc3f7';
    div.textContent = line;
    body.appendChild(div);
  });
  if (tier2AutoScroll) body.scrollTop = body.scrollHeight;
}

function pollTier2() {
  if (tier2Polling) clearInterval(tier2Polling);
  tier2Polling = setInterval(function() {
    // Poll status
    fetch('/api/tier2/status/${EPISODE_ID}')
      .then(function(r) { return r.json(); })
      .then(function(s) {
        var meta = document.getElementById('tier2-modal-meta');
        var footer = document.getElementById('tier2-modal-footer');
        var statusText = s.phase === 'running'
          ? 'Batch ' + (s.batch || '?') + '/' + (s.totalBatches || '?') + ' \\u2022 ' + (s.shotsEnriched || 0) + ' shots enriched'
          : s.phase === 'complete' ? '\\u2705 Complete!' : s.phase;
        if (meta) meta.textContent = statusText;
        if (footer) footer.textContent = s.phase === 'running' ? 'Cost: $' + (s.lastBatchCost || 0).toFixed(4) + ' (last batch)' : statusText;

        // Update progress indicators on report
        var progEls = document.querySelectorAll('.tier2-progress');
        progEls.forEach(function(el) { el.textContent = statusText; });

        if (s.phase === 'complete' || s.phase === 'failed') {
          clearInterval(tier2Polling);
          tier2Polling = null;
          if (s.phase === 'complete') {
            appendTier2Log('\\n\\u2705 Tier 2 complete! Reloading page...');
            setTimeout(function() { closeTier2Modal(); location.reload(); }, 2000);
          }
        }
      });

    // Poll log
    fetch('/api/tier2/log/${EPISODE_ID}?offset=' + tier2LogOffset)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.lines && data.lines.length > 0) {
          appendTier2Log(data.lines.join('\\n'));
          tier2LogOffset = data.total;
        }
      });
  }, 2000);
}

function toggleTier2Log() {
  // Open modal with existing log
  openTier2Modal('Log');
  fetch('/api/tier2/log/${EPISODE_ID}')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.lines) appendTier2Log(data.lines.join('\\n'));
      tier2LogOffset = data.total;
    });
}

// --- Speaker Editing (Double-click) ---
var activeSpeakerDropdown = null;

function closeSpeakerDropdown() {
  if (activeSpeakerDropdown) {
    activeSpeakerDropdown.remove();
    activeSpeakerDropdown = null;
  }
}

document.addEventListener('click', function(e) {
  if (activeSpeakerDropdown && !activeSpeakerDropdown.contains(e.target) && !e.target.classList.contains('dl-speaker')) {
    closeSpeakerDropdown();
  }
});

function editSpeaker(el, sceneNumber) {
  closeSpeakerDropdown();

  var dlLine = el.closest('.dl');
  var dlIdx = parseInt(dlLine.dataset.dlidx);
  var dlContainer = el.closest('.dialogue-lines');
  var episodeId = dlContainer.dataset.episode;
  var shotNum = parseInt(dlContainer.dataset.shot);

  // Get characters from the scene div
  var sceneDiv = el.closest('.scene');
  var characters = [];
  try { characters = JSON.parse(sceneDiv.dataset.characters || '[]'); } catch(e) {}

  var currentSpeaker = el.textContent.replace(/:$/, '').trim();

  // Build dropdown
  var dropdown = document.createElement('div');
  dropdown.className = 'speaker-dropdown';

  // Position near the speaker element
  var rect = el.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.left = rect.left + 'px';
  dropdown.style.top = (rect.bottom + 2) + 'px';

  // Add character options
  var allOptions = characters.slice();
  if (allOptions.indexOf('Unknown') === -1) allOptions.push('Unknown');

  for (var i = 0; i < allOptions.length; i++) {
    var opt = document.createElement('div');
    opt.className = 'sp-option' + (allOptions[i] === currentSpeaker ? ' sp-active' : '');
    opt.textContent = allOptions[i];
    opt.dataset.value = allOptions[i];
    opt.onclick = function() {
      var newSpeaker = this.dataset.value;
      el.textContent = newSpeaker + ':';
      closeSpeakerDropdown();
      saveSpeakerChange(episodeId, sceneNumber, shotNum, dlIdx, newSpeaker);
    };
    dropdown.appendChild(opt);
  }

  // Custom input row
  var customRow = document.createElement('div');
  customRow.className = 'sp-custom-row';
  var customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.placeholder = 'Type custom name...';
  customInput.onkeydown = function(e) {
    if (e.key === 'Enter' && this.value.trim()) {
      var newSpeaker = this.value.trim();
      el.textContent = newSpeaker + ':';
      closeSpeakerDropdown();
      saveSpeakerChange(episodeId, sceneNumber, shotNum, dlIdx, newSpeaker);
    }
    if (e.key === 'Escape') closeSpeakerDropdown();
    e.stopPropagation();
  };
  customRow.appendChild(customInput);
  dropdown.appendChild(customRow);

  document.body.appendChild(dropdown);
  activeSpeakerDropdown = dropdown;

  // Focus the custom input after a tick
  setTimeout(function() { customInput.focus(); }, 50);
}

function saveSpeakerChange(episodeId, sceneNumber, shotNum, dlIdx, newSpeaker) {
  fetch('/api/source-json/' + episodeId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var scenes = JSON.parse(data.json);
      var scene = scenes.find(function(s) { return s.sceneNumber === parseInt(sceneNumber); });
      if (!scene) throw new Error('Scene not found');
      var shot = (scene.shots || []).find(function(s) { return s.shotNumber === shotNum; });
      if (!shot || !shot.dialogue || !shot.dialogue[dlIdx]) throw new Error('Dialogue line not found');

      if (typeof shot.dialogue[dlIdx] === 'string') {
        // Convert string dialogue to object
        shot.dialogue[dlIdx] = { speaker: newSpeaker, text: shot.dialogue[dlIdx] };
      } else {
        shot.dialogue[dlIdx].speaker = newSpeaker;
      }

      return fetch('/api/save-json/' + episodeId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: JSON.stringify(scenes, null, 2) })
      });
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (!result.success) console.error('Failed to save speaker:', result.error);
    })
    .catch(function(e) { console.error('Speaker save error:', e.message); });
}

// --- Edit Dialogue Text Inline ---
function editDialogueText(el, sceneNumber, shotNum, dlIdx) {
  var currentText = el.textContent.replace(/^"|"$/g, '').trim();
  var input = document.createElement('input');
  input.type = 'text';
  input.value = currentText;
  input.style.cssText = 'width:100%;padding:4px 6px;background:#0a0a1a;border:1px solid #4fc3f7;color:#eee;border-radius:3px;font-size:12px;font-style:italic';

  var originalHtml = el.innerHTML;
  el.innerHTML = '';
  el.appendChild(input);
  input.focus();
  input.select();

  function save() {
    var newText = input.value.trim();
    if (!newText || newText === currentText) {
      el.innerHTML = originalHtml;
      return;
    }
    el.innerHTML = '"' + newText.replace(/</g, '&lt;') + '"';

    // Save to server
    var container = el.closest('.dialogue-lines');
    var episodeId = container?.dataset?.episode;
    if (!episodeId) return;

    fetch('/api/source-json/' + encodeURIComponent(episodeId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var scenes = JSON.parse(data.json);
        var scene = scenes.find(function(s) { return s.sceneNumber === sceneNumber; });
        if (!scene) return;
        var shot = scene.shots?.find(function(s) { return s.shotNumber === shotNum; });
        if (!shot || !shot.dialogue || !shot.dialogue[dlIdx]) return;
        shot.dialogue[dlIdx].text = newText;
        return fetch('/api/save-json/' + encodeURIComponent(episodeId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ json: JSON.stringify(scenes, null, 2) })
        });
      })
      .catch(function(e) { console.error('Dialogue text save error:', e.message); });
  }

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { el.innerHTML = originalHtml; }
  });
  input.addEventListener('blur', save);
}

// --- Delete Dialogue Line ---
function deleteDialogueLine(btn, sceneNumber, shotNum, dlIdx) {
  // Show confirm modal
  var overlay = document.createElement('div');
  overlay.className = 'confirm-modal-overlay';
  var modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.innerHTML = '<p>Delete this dialogue line?</p>' +
    '<button class="cm-yes" id="cm-confirm-yes">Delete</button>' +
    '<button class="cm-no" id="cm-confirm-no">Cancel</button>';
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  document.getElementById('cm-confirm-no').onclick = function() { overlay.remove(); };
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  document.getElementById('cm-confirm-yes').onclick = function() {
    overlay.remove();

    var dlContainer = btn.closest('.dialogue-lines');
    var episodeId = dlContainer.dataset.episode;

    fetch('/api/source-json/' + episodeId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var scenes = JSON.parse(data.json);
        var scene = scenes.find(function(s) { return s.sceneNumber === parseInt(sceneNumber); });
        if (!scene) throw new Error('Scene not found');
        var shot = (scene.shots || []).find(function(s) { return s.shotNumber === shotNum; });
        if (!shot || !shot.dialogue || !shot.dialogue[dlIdx]) throw new Error('Dialogue line not found');

        shot.dialogue.splice(dlIdx, 1);

        return fetch('/api/save-json/' + episodeId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ json: JSON.stringify(scenes, null, 2) })
        });
      })
      .then(function(r) { return r.json(); })
      .then(function(result) {
        if (result.success) {
          // Remove the line from the DOM and reindex remaining lines
          var dlLine = btn.closest('.dl');
          var container = dlLine.parentElement;
          dlLine.remove();
          // Re-index remaining lines
          var remaining = container.querySelectorAll('.dl');
          for (var i = 0; i < remaining.length; i++) {
            remaining[i].dataset.dlidx = i;
            // Update onclick handlers on delete buttons
            var delBtn = remaining[i].querySelector('.dl-delete');
            if (delBtn) {
              delBtn.setAttribute('onclick', 'deleteDialogueLine(this, ' + sceneNumber + ', ' + shotNum + ', ' + i + ')');
            }
            // Update move button onclick indices
            var allMoveBtns = remaining[i].querySelectorAll('.dl-move-btn');
            for (var mb = 0; mb < allMoveBtns.length; mb++) {
              var oc = allMoveBtns[mb].getAttribute('onclick');
              if (oc && oc.indexOf('up') !== -1) {
                allMoveBtns[mb].setAttribute('onclick', 'moveDialogue(this, \\x27up\\x27, ' + sceneNumber + ', ' + shotNum + ', ' + i + ')');
              } else if (oc && oc.indexOf('down') !== -1) {
                allMoveBtns[mb].setAttribute('onclick', 'moveDialogue(this, \\x27down\\x27, ' + sceneNumber + ', ' + shotNum + ', ' + i + ')');
              }
            }
          }
          // If no dialogue left, remove the whole dialogue section
          if (remaining.length === 0) {
            var dialogueSection = container.closest('.dialogue');
            if (dialogueSection) dialogueSection.remove();
          }
        } else {
          alert('Delete failed: ' + (result.error || 'unknown'));
        }
      })
      .catch(function(e) { alert('Delete failed: ' + e.message); });
  };
}

// --- Tag Add / Edit ---
function addTagInput(addBtn) {
  // Don't add multiple inputs
  if (addBtn.parentElement.querySelector('.tag-add-input')) return;

  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-add-input';
  input.placeholder = 'new tag...';
  addBtn.parentElement.insertBefore(input, addBtn);
  input.focus();

  input.onkeydown = function(e) {
    if (e.key === 'Enter' && this.value.trim()) {
      var newTag = this.value.trim();
      var container = this.parentElement;
      var episodeId = container.dataset.episode;
      var sceneNumber = parseInt(container.dataset.scene);
      var shotNum = parseInt(container.dataset.shot);
      var tagType = container.dataset.tagtype || 'tags';

      // Add tag to DOM immediately
      var tagSpan = document.createElement('span');
      tagSpan.className = 'tag';
      tagSpan.textContent = newTag;
      tagSpan.ondblclick = function() { editTag(this); };
      container.insertBefore(tagSpan, addBtn);
      this.remove();

      // Save to backend
      saveTagsFromDom(episodeId, sceneNumber, shotNum, tagType, container);
    }
    if (e.key === 'Escape') {
      this.remove();
    }
    e.stopPropagation();
  };

  input.onblur = function() {
    // Small delay so Enter can fire first
    setTimeout(function() { if (input.parentElement) input.remove(); }, 150);
  };
}

function editTag(tagEl) {
  if (tagEl.contentEditable === 'true') return;
  var originalText = tagEl.textContent;
  tagEl.contentEditable = 'true';
  tagEl.focus();

  // Select all text
  var range = document.createRange();
  range.selectNodeContents(tagEl);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function finishEdit(save) {
    tagEl.contentEditable = 'false';
    tagEl.removeEventListener('keydown', onKey);
    tagEl.removeEventListener('blur', onBlur);
    if (!save) {
      tagEl.textContent = originalText;
      return;
    }
    var newText = tagEl.textContent.trim();
    if (!newText) {
      // Empty = delete the tag
      var container = tagEl.parentElement;
      var episodeId = container.dataset.episode;
      var sceneNumber = parseInt(container.dataset.scene);
      var shotNum = parseInt(container.dataset.shot);
      var tagType = container.dataset.tagtype || 'tags';
      tagEl.remove();
      saveTagsFromDom(episodeId, sceneNumber, shotNum, tagType, container);
      return;
    }
    if (newText !== originalText) {
      tagEl.textContent = newText;
      var container = tagEl.parentElement;
      var episodeId = container.dataset.episode;
      var sceneNumber = parseInt(container.dataset.scene);
      var shotNum = parseInt(container.dataset.shot);
      var tagType = container.dataset.tagtype || 'tags';
      saveTagsFromDom(episodeId, sceneNumber, shotNum, tagType, container);
    }
  }

  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
    if (e.key === 'Escape') { finishEdit(false); }
    e.stopPropagation();
  }
  function onBlur() { finishEdit(true); }

  tagEl.addEventListener('keydown', onKey);
  tagEl.addEventListener('blur', onBlur);
}

function saveTagsFromDom(episodeId, sceneNumber, shotNum, tagType, container) {
  // Collect current tags from DOM
  var tagEls = container.querySelectorAll('.tag');
  var tags = [];
  for (var i = 0; i < tagEls.length; i++) {
    var t = tagEls[i].textContent.trim();
    if (t) tags.push(t);
  }

  fetch('/api/source-json/' + episodeId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var scenes = JSON.parse(data.json);
      var scene = scenes.find(function(s) { return s.sceneNumber === sceneNumber; });
      if (!scene) throw new Error('Scene not found');
      var shot = (scene.shots || []).find(function(s) { return s.shotNumber === shotNum; });
      if (!shot) throw new Error('Shot not found');

      shot[tagType] = tags;

      return fetch('/api/save-json/' + episodeId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: JSON.stringify(scenes, null, 2) })
      });
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (!result.success) console.error('Failed to save tags:', result.error);
    })
    .catch(function(e) { console.error('Tag save error:', e.message); });
}

// --- Move Dialogue Up/Down ---
function moveDialogue(btn, direction, sceneNumber, shotNum, dlIdx) {
  var dlContainer = btn.closest('.dialogue-lines');
  var episodeId = dlContainer.dataset.episode;

  fetch('/api/source-json/' + episodeId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var scenes = JSON.parse(data.json);
      var scene = scenes.find(function(s) { return s.sceneNumber === parseInt(sceneNumber); });
      if (!scene || !scene.shots) throw new Error('Scene not found');

      var shotIdx = scene.shots.findIndex(function(s) { return s.shotNumber === shotNum; });
      if (shotIdx === -1) throw new Error('Shot not found');

      var shot = scene.shots[shotIdx];
      if (!shot.dialogue || !shot.dialogue[dlIdx]) throw new Error('Dialogue line not found');

      var movedLine = shot.dialogue[dlIdx];

      if (direction === 'up') {
        // Move to previous shot in same scene
        if (shotIdx === 0) { alert('No previous shot in this scene.'); return; }
        var prevShot = scene.shots[shotIdx - 1];
        if (!prevShot.dialogue) prevShot.dialogue = [];
        // Remove from current shot
        shot.dialogue.splice(dlIdx, 1);
        // Add to end of previous shot
        prevShot.dialogue.push(movedLine);
      } else {
        // Move to next shot in same scene
        if (shotIdx >= scene.shots.length - 1) { alert('No next shot in this scene.'); return; }
        var nextShot = scene.shots[shotIdx + 1];
        if (!nextShot.dialogue) nextShot.dialogue = [];
        // Remove from current shot
        shot.dialogue.splice(dlIdx, 1);
        // Add to beginning of next shot
        nextShot.dialogue.unshift(movedLine);
      }

      return fetch('/api/save-json/' + episodeId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: JSON.stringify(scenes, null, 2) })
      });
    })
    .then(function(r) { if (r) return r.json(); })
    .then(function(result) {
      if (result && result.success) {
        location.reload();
      } else if (result) {
        alert('Move failed: ' + (result.error || 'unknown'));
      }
    })
    .catch(function(e) { alert('Move failed: ' + e.message); });
}
</script>

<div id="vp-icon" class="vp-icon" onclick="vpOpen()" title="Open Video Player">&#127909;</div>
<div id="video-panel" class="video-panel" style="display:none">
  <div class="vp-header">
    <span class="vp-toggle">&#127909; Player</span>
    <div class="vp-header-btns">
      <button onclick="vpClose()" title="Close">&times;</button>
    </div>
  </div>
  <div class="vp-content">
    <div class="vp-info" id="vp-info">Click a shot thumbnail to play</div>
    <div class="vp-video-wrap">
      <video id="vp-video"></video>
      <div class="vp-timecode" id="vp-timecode">0:00.0 / 0:00.0</div>
    </div>
    <div class="vp-actions">
      <button class="vp-btn" onclick="vpPlayPause()" id="vp-playpause" title="Play/Pause">&#9654;</button>
      <button class="vp-btn" onclick="vpStop()" title="Stop">&#9632;</button>
      <button class="vp-btn" onclick="vpReplay()" title="Replay">&#8634;</button>
      <button class="vp-btn" onclick="vpMute()" id="vp-mute" title="Mute/Unmute">&#128264;</button>
    </div>
    <div class="vp-controls">
      <button onclick="vpSpeed(0.5)" class="vp-speed">0.5x</button>
      <button onclick="vpSpeed(1)" class="vp-speed active">1x</button>
      <button onclick="vpSpeed(2)" class="vp-speed">2x</button>
      <span class="vp-sep">|</span>
      <label style="cursor:pointer"><input type="checkbox" id="vp-loop"> Loop</label>
    </div>
  </div>
</div>

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

// Save analysis settings as separate JSON for the hub
const _cpCount = fs.existsSync(path.join(OUTPUT_DIR, 'cut-points.json'))
  ? JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'cut-points.json'), 'utf-8')).length
  : 0;
const settingsData = {
  model: 'gemini-2.5-pro',
  api: 'Vertex AI',
  project: process.env.GCP_PROJECT || 'vstack-pipleline-v2',
  mediaResolution: 'MEDIA_RESOLUTION_LOW',
  temperature: 0.2,
  maxOutputTokens: 32768,
  chunkMinutes: 'Full episode (no chunking)',
  pipeline: 'v2 — Tier 1 (scene metadata) + PySceneDetect (shots)',
  timestampFormat: 'MM:SS.s (sub-second)',
  sceneDetection: 'PySceneDetect (adaptive)',
  cutPointsDetected: _cpCount,
  frameExtraction: 'First + Last per shot',
  frameResolution: '320px wide, JPEG q:v 3',
  episodeId: EPISODE_ID,
  localFile: path.basename(LOCAL_FILE),
  gcsBucket: process.env.GCS_BUCKET || 'gs://vstack-media-us',
  duration: (duration / 60).toFixed(1) + ' minutes',
  totalScenes: allScenes.length,
  totalShots: allScenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0),
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUTPUT_DIR, 'analysis-settings.json'), JSON.stringify(settingsData, null, 2));

console.log('✅ Scene Review Report saved');

// Only auto-open if run directly (not when called by API/save endpoint)
if (!process.env.VSTACK_NO_OPEN) {
  try { execSync(`start "" "http://localhost:3333/${EPISODE_ID}/scene-review-report.html"`); } catch {}
}

