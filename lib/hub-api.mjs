/**
 * Hub API — JSON endpoints for the vstack media library dashboard.
 * Imported by frame-server.mjs to handle /api/* routes.
 */

import { getDb, getStats, getSeriesList, getEpisodes, getEpisodeDetail,
         getEpisodeThumbnail, getRandomThumbnail, setEpisodeThumbnail, createSeries, assignEpisodeToSeries,
         search, searchDialogue, semanticSearch, rebuildEpisode, closeDb } from './db.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');
const QUEUE_FILE = path.join(ANALYSIS_DIR, '_analysis-queue.json');

// ── Queue System ────────────────────────────────────────────────────

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8')); } catch { return []; }
}

function saveQueue(queue) {
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

let queueProcessorRunning = false;

function processNextInQueue() {
  if (queueProcessorRunning) return;

  const queue = loadQueue();
  const next = queue.find(q => q.status === 'queued');
  if (!next) return;

  // Check if anything is currently analyzing
  const analyzing = queue.find(q => q.status === 'analyzing');
  if (analyzing) {
    // Check if it's actually still alive
    const statusFile = path.join(ANALYSIS_DIR, analyzing.episodeId, '_analysis-status.json');
    if (fs.existsSync(statusFile)) {
      try {
        const s = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
        const age = (Date.now() - new Date(s.heartbeat).getTime()) / 1000;
        if (age < 300) return; // Still alive, wait
        // Stale — mark as failed and continue
        analyzing.status = 'failed';
        analyzing.error = 'Process stale (no heartbeat for 5+ minutes)';
        analyzing.completedAt = new Date().toISOString();
        saveQueue(queue);
      } catch {}
    }
  }

  // Start next episode
  queueProcessorRunning = true;
  next.status = 'analyzing';
  next.startedAt = new Date().toISOString();
  saveQueue(queue);

  const GCLOUD_PATH = process.env.GCLOUD_PATH || 'C:\\Users\\steve\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin';
  const analyzeScript = path.join(__dirname, 'analyze-episode-v2.mjs');
  const args = [
    `"${analyzeScript}"`,
    `"${next.episodeId}"`,
    `"${next.videoPath}"`,
  ];
  if (next.region) args.push('--region', next.region);
  if (next.skipUpload) args.push('--skip-upload');

  const cmd = 'node ' + args.join(' ');
  const child = exec(cmd, {
    cwd: __dirname,
    env: {
      ...process.env,
      VSTACK_NO_OPEN: '1',
      MEDIA_DIR: path.dirname(next.videoPath),
      GCLOUD_PATH,
      PATH: process.env.PATH + (process.platform === 'win32' ? ';' : ':') + GCLOUD_PATH,
    },
    maxBuffer: 50 * 1024 * 1024,
  });

  // Log output
  const logDir = path.join(ANALYSIS_DIR, next.episodeId);
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `analysis-${new Date().toISOString().slice(0, 10)}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.write(`\n${'═'.repeat(60)}\n  Queue analysis started: ${new Date().toISOString()}\n  Args: ${args.join(' ')}\n${'═'.repeat(60)}\n\n`);
  if (child.stdout) child.stdout.pipe(logStream);
  if (child.stderr) child.stderr.pipe(logStream);

  child.on('close', (code) => {
    queueProcessorRunning = false;
    const q = loadQueue();
    const item = q.find(i => i.episodeId === next.episodeId && i.status === 'analyzing');
    if (item) {
      item.status = code === 0 ? 'complete' : 'failed';
      item.completedAt = new Date().toISOString();
      if (code !== 0) item.error = `Exit code ${code}`;
      saveQueue(q);
    }
    // Process next item after a short cooldown
    setTimeout(() => processNextInQueue(), 10000);
  });

  child.unref();
}

// Check queue every 30 seconds
setInterval(() => processNextInQueue(), 30000);

function parseTs(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const parts = ts.split(':');
  if (parts.length !== 2) return 0;
  return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
}

function fmtTs(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0');
}

/**
 * Handle an API request. Returns true if handled, false if not an API route.
 */
export function handleApiRequest(url, req, res) {
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) return false;

  // CORS + JSON headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    // GET /api/stats
    if (pathname === '/api/stats') {
      const stats = getStats();
      res.writeHead(200);
      res.end(JSON.stringify(stats));
      return true;
    }

    // GET /api/series
    if (pathname === '/api/series' && req.method === 'GET') {
      const series = getSeriesList();
      res.writeHead(200);
      res.end(JSON.stringify(series));
      return true;
    }

    // POST /api/series — create a new series
    if (pathname === '/api/series' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { id, title } = JSON.parse(body);
          if (!id || !title) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'id and title required' }));
            return;
          }
          createSeries(id, title);
          res.writeHead(201);
          res.end(JSON.stringify({ id, title, created: true }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // GET /api/episodes?series=X
    if (pathname === '/api/episodes') {
      const seriesId = url.searchParams.get('series') || null;
      const episodes = getEpisodes(seriesId);

      // Add thumbnail paths
      const withThumbs = episodes.map(ep => ({
        ...ep,
        thumbnail: getEpisodeThumbnail(ep.id),
      }));

      res.writeHead(200);
      res.end(JSON.stringify(withThumbs));
      return true;
    }

    // GET /api/random-thumbnail/:episodeId
    const randomThumbMatch = pathname.match(/^\/api\/random-thumbnail\/(.+)$/);
    if (randomThumbMatch) {
      const episodeId = decodeURIComponent(randomThumbMatch[1]);
      const thumb = getRandomThumbnail(episodeId);
      res.writeHead(200);
      res.end(JSON.stringify({ thumbnail: thumb }));
      return true;
    }

    // POST /api/set-thumbnail/:episodeId — save a custom thumbnail
    const setThumbMatch = pathname.match(/^\/api\/set-thumbnail\/(.+)$/);
    if (setThumbMatch && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { thumbnail } = JSON.parse(body);
          const episodeId = decodeURIComponent(setThumbMatch[1]);
          setEpisodeThumbnail(episodeId, thumbnail);
          res.writeHead(200);
          res.end(JSON.stringify({ saved: true, thumbnail }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // GET /api/episode/:id
    const episodeMatch = pathname.match(/^\/api\/episode\/(.+)$/);
    if (episodeMatch) {
      const episodeId = decodeURIComponent(episodeMatch[1]);
      const detail = getEpisodeDetail(episodeId);
      if (!detail) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Episode not found' }));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify(detail));
      }
      return true;
    }

    // GET /api/search?q=QUERY&scope=shots|dialogue|both
    if (pathname === '/api/search') {
      const q = url.searchParams.get('q');
      if (!q) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing ?q= parameter' }));
        return true;
      }

      const scope = url.searchParams.get('scope') || 'shots';
      const limit = parseInt(url.searchParams.get('limit') || '30');
      const results = { shots: [], dialogue: [] };

      if (scope === 'shots' || scope === 'both') {
        try {
          results.shots = semanticSearch(q, { limit });
        } catch {
          results.shots = search(q, { limit });
        }
      }

      if (scope === 'dialogue' || scope === 'both') {
        try {
          results.dialogue = searchDialogue(q, { limit });
        } catch { /* skip */ }
      }

      res.writeHead(200);
      res.end(JSON.stringify(results));
      return true;
    }

    // POST /api/series — create new series
    if (pathname === '/api/series' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { id, title } = JSON.parse(body);
          if (!id || !title) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing id or title' }));
            return;
          }
          const result = createSeries(id, title);
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return true;
    }

    // GET /api/raw-tables — list all tables with row counts and sample rows
    if (pathname === '/api/raw-tables') {
      const db = getDb();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const result = {};
      for (const { name } of tables) {
        const count = db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get().c;
        const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name);
        const sample = db.prepare(`SELECT * FROM "${name}" LIMIT 5`).all();
        result[name] = { count, columns, sample };
      }
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return true;
    }

    // GET /api/raw-table/:name?limit=N&offset=N — browse a specific table
    const rawTableMatch = pathname.match(/^\/api\/raw-table\/(.+)$/);
    if (rawTableMatch) {
      const tableName = decodeURIComponent(rawTableMatch[1]);
      const db = getDb();
      // Validate table exists
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
      if (!exists) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `Table "${tableName}" not found` }));
        return true;
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const count = db.prepare(`SELECT COUNT(*) as c FROM "${tableName}"`).get().c;
      const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all().map(c => ({ name: c.name, type: c.type }));
      const rows = db.prepare(`SELECT * FROM "${tableName}" LIMIT ? OFFSET ?`).all(limit, offset);
      res.writeHead(200);
      res.end(JSON.stringify({ table: tableName, count, columns, rows, limit, offset }));
      return true;
    }

    // POST /api/rename-episode/:episodeId — rename an episode
    const renameMatch = pathname.match(/^\/api\/rename-episode\/(.+)$/);
    if (renameMatch && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const episodeId = decodeURIComponent(renameMatch[1]);
          const { title } = JSON.parse(body);
          if (!title) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'title required' }));
            return;
          }
          const db = getDb();
          db.prepare('UPDATE episodes SET title = ? WHERE id = ?').run(title, episodeId);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, id: episodeId, title }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // POST /api/assign-episode — assign episode to a series/collection
    if (pathname === '/api/assign-episode' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { episodeId, seriesId } = JSON.parse(body);
          if (!episodeId || !seriesId) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'episodeId and seriesId required' }));
            return;
          }
          assignEpisodeToSeries(episodeId, seriesId);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, episodeId, seriesId }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // POST /api/rebuild-report/:episodeId — rebuild Scene Review Report
    const rebuildReportMatch = pathname.match(/^\/api\/rebuild-report\/(.+)$/);
    if (rebuildReportMatch && req.method === 'POST') {
      const episodeId = decodeURIComponent(rebuildReportMatch[1]);
      try {
        const mediaDir = process.env.MEDIA_DIR || 'C:\\Star Trek';
        const mediaFiles = fs.readdirSync(mediaDir);
        const epMatch = episodeId.match(/S(\d+)E(\d+)/i);
        const videoFile = epMatch
          ? mediaFiles.find(f => new RegExp(`s0?${epMatch[1]}e0?${epMatch[2]}`, 'i').test(f) && f.endsWith('.mp4'))
          : null;

        if (!videoFile) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Video file not found for ' + episodeId }));
          return true;
        }

        const rebuildScript = path.join(__dirname, 'rebuild-report.mjs');
        execSync(`node "${rebuildScript}" "${episodeId}" "${path.join(mediaDir, videoFile)}"`, {
          env: { ...process.env, VSTACK_NO_OPEN: "1" }, cwd: __dirname, stdio: "pipe", timeout: 60000
        });

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Report rebuilt for ' + episodeId }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Rebuild failed: ' + e.message }));
      }
      return true;
    }

    // POST /api/reanalyze-shot — reanalyze a single shot (background job)
    if (pathname === '/api/reanalyze-shot' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { episodeId, sceneNumber, shotNumber } = JSON.parse(body);
          if (!episodeId || !sceneNumber || !shotNumber) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'episodeId, sceneNumber, shotNumber required' }));
            return;
          }

          // Validate episode/scene/shot exist
          const scenesPath = path.join(ANALYSIS_DIR, episodeId, 'scenes.json');
          if (!fs.existsSync(scenesPath)) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Episode not found' }));
            return;
          }

          const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));
          const scene = scenes.find(s => s.sceneNumber === parseInt(sceneNumber));
          if (!scene?.shots?.find(s => s.shotNumber === parseInt(shotNumber))) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Scene/shot not found' }));
            return;
          }

          // Write status file and respond immediately
          const statusFile = path.join(ANALYSIS_DIR, episodeId, '_reanalyze-status.json');
          fs.writeFileSync(statusFile, JSON.stringify({ status: 'processing', scene: sceneNumber, shot: shotNumber, startedAt: new Date().toISOString() }));

          res.writeHead(202);
          res.end(JSON.stringify({ status: 'processing', message: 'Reanalysis started. Poll /api/reanalyze-status/' + episodeId + ' for progress.' }));

          // Run the standalone reanalyze script in background
          const reanalyzeScript = path.join(__dirname, 'reanalyze-shot.mjs');
          const child = exec(`node "${reanalyzeScript}" "${episodeId}" ${parseInt(sceneNumber)} ${parseInt(shotNumber)}`, {
            cwd: __dirname,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5 * 60 * 1000,
            env: { ...process.env, MEDIA_DIR: process.env.MEDIA_DIR || 'C:\\Star Trek' }
          });
          child.unref();

        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // GET /api/reanalyze-status/:episodeId — poll reanalysis progress
    const reanalyzeStatusMatch = pathname.match(/^\/api\/reanalyze-status\/(.+)$/);
    if (reanalyzeStatusMatch && req.method === 'GET') {
      const episodeId = decodeURIComponent(reanalyzeStatusMatch[1]);
      const statusFile = path.join(ANALYSIS_DIR, episodeId, '_reanalyze-status.json');
      if (fs.existsSync(statusFile)) {
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
        res.writeHead(200);
        res.end(JSON.stringify(status));
        // Clean up if done/error
        if (status.status === 'done' || status.status === 'error') {
          try { fs.unlinkSync(statusFile); } catch {}
        }
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'idle' }));
      }
      return true;
    }

    // DELETE /api/delete-episode/:episodeId — delete episode data
    const deleteEpMatch = pathname.match(/^\/api\/delete-episode\/(.+)$/);
    if (deleteEpMatch && req.method === 'DELETE') {
      const episodeId = decodeURIComponent(deleteEpMatch[1]);
      try {
        const db = getDb();
        const epDir = path.join(ANALYSIS_DIR, episodeId);

        // Delete from DB
        db.prepare('DELETE FROM dialogue WHERE episode_id = ?').run(episodeId);
        db.prepare('DELETE FROM shots WHERE episode_id = ?').run(episodeId);
        db.prepare('DELETE FROM scenes WHERE episode_id = ?').run(episodeId);
        db.prepare('DELETE FROM episodes WHERE id = ?').run(episodeId);

        // Delete files
        if (fs.existsSync(epDir)) {
          fs.rmSync(epDir, { recursive: true });
        }

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: `Deleted ${episodeId} — data and files removed` }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Delete failed: ' + e.message }));
      }
      return true;
    }

    // GET /api/export-episode/:episodeId — export single episode as .vstack.zip
    const exportEpMatch = pathname.match(/^\/api\/export-episode\/(.+)$/);
    if (exportEpMatch && req.method === 'GET') {
      const episodeId = decodeURIComponent(exportEpMatch[1]);
      const epDir = path.join(ANALYSIS_DIR, episodeId);
      const scenesPath = path.join(epDir, 'scenes.json');

      if (!fs.existsSync(scenesPath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `Episode ${episodeId} not found` }));
        return true;
      }

      try {
        const tmpDir = path.join(ANALYSIS_DIR, '_export_ep_tmp');
        const zipPath = path.join(ANALYSIS_DIR, `_export_${episodeId}.zip`);
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        fs.mkdirSync(path.join(tmpDir, episodeId, 'frames'), { recursive: true });

        // Copy all episode data files
        const filesToCopy = fs.readdirSync(epDir).filter(f =>
          f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('scenes.pre-import')
        );
        for (const f of filesToCopy) {
          fs.copyFileSync(path.join(epDir, f), path.join(tmpDir, episodeId, f));
        }

        // Copy frames
        const framesDir = path.join(epDir, 'frames');
        if (fs.existsSync(framesDir)) {
          const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
          for (const f of files) {
            fs.copyFileSync(path.join(framesDir, f), path.join(tmpDir, episodeId, 'frames', f));
          }
        }

        // Get episode metadata from DB
        const db = getDb();
        const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);

        // Write manifest
        const manifest = {
          vstack_version: '0.1.0',
          type: 'episode',
          export_date: new Date().toISOString(),
          episode: {
            id: episodeId,
            title: ep?.title || episodeId,
            filename: ep?.filename || '',
            duration_sec: ep?.duration_sec || 0,
          }
        };
        fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

        // Create ZIP
        if (process.platform === 'win32') {
          execSync(`powershell -Command "Compress-Archive -Path '${tmpDir}\\*' -DestinationPath '${zipPath}' -Force"`, { stdio: 'pipe' });
        } else {
          execSync(`cd "${tmpDir}" && zip -r "${zipPath}" .`, { stdio: 'pipe' });
        }

        fs.rmSync(tmpDir, { recursive: true });

        const stat = fs.statSync(zipPath);
        const epTitle = ep?.title ? ep.title.replace(/[^a-zA-Z0-9_\- ]/g, '') : '';
        const filename = epTitle ? `${episodeId} - ${epTitle}.vstack.zip` : `${episodeId}.vstack.zip`;
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': stat.size,
        });
        const stream = fs.createReadStream(zipPath);
        stream.pipe(res);
        stream.on('end', () => { try { fs.unlinkSync(zipPath); } catch {} });
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Export failed: ' + e.message }));
      }
      return true;
    }

    // POST /api/import-episode/:episodeId — restore episode from .vstack.zip
    const importEpMatch = pathname.match(/^\/api\/import-episode\/(.+)$/);
    if (importEpMatch && req.method === 'POST') {
      const episodeId = decodeURIComponent(importEpMatch[1]);
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          const tmpZip = path.join(ANALYSIS_DIR, '_import_ep.zip');
          const tmpDir = path.join(ANALYSIS_DIR, '_import_ep_tmp');

          fs.writeFileSync(tmpZip, buffer);
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
          fs.mkdirSync(tmpDir, { recursive: true });

          // Extract ZIP
          if (process.platform === 'win32') {
            execSync(`powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'pipe' });
          } else {
            execSync(`cd "${tmpDir}" && unzip "${tmpZip}"`, { stdio: 'pipe' });
          }

          // Find scenes.json — could be at root/episodeId/scenes.json or root/scenes.json
          const epDir = path.join(ANALYSIS_DIR, episodeId);
          fs.mkdirSync(path.join(epDir, 'frames'), { recursive: true });

          let scenesSource = null;
          if (fs.existsSync(path.join(tmpDir, episodeId, 'scenes.json'))) {
            scenesSource = path.join(tmpDir, episodeId, 'scenes.json');
          } else if (fs.existsSync(path.join(tmpDir, 'scenes.json'))) {
            scenesSource = path.join(tmpDir, 'scenes.json');
          }

          if (!scenesSource) {
            // Search recursively
            const found = execSync(`find "${tmpDir}" -name "scenes.json" -type f`, { encoding: 'utf-8' }).trim();
            if (found) scenesSource = found.split('\n')[0];
          }

          if (!scenesSource) {
            throw new Error('No scenes.json found in ZIP');
          }

          // Backup existing before overwriting
          const existingScenes = path.join(epDir, 'scenes.json');
          if (fs.existsSync(existingScenes)) {
            const backupPath = path.join(epDir, 'scenes.pre-import.json');
            fs.copyFileSync(existingScenes, backupPath);
          }

          // Copy all JSON files from source (scenes, chunks, cut-points, etc)
          const srcEpDir = path.dirname(scenesSource);
          const jsonFiles = fs.readdirSync(srcEpDir).filter(f => f.endsWith('.json'));
          for (const f of jsonFiles) {
            fs.copyFileSync(path.join(srcEpDir, f), path.join(epDir, f));
          }

          // Copy frames if present
          const framesSource = path.join(path.dirname(scenesSource), 'frames');
          if (fs.existsSync(framesSource)) {
            const files = fs.readdirSync(framesSource).filter(f => f.endsWith('.jpg'));
            for (const f of files) {
              fs.copyFileSync(path.join(framesSource, f), path.join(epDir, 'frames', f));
            }
          }

          // Read manifest for metadata
          let metadata = {};
          const manifestPath = path.join(tmpDir, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            metadata = manifest.episode || {};
          }

          // Rebuild DB
          rebuildEpisode(episodeId, existingScenes, metadata);

          // Clean up
          fs.rmSync(tmpDir, { recursive: true });
          fs.unlinkSync(tmpZip);

          const scenes = JSON.parse(fs.readFileSync(existingScenes, 'utf-8'));
          const totalShots = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);

          // Rebuild Scene Review Report
          const mediaDir = process.env.MEDIA_DIR || 'C:\\Star Trek';
          const mediaFiles = fs.readdirSync(mediaDir);
          const epMatch2 = episodeId.match(/S(\d+)E(\d+)/i);
          const videoFile = epMatch2
            ? mediaFiles.find(f => new RegExp(`s0?${epMatch2[1]}e0?${epMatch2[2]}`, 'i').test(f) && f.endsWith('.mp4'))
            : null;

          if (videoFile) {
            try {
              const rebuildScript = path.join(__dirname, 'rebuild-report.mjs');
              execSync(`node "${rebuildScript}" "${episodeId}" "${path.join(mediaDir, videoFile)}"`, {
                env: { ...process.env, VSTACK_NO_OPEN: '1' },
                cwd: __dirname,
                stdio: 'pipe',
                timeout: 30000
              });
              console.log('[import-episode] Report rebuilt for', episodeId);
            } catch (e) {
              console.log('[import-episode] Report rebuild failed:', e.message?.slice(0, 80));
            }
          }

          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            scenes: scenes.length,
            shots: totalShots,
            message: `Restored ${episodeId}: ${scenes.length} scenes, ${totalShots} shots`
          }));
        } catch (e) {
          const tmpDir = path.join(ANALYSIS_DIR, '_import_ep_tmp');
          const tmpZip = path.join(ANALYSIS_DIR, '_import_ep.zip');
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
          if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Import failed: ' + e.message }));
        }
      });
      return true;
    }

    // GET /api/export/:seriesId — export collection as .vstack.zip
    const exportMatch = pathname.match(/^\/api\/export\/(.+)$/);
    if (exportMatch && req.method === 'GET') {
      const seriesId = decodeURIComponent(exportMatch[1]);
      const db = getDb();

      // Get series info
      const series = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
      if (!series) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Collection not found' }));
        return true;
      }

      // Get episodes
      const episodes = db.prepare('SELECT * FROM episodes WHERE series_id = ?').all(seriesId);

      // Build manifest
      const manifest = {
        vstack_version: '0.1.0',
        export_date: new Date().toISOString(),
        collection: { id: series.id, title: series.title },
        episodes: []
      };

      // Collect scenes.json data for each episode
      for (const ep of episodes) {
        const scenesPath = path.join(ANALYSIS_DIR, ep.id, 'scenes.json');
        let scenes = [];
        if (fs.existsSync(scenesPath)) {
          scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));
        }
        manifest.episodes.push({
          id: ep.id,
          title: ep.title,
          filename: ep.filename,
          duration_sec: ep.duration_sec,
          scenes
        });
      }

      // Create zip using Node's built-in zlib + tar-like approach
      // Since we need a proper ZIP, use a temp directory approach
      const tmpDir = path.join(ANALYSIS_DIR, '_export_tmp');
      const zipPath = path.join(ANALYSIS_DIR, `${seriesId}.vstack.zip`);

      try {
        // Clean up
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        fs.mkdirSync(tmpDir, { recursive: true });

        // Write manifest
        fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

        // Copy all episode data files + frames
        for (const ep of episodes) {
          const epSrcDir = path.join(ANALYSIS_DIR, ep.id);
          const destEpDir = path.join(tmpDir, ep.id);
          fs.mkdirSync(path.join(destEpDir, 'frames'), { recursive: true });

          // All JSON data files (chunks, cut-points, etc — skip temp/backup files)
          if (fs.existsSync(epSrcDir)) {
            const dataFiles = fs.readdirSync(epSrcDir).filter(f =>
              f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('scenes.pre-import') && !f.startsWith('scenes.backup')
            );
            for (const f of dataFiles) {
              fs.copyFileSync(path.join(epSrcDir, f), path.join(destEpDir, f));
            }
          }

          // Frames
          const framesDir = path.join(epSrcDir, 'frames');
          if (fs.existsSync(framesDir)) {
            const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
            for (const f of files) {
              fs.copyFileSync(path.join(framesDir, f), path.join(destEpDir, 'frames', f));
            }
          }
        }

        // Create ZIP using PowerShell (Windows) or zip command
        if (process.platform === 'win32') {
          execSync(`powershell -Command "Compress-Archive -Path '${tmpDir}\\*' -DestinationPath '${zipPath}' -Force"`, { stdio: 'pipe' });
        } else {
          execSync(`cd "${tmpDir}" && zip -r "${zipPath}" .`, { stdio: 'pipe' });
        }

        // Clean up temp
        fs.rmSync(tmpDir, { recursive: true });

        // Serve the ZIP
        const stat = fs.statSync(zipPath);
        const filename = `${series.title || seriesId}.vstack.zip`;
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': stat.size,
        });
        const stream = fs.createReadStream(zipPath);
        stream.pipe(res);
        stream.on('end', () => {
          // Clean up zip file after serving
          try { fs.unlinkSync(zipPath); } catch {}
        });
      } catch (e) {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Export failed: ' + e.message }));
      }
      return true;
    }

    // POST /api/import — import collection from .vstack.zip
    if (pathname === '/api/import' && req.method === 'POST') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          const tmpZip = path.join(ANALYSIS_DIR, '_import.zip');
          const tmpDir = path.join(ANALYSIS_DIR, '_import_tmp');

          // Write uploaded zip
          fs.writeFileSync(tmpZip, buffer);

          // Extract
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
          fs.mkdirSync(tmpDir, { recursive: true });

          if (process.platform === 'win32') {
            execSync(`powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'pipe' });
          } else {
            execSync(`unzip -o "${tmpZip}" -d "${tmpDir}"`, { stdio: 'pipe' });
          }

          // Read manifest
          const manifestPath = path.join(tmpDir, 'manifest.json');
          if (!fs.existsSync(manifestPath)) {
            throw new Error('Invalid .vstack.zip: no manifest.json found');
          }
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

          // Create/update series
          const db = getDb();
          createSeries(manifest.collection.id, manifest.collection.title);

          // Import each episode
          let imported = 0;
          for (const ep of manifest.episodes) {
            // Write scenes.json
            const epDir = path.join(ANALYSIS_DIR, ep.id);
            fs.mkdirSync(path.join(epDir, 'frames'), { recursive: true });
            fs.writeFileSync(path.join(epDir, 'scenes.json'), JSON.stringify(ep.scenes, null, 2));

            // Copy all JSON files from backup (chunks, cut-points, etc)
            const srcEpDir = path.join(tmpDir, ep.id);
            if (fs.existsSync(srcEpDir)) {
              const dataFiles = fs.readdirSync(srcEpDir).filter(f => f.endsWith('.json') && f !== 'scenes.json');
              for (const f of dataFiles) {
                fs.copyFileSync(path.join(srcEpDir, f), path.join(epDir, f));
              }
            }

            // Copy frames
            const srcFrames = path.join(tmpDir, ep.id, 'frames');
            if (fs.existsSync(srcFrames)) {
              const files = fs.readdirSync(srcFrames).filter(f => f.endsWith('.jpg'));
              for (const f of files) {
                fs.copyFileSync(path.join(srcFrames, f), path.join(epDir, 'frames', f));
              }
            }

            // Rebuild DB for this episode
            rebuildEpisode(ep.id, path.join(epDir, 'scenes.json'), {
              title: ep.title,
              filename: ep.filename,
              duration: ep.duration_sec
            });

            // Assign to series
            assignEpisodeToSeries(ep.id, manifest.collection.id);
            imported++;
          }

          // Clean up
          fs.rmSync(tmpDir, { recursive: true });
          fs.unlinkSync(tmpZip);

          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            collection: manifest.collection,
            imported,
            message: `Imported ${imported} episodes into "${manifest.collection.title}"`
          }));
        } catch (e) {
          const tmpDir = path.join(ANALYSIS_DIR, '_import_tmp');
          const tmpZip = path.join(ANALYSIS_DIR, '_import.zip');
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
          if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Import failed: ' + e.message }));
        }
      });
      return true;
    }

    // POST /api/apply-corrections — apply timestamp corrections directly to scenes.json
    if (pathname === '/api/apply-corrections' && req.method === 'POST') {
      console.log('[apply-corrections] POST received');
      let body = '';
      req.on('data', chunk => { body += chunk; console.log('[apply-corrections] data chunk:', chunk.length); });
      req.on('end', () => {
        console.log('[apply-corrections] body complete:', body.length, 'bytes');
        try {
          const { episodeId, corrections } = JSON.parse(body);
          // corrections: [{ scene, shot, startOffsetMs, endOffsetMs }]

          if (!episodeId || !corrections?.length) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'episodeId and corrections[] required' }));
            return;
          }

          const scenesPath = path.join(ANALYSIS_DIR, episodeId, 'scenes.json');
          if (!fs.existsSync(scenesPath)) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: `scenes.json not found for ${episodeId}` }));

            return;
          }

          // Save backup before modifying
          const backupPath = path.join(ANALYSIS_DIR, episodeId, 'scenes.backup.json');
          if (!fs.existsSync(backupPath)) {
            // Only save the first backup (the original state)
            fs.copyFileSync(scenesPath, backupPath);
            console.log('[apply-corrections] Saved original backup');
          }

          const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));

          function parseTs(ts) {
            if (!ts || typeof ts !== 'string') return 0;
            const [m, s] = ts.split(':');
            return parseInt(m) * 60 + parseFloat(s);
          }
          function fmtTs(sec) {
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            return String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0');
          }

          let applied = 0;
          const framesToExtract = [];

          for (const c of corrections) {
            const sc = scenes.find(s => s.sceneNumber === parseInt(c.scene));
            if (!sc?.shots) continue;
            const sh = sc.shots.find(s => s.shotNumber === parseInt(c.shot));
            if (!sh) continue;

            const origStart = parseTs(sh.startTimestamp);
            const origEnd = parseTs(sh.endTimestamp);

            if (c.startOffsetMs && c.startOffsetMs !== 0) {
              sh.startTimestamp = fmtTs(origStart + c.startOffsetMs / 1000);
            }
            if (c.endOffsetMs && c.endOffsetMs !== 0) {
              sh.endTimestamp = fmtTs(origEnd + c.endOffsetMs / 1000);
            }

            // Mark for frame re-extraction
            framesToExtract.push({
              scene: sc.sceneNumber,
              shot: sh.shotNumber,
              start: parseTs(sh.startTimestamp),
              end: parseTs(sh.endTimestamp),
            });
            applied++;
          }

          // Save updated scenes.json
          fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2));

          // Re-extract frames for corrected shots
          const framesDir = path.join(ANALYSIS_DIR, episodeId, 'frames');
          const ffmpegDir = path.join(__dirname, 'ffmpeg');
          const ffmpegSubdirs = fs.readdirSync(ffmpegDir).filter(d => d.startsWith('ffmpeg-'));
          const FFMPEG = path.join(ffmpegDir, ffmpegSubdirs[0], 'bin', 'ffmpeg.exe');

          // Find the video file
          const mediaDir = process.env.MEDIA_DIR || 'C:\\Star Trek';
          const mediaFiles = fs.readdirSync(mediaDir);
          const epMatch = episodeId.match(/S(\d+)E(\d+)/i);
          const videoFile = epMatch
            ? mediaFiles.find(f => new RegExp(`s0?${epMatch[1]}e0?${epMatch[2]}`, 'i').test(f) && f.endsWith('.mp4'))
            : null;

          let framesUpdated = 0;
          if (videoFile) {
            const videoPath = path.join(mediaDir, videoFile);
            for (const f of framesToExtract) {
              const firstPath = path.join(framesDir, `sc${f.scene}_sh${f.shot}_first.jpg`);
              const lastPath = path.join(framesDir, `sc${f.scene}_sh${f.shot}_last.jpg`);
              try {
                execSync(`"${FFMPEG}" -ss ${f.start.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${firstPath}" -y`, { stdio: 'pipe', timeout: 10000 });
                execSync(`"${FFMPEG}" -ss ${f.end.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${lastPath}" -y`, { stdio: 'pipe', timeout: 10000 });
                framesUpdated++;
              } catch { /* best effort */ }
            }
          }

          // Rebuild DB
          try {
            rebuildEpisode(episodeId, scenesPath);
          } catch { /* best effort */ }

          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            applied,
            framesUpdated,
            message: `Applied ${applied} corrections, re-extracted ${framesUpdated} frame pairs`
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Apply failed: ' + e.message }));
        }
      });
      return true;
    }

    // GET /api/backup-status/:episodeId — check if a backup exists
    const backupStatusMatch = pathname.match(/^\/api\/backup-status\/(.+)$/);
    if (backupStatusMatch && req.method === 'GET') {
      const episodeId = decodeURIComponent(backupStatusMatch[1]);
      const backupPath = path.join(ANALYSIS_DIR, episodeId, 'scenes.backup.json');
      const exists = fs.existsSync(backupPath);
      let backupInfo = null;
      if (exists) {
        const stat = fs.statSync(backupPath);
        backupInfo = { exists: true, size: stat.size, date: stat.mtime.toISOString() };
      }
      res.writeHead(200);
      res.end(JSON.stringify(backupInfo || { exists: false }));
      return true;
    }

    // POST /api/revert/:episodeId — revert scenes.json to the backup
    const revertMatch = pathname.match(/^\/api\/revert\/(.+)$/);
    if (revertMatch && req.method === 'POST') {
      const episodeId = decodeURIComponent(revertMatch[1]);
      const scenesPath = path.join(ANALYSIS_DIR, episodeId, 'scenes.json');
      const backupPath = path.join(ANALYSIS_DIR, episodeId, 'scenes.backup.json');

      if (!fs.existsSync(backupPath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'No backup found for ' + episodeId }));
        return true;
      }

      try {
        // Restore backup
        fs.copyFileSync(backupPath, scenesPath);

        // Re-extract ALL frames from original timestamps
        const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8'));
        const framesDir = path.join(ANALYSIS_DIR, episodeId, 'frames');

        const ffmpegDir2 = path.join(__dirname, 'ffmpeg');
        const ffmpegSubdirs2 = fs.readdirSync(ffmpegDir2).filter(d => d.startsWith('ffmpeg-'));
        const FFMPEG2 = path.join(ffmpegDir2, ffmpegSubdirs2[0], 'bin', 'ffmpeg.exe');

        const mediaDir = process.env.MEDIA_DIR || 'C:\\Star Trek';
        const mediaFiles = fs.readdirSync(mediaDir);
        const epMatch = episodeId.match(/S(\d+)E(\d+)/i);
        const videoFile = epMatch
          ? mediaFiles.find(f => new RegExp(`s0?${epMatch[1]}e0?${epMatch[2]}`, 'i').test(f) && f.endsWith('.mp4'))
          : null;

        let framesRestored = 0;
        if (videoFile) {
          const videoPath = path.join(mediaDir, videoFile);
          function parseTs(ts) {
            if (!ts || typeof ts !== 'string') return 0;
            const [m, s] = ts.split(':');
            return parseInt(m) * 60 + parseFloat(s);
          }

          // Clear all frames
          if (fs.existsSync(framesDir)) {
            fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).forEach(f => fs.unlinkSync(path.join(framesDir, f)));
          }

          // Re-extract from original timestamps
          for (const sc of scenes) {
            for (const sh of (sc.shots || [])) {
              const startSec = parseTs(sh.startTimestamp);
              const endSec = parseTs(sh.endTimestamp);
              const firstPath = path.join(framesDir, `sc${sc.sceneNumber}_sh${sh.shotNumber}_first.jpg`);
              const lastPath = path.join(framesDir, `sc${sc.sceneNumber}_sh${sh.shotNumber}_last.jpg`);
              try {
                execSync(`"${FFMPEG2}" -ss ${startSec.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${firstPath}" -y`, { stdio: 'pipe', timeout: 10000 });
                execSync(`"${FFMPEG2}" -ss ${endSec.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${lastPath}" -y`, { stdio: 'pipe', timeout: 10000 });
                framesRestored++;
              } catch { /* best effort */ }
            }
          }
        }

        // Rebuild DB
        try { rebuildEpisode(episodeId, scenesPath); } catch { /* best effort */ }

        // Rebuild report
        try {
          const rebuildScript = path.join(__dirname, 'rebuild-report.mjs');
          if (videoFile) {
            execSync(`node "${rebuildScript}" "${episodeId}" "${path.join(mediaDir, videoFile)}"`, {
              env: { ...process.env, VSTACK_NO_OPEN: "1" }, cwd: __dirname, stdio: "pipe", timeout: 30000
            });
          }
        } catch { /* best effort */ }

        // Remove the backup (it's been restored, start fresh)
        fs.unlinkSync(backupPath);

        const totalShots = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          scenes: scenes.length,
          shots: totalShots,
          framesRestored,
          message: `Reverted to original. ${scenes.length} scenes, ${totalShots} shots, ${framesRestored} frames re-extracted.`
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Revert failed: ' + e.message }));
      }
      return true;
    }

    // GET /api/source-json/:episodeId — raw scenes.json content
    const sourceJsonMatch = pathname.match(/^\/api\/source-json\/(.+)$/);
    if (sourceJsonMatch && req.method === 'GET') {
      const epId = decodeURIComponent(sourceJsonMatch[1]);
      const scenesPath = path.join(ANALYSIS_DIR, epId, 'scenes.json');
      if (!fs.existsSync(scenesPath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'scenes.json not found for ' + epId }));
        return true;
      }
      const content = fs.readFileSync(scenesPath, 'utf-8');
      const stat = fs.statSync(scenesPath);
      const backupExists = fs.existsSync(path.join(ANALYSIS_DIR, epId, 'scenes.backup.json'));
      res.writeHead(200);
      res.end(JSON.stringify({
        episodeId: epId,
        json: content,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        backupExists
      }));
      return true;
    }

    // POST /api/save-json/:episodeId — save edited scenes.json
    const saveJsonMatch = pathname.match(/^\/api\/save-json\/(.+)$/);
    if (saveJsonMatch && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const epId = decodeURIComponent(saveJsonMatch[1]);
          const { json } = JSON.parse(body);
          if (!json) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'json field required' }));
            return;
          }

          // Validate JSON
          let scenes;
          try {
            scenes = JSON.parse(json);
          } catch (parseErr) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON: ' + parseErr.message }));
            return;
          }

          if (!Array.isArray(scenes)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'JSON must be an array of scenes' }));
            return;
          }

          // Basic scene validation
          for (let i = 0; i < scenes.length; i++) {
            const s = scenes[i];
            if (!s.sceneNumber || !s.startTimestamp || !s.endTimestamp) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: `Scene ${i + 1} missing required fields (sceneNumber, startTimestamp, endTimestamp)` }));
              return;
            }
          }

          const scenesPath = path.join(ANALYSIS_DIR, epId, 'scenes.json');
          const backupPath = path.join(ANALYSIS_DIR, epId, 'scenes.backup.json');

          // Save backup (first time only)
          if (!fs.existsSync(backupPath) && fs.existsSync(scenesPath)) {
            fs.copyFileSync(scenesPath, backupPath);
          }

          // Load old scenes to diff timestamps
          let oldScenes = [];
          if (fs.existsSync(scenesPath)) {
            try { oldScenes = JSON.parse(fs.readFileSync(scenesPath, 'utf-8')); } catch {}
          }

          // Build old timestamp map: "sceneNum-shotNum" -> "start|end"
          const oldTimestamps = {};
          for (const sc of oldScenes) {
            for (const sh of (sc.shots || [])) {
              oldTimestamps[sc.sceneNumber + '-' + sh.shotNumber] = sh.startTimestamp + '|' + sh.endTimestamp;
            }
          }

          // Write new JSON
          fs.writeFileSync(scenesPath, json);

          const totalShots = scenes.reduce((s, sc) => s + (sc.shots?.length || 0), 0);

          // Rebuild DB
          try {
            execSync(`node "${path.join(__dirname, 'db.mjs')}" --rebuild ${epId}`, {
              env: { ...process.env, VSTACK_NO_OPEN: "1" }, cwd: __dirname, stdio: "pipe", timeout: 30000
            });
          } catch {}

          // Smart frame extraction — only re-extract shots with changed timestamps or missing frames
          const framesDir = path.join(ANALYSIS_DIR, epId, 'frames');
          fs.mkdirSync(framesDir, { recursive: true });

          const mediaDir = process.env.MEDIA_DIR || 'C:\\Star Trek';
          const epMatch = epId.match(/S(\d+)E(\d+)/i);
          let framesExtracted = 0;
          let framesSkipped = 0;

          if (epMatch) {
            const mediaFiles = fs.readdirSync(mediaDir);
            const videoFile = mediaFiles.find(f => new RegExp('s0?' + epMatch[1] + 'e0?' + epMatch[2], 'i').test(f) && f.endsWith('.mp4'));
            if (videoFile) {
              const videoPath = path.join(mediaDir, videoFile);
              const ffmpegDir = path.join(__dirname, 'ffmpeg');
              const ffSubs = fs.readdirSync(ffmpegDir).filter(d => d.startsWith('ffmpeg-'));
              if (ffSubs.length > 0) {
                const FFMPEG = path.join(ffmpegDir, ffSubs[0], 'bin', 'ffmpeg.exe');
                for (const sc of scenes) {
                  for (const sh of (sc.shots || [])) {
                    const first = `sc${sc.sceneNumber}_sh${sh.shotNumber}_first.jpg`;
                    const last = `sc${sc.sceneNumber}_sh${sh.shotNumber}_last.jpg`;
                    sh._frameFirst = first;
                    sh._frameLast = last;

                    // Check if timestamps changed
                    const key = sc.sceneNumber + '-' + sh.shotNumber;
                    const newTs = sh.startTimestamp + '|' + sh.endTimestamp;
                    const firstExists = fs.existsSync(path.join(framesDir, first));
                    const lastExists = fs.existsSync(path.join(framesDir, last));

                    if (oldTimestamps[key] === newTs && firstExists && lastExists) {
                      framesSkipped++;
                      continue; // Timestamps unchanged and frames exist — skip
                    }

                    const ss = parseTs(sh.startTimestamp);
                    const es = parseTs(sh.endTimestamp);
                    try {
                      execSync(`"${FFMPEG}" -ss ${ss.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf scale=320:-1 "${path.join(framesDir, first)}" -y`, { stdio: 'pipe', timeout: 10000 });
                      execSync(`"${FFMPEG}" -ss ${es.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf scale=320:-1 "${path.join(framesDir, last)}" -y`, { stdio: 'pipe', timeout: 10000 });
                      framesExtracted++;
                    } catch {}
                  }
                }
                fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2));
              }
            }
          }

          // Rebuild report
          if (epMatch) {
            const mediaFiles = fs.readdirSync(mediaDir);
            const videoFile = mediaFiles.find(f => new RegExp('s0?' + epMatch[1] + 'e0?' + epMatch[2], 'i').test(f) && f.endsWith('.mp4'));
            if (videoFile) {
              try {
                execSync(`node "${path.join(__dirname, 'rebuild-report.mjs')}" "${epId}" "${path.join(mediaDir, videoFile)}"`, {
                  env: { ...process.env, VSTACK_NO_OPEN: "1" }, cwd: __dirname, stdio: "pipe", timeout: 60000
                });
              } catch {}
            }
          }

          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            scenesCount: scenes.length,
            shotsCount: totalShots,
            framesExtracted,
            framesSkipped,
            message: `Saved ${scenes.length} scenes, ${totalShots} shots. DB rebuilt. ${framesExtracted} frames re-extracted, ${framesSkipped} unchanged. Report rebuilt.`
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // ─── Browse filesystem for video/subtitle files ───
    if (pathname === '/api/browse' && req.method === 'GET') {
      const ALLOWED_EXTS = new Set(['.mp4', '.mkv', '.avi', '.srt', '.sub']);
      const defaultDir = process.env.MEDIA_DIR || 'C:\\Star Trek';
      const dir = url.searchParams.get('dir') || defaultDir;
      try {
        const resolved = path.resolve(dir);
        const raw = fs.readdirSync(resolved, { withFileTypes: true });
        const entries = [];
        for (const ent of raw) {
          if (ent.isDirectory()) {
            entries.push({ name: ent.name, type: 'directory', path: path.join(resolved, ent.name), size: null, ext: null });
          } else if (ent.isFile()) {
            const ext = path.extname(ent.name).toLowerCase();
            if (ALLOWED_EXTS.has(ext)) {
              let size = null;
              try { size = fs.statSync(path.join(resolved, ent.name)).size; } catch {}
              entries.push({ name: ent.name, type: 'file', path: path.join(resolved, ent.name), size, ext });
            }
          }
        }
        entries.sort((a, b) => {
          if (a.type === 'dir' && b.type !== 'dir') return -1;
          if (a.type !== 'dir' && b.type === 'dir') return 1;
          return a.name.localeCompare(b.name);
        });
        const parent = path.dirname(resolved) !== resolved ? path.dirname(resolved) : null;
        res.writeHead(200);
        res.end(JSON.stringify({ path: resolved, parent, entries }));
      } catch (e) {
        const code = e.code === 'ENOENT' ? 404 : e.code === 'EACCES' ? 403 : 500;
        res.writeHead(code);
        res.end(JSON.stringify({ error: e.message }));
      }
      return true;
    }

    // ─── Start analysis for an episode ───
    if (pathname === '/api/start-analysis' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { episodeId, videoPath, srtPath, title, collectionId, region } = JSON.parse(body);
          if (!episodeId || !videoPath) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'episodeId and videoPath required' }));
            return;
          }
          // Validate video file exists
          if (!fs.existsSync(videoPath)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Video file not found: ' + videoPath }));
            return;
          }
          // Check if episodeId already in DB
          const existing = getDb().prepare('SELECT id FROM episodes WHERE id = ?').get(episodeId);
          if (existing) {
            res.writeHead(409);
            res.end(JSON.stringify({ error: 'Episode already exists in database: ' + episodeId }));
            return;
          }
          // Check if already running
          const statusPath = path.join(ANALYSIS_DIR, episodeId, '_analysis-status.json');
          if (fs.existsSync(statusPath)) {
            try {
              const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
              if (st.phase && st.phase !== 'complete' && st.heartbeat) {
                const age = (Date.now() - new Date(st.heartbeat).getTime()) / 1000;
                if (age < 120) {
                  res.writeHead(409);
                  res.end(JSON.stringify({ error: 'Analysis already running for ' + episodeId }));
                  return;
                }
              }
            } catch {}
          }
          // Get duration via ffprobe
          const ffmpegDir = path.join(__dirname, 'ffmpeg');
          const subdirs = fs.readdirSync(ffmpegDir).filter(d => d.startsWith('ffmpeg-'));
          const FFPROBE = path.join(ffmpegDir, subdirs[0], 'bin', 'ffprobe.exe');
          let duration = 0;
          try {
            const out = execSync('"' + FFPROBE + '" -v error -show_entries format=duration -of csv=p=0 "' + videoPath + '"').toString().trim();
            duration = parseFloat(out) || 0;
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'ffprobe failed: ' + e.message }));
            return;
          }
          // Estimate cost
          const chunks = Math.ceil(duration / 300); // 5-min chunks
          const inputCost = chunks * 15 * 24897 * 2 / 1e6;
          const outputCost = chunks * 15 * 250 * 10 / 1e6;
          const estimatedCost = Math.round((inputCost + outputCost) * 100) / 100;
          // Spawn analysis process
          const analyzeScript = path.join(__dirname, 'analyze-episode-v2.mjs');
          const cmd = 'node "' + analyzeScript + '" "' + episodeId + '" "' + videoPath + '"' + (region ? ' --region ' + region : '');
          const child = exec(cmd, {
            cwd: __dirname,
            env: {
              ...process.env,
              VSTACK_NO_OPEN: '1',
              MEDIA_DIR: path.dirname(videoPath),
              PATH: (process.env.PATH || '') + ';' + (process.env.GCLOUD_PATH || 'C:\\Users\\steve\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin'),
              GCLOUD_PATH: process.env.GCLOUD_PATH || 'C:\\Users\\steve\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin'
            }
          });
          child.unref();
          res.writeHead(202);
          res.end(JSON.stringify({
            status: 'started',
            episodeId,
            estimatedCost,
            duration: Math.round(duration),
            pollUrl: '/api/analysis-status/' + episodeId
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // ─── Episode analysis settings ───
    const settingsMatch = pathname.match(/^\/api\/episode-settings\/(.+)$/);
    if (settingsMatch && req.method === 'GET') {
      const epId = decodeURIComponent(settingsMatch[1]);
      const settingsPath = path.join(ANALYSIS_DIR, epId, 'analysis-settings.json');
      if (fs.existsSync(settingsPath)) {
        res.writeHead(200);
        res.end(fs.readFileSync(settingsPath, 'utf-8'));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify(null));
      }
      return true;
    }

    // ─── Active analyses (bulk check) ───
    if (pathname === '/api/active-analyses' && req.method === 'GET') {
      const active = [];
      try {
        const dirs = fs.readdirSync(ANALYSIS_DIR).filter(d => {
          const statusPath = path.join(ANALYSIS_DIR, d, '_analysis-status.json');
          return fs.existsSync(statusPath);
        });
        for (const d of dirs) {
          const statusPath = path.join(ANALYSIS_DIR, d, '_analysis-status.json');
          try {
            const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            if (st.phase && st.phase !== 'idle') {
              if (st.heartbeat) {
                const age = (Date.now() - new Date(st.heartbeat).getTime()) / 1000;
                st.stale = age > 120;
              }
              if (st.startedAt) {
                st.elapsed = Math.round((Date.now() - new Date(st.startedAt).getTime()) / 1000);
              }
              active.push({ episodeId: d, ...st });
            }
          } catch {}
        }
      } catch {}
      res.writeHead(200);
      res.end(JSON.stringify(active));
      return true;
    }

    // ─── Analysis status ───
    const analysisStatusMatch = pathname.match(/^\/api\/analysis-status\/(.+)$/);
    if (analysisStatusMatch && req.method === 'GET') {
      const episodeId = decodeURIComponent(analysisStatusMatch[1]);
      const statusPath = path.join(ANALYSIS_DIR, episodeId, '_analysis-status.json');
      if (!fs.existsSync(statusPath)) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'idle' }));
        return true;
      }
      try {
        const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        if (st.heartbeat) {
          const age = (Date.now() - new Date(st.heartbeat).getTime()) / 1000;
          st.stale = age > 120;
        }
        if (st.startedAt) {
          st.elapsed = Math.round((Date.now() - new Date(st.startedAt).getTime()) / 1000);
        }
        // If cached field is missing, check for _cache-id.txt as fallback
        if (st.cached === undefined) {
          const cacheFile = path.join(ANALYSIS_DIR, episodeId, '_cache-id.txt');
          if (fs.existsSync(cacheFile)) st.cached = true;
        }
        res.writeHead(200);
        res.end(JSON.stringify(st));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return true;
    }

    // ─── Analysis log stream ───
    const logMatch = pathname.match(/^\/api\/analysis-log\/(.+)$/);
    if (logMatch && req.method === 'GET') {
      const episodeId = decodeURIComponent(logMatch[1]);
      const epDir = path.join(ANALYSIS_DIR, episodeId);

      // Find the most recent log file
      let logFile = null;
      if (fs.existsSync(epDir)) {
        const logFiles = fs.readdirSync(epDir)
          .filter(f => f.startsWith('analysis-') && f.endsWith('.log'))
          .sort()
          .reverse();
        if (logFiles.length > 0) logFile = path.join(epDir, logFiles[0]);
      }

      if (!logFile || !fs.existsSync(logFile)) {
        res.writeHead(200);
        res.end(JSON.stringify({ log: 'No log file found. Analysis may not have started yet.', lines: 0 }));
        return true;
      }

      // Support tail parameter — return last N lines (default 200)
      const tail = parseInt(url.searchParams.get('tail') || '200');
      const offset = parseInt(url.searchParams.get('offset') || '0');

      try {
        const content = fs.readFileSync(logFile, 'utf-8');
        const allLines = content.split('\n');
        const totalLines = allLines.length;

        let lines;
        if (offset > 0) {
          // Return lines from offset onwards (for polling new lines)
          lines = allLines.slice(offset);
        } else {
          // Return last N lines
          lines = allLines.slice(-tail);
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          log: lines.join('\n'),
          totalLines,
          returnedFrom: offset > 0 ? offset : Math.max(0, totalLines - tail),
          file: path.basename(logFile),
          size: fs.statSync(logFile).size
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return true;
    }

    // ─── Cost ledger ───
    const costMatch = pathname.match(/^\/api\/cost-ledger\/(.+)$/);
    if (costMatch && req.method === 'GET') {
      const episodeId = decodeURIComponent(costMatch[1]);
      const ledgerFile = path.join(ANALYSIS_DIR, episodeId, 'cost-ledger.json');
      if (!fs.existsSync(ledgerFile)) {
        res.writeHead(200);
        res.end(JSON.stringify({ entries: [], totalCost: 0, totalCalls: 0 }));
        return true;
      }
      try {
        const entries = JSON.parse(fs.readFileSync(ledgerFile, 'utf-8'));
        const totalCost = entries.reduce((s, e) => s + e.cost, 0);
        const totalCached = entries.filter(e => e.cached).length;
        const totalUncached = entries.filter(e => !e.cached).length;
        const totalPromptTokens = entries.reduce((s, e) => s + (e.promptTokens || 0), 0);
        const totalOutputTokens = entries.reduce((s, e) => s + (e.outputTokens || 0), 0);
        res.writeHead(200);
        res.end(JSON.stringify({
          entries,
          totalCost: Math.round(totalCost * 100) / 100,
          totalCalls: entries.length,
          totalCached,
          totalUncached,
          totalPromptTokens,
          totalOutputTokens,
          uncachedCost: entries.filter(e => !e.cached).reduce((s, e) => s + e.cost, 0)
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return true;
    }

    // ─── Global cost summary ───
    if (pathname === '/api/cost-summary') {
      try {
        const dirs = fs.readdirSync(ANALYSIS_DIR).filter(d => {
          const full = path.join(ANALYSIS_DIR, d);
          return fs.statSync(full).isDirectory() && d.match(/^S\d+E\d+/);
        });
        let totalCost = 0;
        let totalCalls = 0;
        let totalCached = 0;
        let totalUncached = 0;
        const perEpisode = [];
        for (const dir of dirs) {
          const ledgerFile = path.join(ANALYSIS_DIR, dir, 'cost-ledger.json');
          if (fs.existsSync(ledgerFile)) {
            const entries = JSON.parse(fs.readFileSync(ledgerFile, 'utf-8'));
            const epCost = entries.reduce((s, e) => s + e.cost, 0);
            totalCost += epCost;
            totalCalls += entries.length;
            totalCached += entries.filter(e => e.cached).length;
            totalUncached += entries.filter(e => !e.cached).length;
            perEpisode.push({ id: dir, cost: Math.round(epCost * 100) / 100, calls: entries.length });
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({
          totalCost: Math.round(totalCost * 100) / 100,
          totalCalls,
          totalCached,
          totalUncached,
          perEpisode
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return true;
    }

    // ─── Pause analysis ───
    const pauseMatch = pathname.match(/^\/api\/pause-analysis\/(.+)$/);
    if (pauseMatch && req.method === 'POST') {
      const episodeId = decodeURIComponent(pauseMatch[1]);
      const statusPath = path.join(ANALYSIS_DIR, episodeId, '_analysis-status.json');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          if (!fs.existsSync(statusPath)) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'No analysis status found for ' + episodeId }));
            return;
          }
          const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
          if (st.pid) {
            try { process.kill(st.pid); } catch {}
          }
          st.phase = 'paused';
          st.pausedAt = new Date().toISOString();
          fs.writeFileSync(statusPath, JSON.stringify(st, null, 2));
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'paused' }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // ─── Resume analysis ───
    const resumeMatch = pathname.match(/^\/api\/resume-analysis\/(.+)$/);
    if (resumeMatch && req.method === 'POST') {
      const episodeId = decodeURIComponent(resumeMatch[1]);
      const statusPath = path.join(ANALYSIS_DIR, episodeId, '_analysis-status.json');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          let videoPath = null;
          if (fs.existsSync(statusPath)) {
            const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            videoPath = st.videoPath || null;
          }
          if (!videoPath) {
            // Try to find video from MEDIA_DIR using episodeId pattern
            const mediaDir = process.env.MEDIA_DIR || 'C:\\Star Trek';
            const pattern = episodeId.replace(/^S(\d+)E(\d+).*$/, '');
            // Scan for common video files
            try {
              const files = fs.readdirSync(mediaDir, { recursive: true });
              // Not a reliable fallback; return error
            } catch {}
            if (!videoPath) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Cannot determine videoPath for ' + episodeId + '. Provide it in the status file.' }));
              return;
            }
          }
          // Update status
          const st = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : {};
          st.phase = 'resuming';
          st.resumedAt = new Date().toISOString();
          fs.writeFileSync(statusPath, JSON.stringify(st, null, 2));
          // Spawn analysis
          const analyzeScript = path.join(__dirname, 'analyze-episode-v2.mjs');
          const cmd = 'node "' + analyzeScript + '" "' + episodeId + '" "' + videoPath + '" --skip-upload';
          const child = exec(cmd, {
            cwd: __dirname,
            env: {
              ...process.env,
              VSTACK_NO_OPEN: '1',
              MEDIA_DIR: path.dirname(videoPath),
              PATH: (process.env.PATH || '') + ';' + (process.env.GCLOUD_PATH || 'C:\\Users\\steve\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin'),
              GCLOUD_PATH: process.env.GCLOUD_PATH || 'C:\\Users\\steve\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin'
            }
          });
          child.unref();
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'resuming' }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // ─── Cancel analysis ───
    const cancelMatch = pathname.match(/^\/api\/cancel-analysis\/(.+)$/);
    if (cancelMatch && req.method === 'POST') {
      const episodeId = decodeURIComponent(cancelMatch[1]);
      const statusPath = path.join(ANALYSIS_DIR, episodeId, '_analysis-status.json');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          // Kill process if running
          if (fs.existsSync(statusPath)) {
            const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            if (st.pid) {
              try { process.kill(st.pid); } catch {}
            }
          }
          let deleteData = false;
          try { deleteData = JSON.parse(body).deleteData; } catch {}
          const epDir = path.join(ANALYSIS_DIR, episodeId);
          if (deleteData && fs.existsSync(epDir)) {
            fs.rmSync(epDir, { recursive: true, force: true });
          } else if (fs.existsSync(statusPath)) {
            fs.unlinkSync(statusPath);
          }
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'cancelled' }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // ── Queue endpoints ──────────────────────────────────────────────

    // GET /api/queue — list queue
    if (pathname === '/api/queue' && req.method === 'GET') {
      const queue = loadQueue();
      res.writeHead(200);
      res.end(JSON.stringify(queue));
      return true;
    }

    // POST /api/queue — add to queue
    if (pathname === '/api/queue' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { episodeId, videoPath, srtPath, title, collectionId, region, skipUpload } = JSON.parse(body);
          if (!episodeId || !videoPath) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'episodeId and videoPath required' }));
            return;
          }

          const queue = loadQueue();

          // Check for duplicates
          const existing = queue.find(q => q.episodeId === episodeId && (q.status === 'queued' || q.status === 'analyzing'));
          if (existing) {
            res.writeHead(409);
            res.end(JSON.stringify({ error: `${episodeId} is already in the queue (${existing.status})` }));
            return;
          }

          queue.push({
            episodeId,
            videoPath,
            srtPath: srtPath || null,
            title: title || null,
            collectionId: collectionId || 'default',
            region: region || 'us-east1',
            skipUpload: skipUpload || false,
            status: 'queued',
            addedAt: new Date().toISOString(),
          });
          saveQueue(queue);

          // Kick off processing
          setTimeout(() => processNextInQueue(), 1000);

          res.writeHead(201);
          res.end(JSON.stringify({ status: 'queued', position: queue.filter(q => q.status === 'queued').length }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return true;
    }

    // DELETE /api/queue/:episodeId — remove from queue
    const queueDeleteMatch = pathname.match(/^\/api\/queue\/(.+)$/);
    if (queueDeleteMatch && req.method === 'DELETE') {
      const epId = decodeURIComponent(queueDeleteMatch[1]);
      const queue = loadQueue();
      const idx = queue.findIndex(q => q.episodeId === epId);

      if (idx === -1) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `${epId} not found in queue` }));
        return true;
      }

      const item = queue[idx];

      // If it's currently analyzing, kill the process
      if (item.status === 'analyzing') {
        const statusFile = path.join(ANALYSIS_DIR, epId, '_analysis-status.json');
        if (fs.existsSync(statusFile)) {
          try {
            const s = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
            if (s.pid) {
              try { process.kill(s.pid); } catch {}
            }
            fs.unlinkSync(statusFile);
          } catch {}
        }
        queueProcessorRunning = false;
      }

      queue.splice(idx, 1);
      saveQueue(queue);

      // If we killed an active one, start next
      if (item.status === 'analyzing') {
        setTimeout(() => processNextInQueue(), 5000);
      }

      res.writeHead(200);
      res.end(JSON.stringify({ deleted: epId }));
      return true;
    }

    // POST /api/queue/clear-completed — remove completed/failed items
    if (pathname === '/api/queue/clear-completed' && req.method === 'POST') {
      const queue = loadQueue().filter(q => q.status === 'queued' || q.status === 'analyzing');
      saveQueue(queue);
      res.writeHead(200);
      res.end(JSON.stringify({ remaining: queue.length }));
      return true;
    }

    // Not a recognized API route
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Unknown API endpoint' }));
    return true;

  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
    return true;
  }
}
