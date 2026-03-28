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
import { execSync } from 'child_process';

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

        // Copy frame directories
        for (const ep of episodes) {
          const framesDir = path.join(ANALYSIS_DIR, ep.id, 'frames');
          if (fs.existsSync(framesDir)) {
            const destDir = path.join(tmpDir, ep.id, 'frames');
            fs.mkdirSync(destDir, { recursive: true });
            const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
            for (const f of files) {
              fs.copyFileSync(path.join(framesDir, f), path.join(destDir, f));
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
