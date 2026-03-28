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

const MODEL = 'gemini-2.5-pro';
const PROJECT = 'data-mind-456822-q3';
const REGION = 'us-central1';
const CHUNK_MINUTES = 5;
const GCS_URI = `gs://tng-video-analysis-30025/${EPISODE_ID}.mp4`;

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
let scenesHtml = '';
for (const scene of allScenes) {
  const creditsClass = scene.isCredits ? ' credits' : '';
  const creditsBadge = scene.isCredits ? ' <span class="pill credits-badge">CREDITS</span>' : '';
  scenesHtml += `<div class="scene${creditsClass}"><div class="scene-hdr"><h2>Scene ${scene.sceneNumber}${creditsBadge}</h2>
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
    </div><div class="shots">`;

  for (const shot of (scene.shots || [])) {
    const startSec = shot._snappedStart || parseTs(shot.startTimestamp) || 0;
    const endSec = shot._snappedEnd || parseTs(shot.endTimestamp) || 0;
    const dur = (endSec - startSec).toFixed(1);
    const tc = (shot.shotType || '').includes('close') ? 'tc' : (shot.shotType || '').includes('medium') ? 'tm2' : (shot.shotType || '').includes('wide') ? 'tw' : 'to';
    const exprs = shot.characterExpressions ? Object.entries(shot.characterExpressions).map(([k, v]) => `<b>${k}:</b> ${v}`).join(' &middot; ') : '';

    const shotSubjectEsc = (shot.subject || '?').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const shotTypeEsc = (shot.shotType || '?').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const playOnclick = `onclick="playShot(${scene.sceneNumber},${shot.shotNumber},${startSec},${endSec},'${shotSubjectEsc}','${shotTypeEsc}')"`;
    scenesHtml += `<div class="shot" data-sc="${scene.sceneNumber}" data-sh="${shot.shotNumber}" data-start="${startSec.toFixed(3)}" data-end="${endSec.toFixed(3)}"><label class="shot-check"><input type="checkbox" class="shot-cb" onchange="updateJoinBtn()" value="${scene.sceneNumber}-${shot.shotNumber}"></label><div class="fw" ${playOnclick}><img src="frames/${shot._frameFirst || ''}" /><div class="fl fg">▶ ${formatTs(startSec)}</div></div>
      <div class="fw" ${playOnclick}><img src="frames/${shot._frameLast || ''}" /><div class="fl fr">◼ ${formatTs(endSec)}</div></div>
      <div class="si"><div class="sh"><h4>Shot ${shot.shotNumber} <span class="st ${tc}">${shot.shotType || '?'}</span> <span class="dur">${dur}s</span></h4>
      <span class="tt">${formatTs(startSec)} → ${formatTs(endSec)}</span></div>
      <div class="f"><span class="fl2">Subject</span><div class="subj">${shot.subject || '?'}</div></div>
      <div class="f"><span class="fl2">Action</span><div>${shot.action || '?'}</div></div>
      ${shot.cameraMovement ? `<div class="f"><span class="fl2">Camera</span><div class="cam">${shot.cameraMovement}</div></div>` : ''}
      ${exprs ? `<div class="f"><span class="fl2">Expressions</span><div>${exprs}</div></div>` : ''}
      ${shot.dialogue?.length ? `<div class="f dialogue"><span class="fl2">Dialogue</span><div class="dialogue-lines">${shot.dialogue.map(d => {
        if (typeof d === 'string') return `<div class="dl">"${d}"</div>`;
        const speaker = d.speaker ? `<span class="dl-speaker">${d.speaker}:</span> ` : '';
        const tsSec = typeof d.start === 'string' && d.start.includes(':') ? parseTs(d.start) : parseFloat(d.start || 0);
        const ts = d.start ? `<span class="dl-ts">${fmtTs2(tsSec)}</span> ` : '';
        return `<div class="dl">${ts}${speaker}"${d.text}"</div>`;
      }).join('')}</div></div>` : ''}
      ${(shot.tags || []).length ? '<div class="tgs">' + shot.tags.map(t => '<span class="tag">' + t + '</span>').join('') + '</div>' : ''}
      ${(shot.supercutPotential || []).length ? '<div class="tgs">' + shot.supercutPotential.map(t => '<span class="stag">' + t + '</span>').join('') + '</div>' : ''}
      <div class="adj" data-scene="${scene.sceneNumber}" data-shot="${shot.shotNumber}" data-start="${startSec.toFixed(3)}" data-end="${endSec.toFixed(3)}" data-edge="start">
        <span class="adj-label">START</span>
        <button onclick="adjustShot(this,-100,'start')">-100ms</button>
        <button onclick="adjustShot(this,-50,'start')">-50</button>
        <button onclick="adjustShot(this,-10,'start')">-10</button>
        <span class="adj-val" id="adj-start-s${scene.sceneNumber}-sh${shot.shotNumber}">±0ms</span>
        <button onclick="adjustShot(this,10,'start')">+10</button>
        <button onclick="adjustShot(this,50,'start')">+50</button>
        <button onclick="adjustShot(this,100,'start')">+100ms</button>
        <span class="adj-ts" id="adjts-start-s${scene.sceneNumber}-sh${shot.shotNumber}">${formatTs(startSec)}</span>
        <button class="adj-reset" onclick="resetEdge(this,'start')" title="Reset to original">&#8634;</button>
      </div>
      <div class="adj" data-scene="${scene.sceneNumber}" data-shot="${shot.shotNumber}" data-start="${startSec.toFixed(3)}" data-end="${endSec.toFixed(3)}" data-edge="end">
        <span class="adj-label">END</span>
        <button onclick="adjustShot(this,-100,'end')">-100ms</button>
        <button onclick="adjustShot(this,-50,'end')">-50</button>
        <button onclick="adjustShot(this,-10,'end')">-10</button>
        <span class="adj-val" id="adj-end-s${scene.sceneNumber}-sh${shot.shotNumber}">±0ms</span>
        <button onclick="adjustShot(this,10,'end')">+10</button>
        <button onclick="adjustShot(this,50,'end')">+50</button>
        <button onclick="adjustShot(this,100,'end')">+100ms</button>
        <span class="adj-ts" id="adjts-end-s${scene.sceneNumber}-sh${shot.shotNumber}">${formatTs(endSec)}</span>
        <button class="adj-reset" onclick="resetEdge(this,'end')" title="Reset to original">&#8634;</button>
      </div>
      ${dur > 5 ? `<button class="reanalyze-btn" onclick="reanalyzeShot('${scene.sceneNumber}','${shot.shotNumber}',this)" title="Reanalyze this shot with Gemini — splits into finer shots">\u{1F50D} Reanalyze Shot (${dur}s)</button>` : ''}
      <div class="live-preview" id="preview-s${scene.sceneNumber}-sh${shot.shotNumber}" style="display:none">
        <div class="live-frames">
          <div class="live-frame-box"><img class="live-img" id="liveimg-start-s${scene.sceneNumber}-sh${shot.shotNumber}" /><div class="live-edge-label">START</div></div>
          <div class="live-frame-box"><img class="live-img" id="liveimg-end-s${scene.sceneNumber}-sh${shot.shotNumber}" /><div class="live-edge-label">END</div></div>
        </div>
        <div class="live-actions">
          <button class="lock-btn" onclick="lockShot('${scene.sceneNumber}','${shot.shotNumber}')">✓ Lock In</button>
        </div>
      </div>
      </div></div>`;
  }

  if (!scene.shots || scene.shots.length === 0) {
    scenesHtml += `<div style="padding:12px;color:#666;font-style:italic">No shot data available for this scene (Gemini returned scene-level metadata only)</div>`;
  }

  scenesHtml += '</div></div>';
}

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${EPISODE_ID} — Scene Review Report</title>
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
</style></head><body>
<h1>📋 ${EPISODE_ID} — Scene Review Report</h1>
<p class="sub">Full episode scene &amp; shot metadata with frame-perfect timestamps</p>

<div class="stats">
<div class="stat"><div class="stat-val">${allScenes.length}</div><div class="stat-lbl">Scenes</div></div>
<div class="stat"><div class="stat-val">${totalShots}</div><div class="stat-lbl">Shots</div></div>
<div class="stat"><div class="stat-val">${(totalShots / Math.max(allScenes.length, 1)).toFixed(1)}</div><div class="stat-lbl">Avg Shots/Scene</div></div>
<div class="stat"><div class="stat-val">$${totalCost.toFixed(2)}</div><div class="stat-lbl">Analysis Cost</div></div>
<div class="stat"><div class="stat-val">${totalTime}s</div><div class="stat-lbl">Analysis Time</div></div>
</div>

<details class="settings">
<summary>⚙️ Generation Settings &amp; Parameters</summary>
<div class="settings-grid">
  <div class="settings-section">
    <h3>Gemini API Parameters</h3>
    <div class="setting"><span class="setting-key">Model</span><span class="setting-val">${MODEL}</span></div>
    <div class="setting"><span class="setting-key">API</span><span class="setting-val">Vertex AI (${REGION})</span></div>
    <div class="setting"><span class="setting-key">Project</span><span class="setting-val">${PROJECT}</span></div>
    <div class="setting"><span class="setting-key">Media Resolution</span><span class="setting-val">MEDIA_RESOLUTION_LOW</span></div>
    <div class="setting"><span class="setting-key">Temperature</span><span class="setting-val">0.2</span></div>
    <div class="setting"><span class="setting-key">Max Output Tokens</span><span class="setting-val">32,768</span></div>
    <div class="setting"><span class="setting-key">Chunk Size</span><span class="setting-val">${CHUNK_MINUTES} minutes</span></div>
    <div class="setting"><span class="setting-key">Chunks Processed</span><span class="setting-val">${Math.ceil(duration / 60 / CHUNK_MINUTES)}</span></div>
    <div class="setting"><span class="setting-key">Timestamp Format</span><span class="setting-val">MM:SS.s (sub-second)</span></div>
    <div class="setting"><span class="setting-key">Cooldown Between Chunks</span><span class="setting-val">10 seconds</span></div>
  </div>
  <div class="settings-section">
    <h3>Post-Processing</h3>
    <div class="setting"><span class="setting-key">FFmpeg Scene Detection</span><span class="setting-val">select='gt(scene,0.3)'</span></div>
    <div class="setting"><span class="setting-key">Scene Threshold</span><span class="setting-val">0.3 (0-1 scale)</span></div>
    <div class="setting"><span class="setting-key">Cut Points Detected</span><span class="setting-val">${cutPointCount}</span></div>
    <div class="setting"><span class="setting-key">Snap Tolerance</span><span class="setting-val">2.0 seconds</span></div>
    <div class="setting"><span class="setting-key">Frame Extraction</span><span class="setting-val">First + Last per shot</span></div>
    <div class="setting"><span class="setting-key">Frame Resolution</span><span class="setting-val">320px wide, JPEG q:v 3</span></div>
    <div class="setting"><span class="setting-key">FFmpeg Version</span><span class="setting-val">8.1 essentials</span></div>
  </div>
  <div class="settings-section">
    <h3>Source</h3>
    <div class="setting"><span class="setting-key">Episode</span><span class="setting-val">${EPISODE_ID}</span></div>
    <div class="setting"><span class="setting-key">Local File</span><span class="setting-val">${path.basename(LOCAL_FILE)}</span></div>
    <div class="setting"><span class="setting-key">GCS URI</span><span class="setting-val">${GCS_URI}</span></div>
    <div class="setting"><span class="setting-key">Duration</span><span class="setting-val">${(duration / 60).toFixed(1)} minutes</span></div>
  </div>
  <div class="settings-section">
    <h3>Metadata Schema</h3>
    <div class="setting"><span class="setting-key">Scene Fields</span><span class="setting-val">sceneNumber, timestamps, location, characters, mood, plotSignificance</span></div>
    <div class="setting"><span class="setting-key">Shot Fields</span><span class="setting-val">shotNumber, timestamps, duration, shotType, subject, action, characterExpressions, cameraMovement, tags, supercutPotential</span></div>
    <div class="setting"><span class="setting-key">Generated At</span><span class="setting-val">${generatedAt}</span></div>
    <div class="setting"><span class="setting-key">Total Cost</span><span class="setting-val">$${totalCost.toFixed(4)}</span></div>
    <div class="setting"><span class="setting-key">Total Analysis Time</span><span class="setting-val">${totalTime}s</span></div>
  </div>
</div>
</details>

<div class="nav"><label>Jump to: </label><select onchange="document.getElementById('sc-'+this.value)?.scrollIntoView({behavior:'smooth'})">
<option value="">--</option>${allScenes.map(s => `<option value="${s.sceneNumber}">Scene ${s.sceneNumber} (${s.startTimestamp || '?'}) ${(s.location || '').slice(0, 30)}</option>`).join('')}
</select>
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
    <button onclick="exportCorrections()">📋 Export</button>
    <button onclick="applyCorrections()" class="apply-btn">✅ Apply Now</button>
    <button onclick="revertToOriginal()" class="revert-btn" id="revert-btn" style="display:none">↩ Revert to Original</button>
  </div>
</div>

<script>
// Check if backup exists on load — show revert button if so
fetch('/api/backup-status/${EPISODE_ID}')
  .then(r => r.json())
  .then(status => {
    if (status.exists) {
      const btn = document.getElementById('revert-btn');
      btn.style.display = 'inline-block';
      btn.title = 'Backup from ' + status.date;
    }
  })
  .catch(() => {}); // no server = no revert

async function revertToOriginal() {
  const btn = document.getElementById('revert-btn');
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

function fetchLiveFrames(scene, shot, startSec, endSec) {
  const previewDiv = document.getElementById('preview-s' + scene + '-sh' + shot);
  const startImg = document.getElementById('liveimg-start-s' + scene + '-sh' + shot);
  const endImg = document.getElementById('liveimg-end-s' + scene + '-sh' + shot);
  if (!previewDiv) return;

  previewDiv.style.display = 'block';

  const baseUrl = FRAME_SERVER + '/frame?file=' + encodeURIComponent(EPISODE_FILE);

  if (startImg) {
    startImg.style.opacity = '0.5';
    startImg.src = baseUrl + '&t=' + startSec.toFixed(3);
    startImg.onload = () => { startImg.style.opacity = '1'; };
  }
  if (endImg) {
    endImg.style.opacity = '0.5';
    endImg.src = baseUrl + '&t=' + endSec.toFixed(3);
    endImg.onload = () => { endImg.style.opacity = '1'; };
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

      // Hide the live preview after a short delay
      setTimeout(() => {
        const preview = document.getElementById('preview-s' + scene + '-sh' + shot);
        if (preview) preview.style.display = 'none';
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
  document.querySelectorAll('.live-preview').forEach(el => el.style.display = 'none');
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
  const text = 'SCENE REVIEW CORRECTIONS\\nEpisode: ${EPISODE_ID}\\nDate: ' + new Date().toISOString().slice(0,10) + '\\nLocked: ' + lockedShots.size + '\\n\\n' + allLines.join('\\n');
  navigator.clipboard.writeText(text);
  alert('Copied ' + allLines.length + ' item(s) to clipboard!\\n(' + entries.length + ' corrections, ' + lockedShots.size + ' locked)\\n\\nPaste to Claude to apply.');
}

async function applyCorrections() {
  const offsetEntries = Object.values(corrections).filter(c => c.type !== 'join' && (c.startOffsetMs !== 0 || c.endOffsetMs !== 0));

  if (offsetEntries.length === 0) {
    alert('No corrections to apply.');
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
    setTimeout(() => { btn.textContent = '✅ Apply Now'; }, 3000);
  }
}

// --- Reanalyze Shot ---
async function reanalyzeShot(scene, shot, btn) {
  const origText = btn.textContent;
  if (!confirm('Reanalyze Scene ' + scene + ' Shot ' + shot + '?\\n\\nThis will:\\n- Send the shot\\'s time range to Gemini 2.5 Pro\\n- Split it into finer shots based on camera cuts\\n- Re-extract frames and rebuild the report\\n- Cost: ~$0.15-0.30\\n\\nThe page will reload when complete.')) return;

  btn.textContent = '\\u23f3 Analyzing...';
  btn.classList.add('loading');

  try {
    const resp = await fetch('/api/reanalyze-shot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId: '${EPISODE_ID}', sceneNumber: scene, shotNumber: shot })
    });

    const result = await resp.json();
    if (result.success) {
      alert(result.message);
      window.location.reload();
    } else {
      throw new Error(result.error || 'Unknown error');
    }
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

  vpStartSec = startSec;
  vpEndSec = endSec;
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
    // No corrections — just hide the preview
    const p = document.getElementById('preview-s' + scene + '-sh' + shot);
    if (p) p.style.display = 'none';
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

  // Build conflict resolution dialog
  showJoinDialog(items, metas, conflicts, sceneNum, firstShot, lastShot, newStart, newEnd, dur);
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

      // Option for each unique value
      for (let i = 0; i < c.values.length; i++) {
        const shotNums = c.metas.filter(m => m[c.field] === c.values[i]).map(m => m.shot).join(', ');
        const checked = i === 0 ? 'checked' : '';
        const displayVal = isLong ? c.values[i].slice(0, 200) + (c.values[i].length > 200 ? '...' : '') : c.values[i];
        conflictHtml += '<label style="display:block;padding:4px 0;cursor:pointer;font-size:12px;border-bottom:1px solid #222">' +
          '<input type="radio" name="join-' + c.field + '" value="' + i + '" ' + checked + ' style="margin-right:6px;vertical-align:top;margin-top:2px">' +
          '<span style="color:#ce93d8">Shot ' + shotNums + ':</span> ' +
          '<span style="color:#ddd">' + displayVal + '</span></label>';
      }

      // Combine all option
      conflictHtml += '<label style="display:block;padding:4px 0;cursor:pointer;font-size:12px">' +
        '<input type="radio" name="join-' + c.field + '" value="combine" style="margin-right:6px">' +
        '<span style="color:#4fc3f7">Combine all values</span></label>';

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
    '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">' +
    '<button onclick="document.getElementById(\\x27join-dialog\\x27).remove()" style="background:#333;color:#aaa;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px">Cancel</button>' +
    '<button onclick="executeJoin()" style="background:#ff9800;color:#000;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold">Join Shots</button>' +
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

  // Hide live preview if no corrections remain
  const preview = document.getElementById('preview-s' + scene + '-sh' + shot);
  if (preview && !corrections[key]) preview.style.display = 'none';

  updateCount();
}

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  if (document.activeElement === document.getElementById('search-input')) return;

  const video = document.getElementById('vp-video');
  if (!video) return;

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
console.log('✅ Scene Review Report saved');

execSync(`start "" "${path.join(OUTPUT_DIR, 'scene-review-report.html')}"`);

