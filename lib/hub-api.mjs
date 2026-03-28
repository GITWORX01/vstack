/**
 * Hub API — JSON endpoints for the vstack media library dashboard.
 * Imported by frame-server.mjs to handle /api/* routes.
 */

import { getDb, getStats, getSeriesList, getEpisodes, getEpisodeDetail,
         getEpisodeThumbnail, createSeries, assignEpisodeToSeries,
         search, searchDialogue, semanticSearch, rebuildEpisode, closeDb } from './db.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS_DIR = path.join(__dirname, 'gemini-analysis');

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
          cwd: __dirname, stdio: 'pipe', timeout: 60000
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
              cwd: __dirname, stdio: 'pipe', timeout: 30000
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
