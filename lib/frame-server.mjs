/**
 * Frame Server — serves frames from episode files on demand.
 * Used by the Scene Review Report for live timestamp adjustment preview.
 *
 * GET /frame?file=EPISODE_FILE&t=SECONDS
 * Returns a JPEG frame extracted at the given timestamp.
 *
 * Includes an in-memory LRU cache to avoid re-extracting the same frames.
 */

import http from 'http';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3333;

const ffmpegDir = path.join(__dirname, 'ffmpeg');
const subdirs = fs.readdirSync(ffmpegDir).filter(d => d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory());
const FFMPEG = path.join(ffmpegDir, subdirs[0], 'bin', 'ffmpeg.exe');

// LRU cache (max 200 frames)
const cache = new Map();
const MAX_CACHE = 200;

function extractFrame(videoPath, timestamp) {
  const key = videoPath + '@' + timestamp.toFixed(3);
  if (cache.has(key)) {
    // Move to end (most recently used)
    const val = cache.get(key);
    cache.delete(key);
    cache.set(key, val);
    return val;
  }

  const tmpFile = path.join(__dirname, '_tmp_frame_' + Date.now() + '.jpg');
  try {
    execSync(
      `"${FFMPEG}" -ss ${timestamp.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${tmpFile}" -y`,
      { stdio: 'pipe', timeout: 10000 }
    );
    const buffer = fs.readFileSync(tmpFile);
    fs.unlinkSync(tmpFile);

    // Add to cache, evict oldest if needed
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(key, buffer);

    return buffer;
  } catch (e) {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    return null;
  }
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/frame') {
    const file = url.searchParams.get('file');
    const t = parseFloat(url.searchParams.get('t'));

    if (!file || isNaN(t)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing ?file=PATH&t=SECONDS');
      return;
    }

    // Security: only allow files from C:\Star Trek
    if (!file.startsWith('C:\\Star Trek\\') && !file.startsWith('C:/Star Trek/')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: only Star Trek files allowed');
      return;
    }

    const frame = extractFrame(file, t);
    if (frame) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=60' });
      res.end(frame);
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Frame extraction failed');
    }
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', cacheSize: cache.size }));
    return;
  }

  // Serve report files from gemini-analysis directory
  const analysisDir = path.join(__dirname, 'gemini-analysis');
  const requestedPath = path.join(analysisDir, decodeURIComponent(url.pathname));
  const resolved = path.resolve(requestedPath);

  // Security: only serve files under gemini-analysis/
  if (resolved.startsWith(path.resolve(analysisDir)) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    const ext = path.extname(resolved).toLowerCase();
    const mimeTypes = { '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css', '.js': 'application/javascript' };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(resolved));
    return;
  }

  // Root: redirect to latest report
  if (url.pathname === '/') {
    const episodes = fs.readdirSync(analysisDir).filter(d => fs.existsSync(path.join(analysisDir, d, 'scene-review-report.html')));
    if (episodes.length > 0) {
      res.writeHead(302, { Location: '/' + episodes[episodes.length - 1] + '/scene-review-report.html' });
      res.end();
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`🖼️ Frame Server running on http://localhost:${PORT}`);
  console.log(`   GET /frame?file=C:\\Star Trek\\...&t=21.396`);
  console.log(`   Cache: ${MAX_CACHE} frames max`);
});
