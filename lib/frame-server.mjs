/**
 * Frame Server + Hub API
 *
 * Serves the vstack media library hub, Scene Review Reports, video frames,
 * and API endpoints for the dashboard.
 *
 * GET /                    → Hub dashboard
 * GET /api/*               → JSON API endpoints (stats, series, episodes, search)
 * GET /frame?file=...&t=N  → JPEG frame at timestamp
 * GET /video?file=...      → MP4 streaming with Range support
 * GET /{episode}/report    → Scene Review Report
 */

import http from 'http';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { handleApiRequest } from './hub-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env file ──────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  console.log('📋 Loaded .env:', Object.keys(process.env).filter(k => ['GCP_PROJECT', 'GCS_BUCKET', 'MEDIA_DIR', 'GCLOUD_PATH', 'ELEVENLABS_API_KEY'].includes(k)).map(k => k + '=' + (k.includes('KEY') ? '***' : process.env[k])).join(', '));
}
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Hub page ──────────────────────────────────────────────────────
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const hubPath = path.join(__dirname, 'hub.html');
    if (fs.existsSync(hubPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(hubPath));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="background:#0a0a1a;color:#eee;font-family:sans-serif;padding:40px"><h1>vstack</h1><p>Hub page not found. Run the hub builder to generate hub.html.</p></body></html>');
    }
    return;
  }

  // ── API endpoints ─────────────────────────────────────────────────
  if (handleApiRequest(url, req, res)) return;

  if (url.pathname === '/frame') {
    const file = url.searchParams.get('file');
    const t = parseFloat(url.searchParams.get('t'));

    if (!file || isNaN(t)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing ?file=PATH&t=SECONDS');
      return;
    }

    // Security: only allow video files (mp4/mkv/avi)
    const ext = path.extname(file).toLowerCase();
    if (!['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(ext)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: only video files allowed');
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

  // ── Video streaming with Range support (for <video> seeking) ────────
  if (url.pathname === '/video') {
    const file = url.searchParams.get('file');
    if (!file) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing ?file=PATH');
      return;
    }

    // Security: only allow video files
    const vidExt = path.extname(file).toLowerCase();
    if (!['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(vidExt)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: only video files allowed');
      return;
    }

    const normalizedFile = file.replace(/\//g, '\\');
    if (!fs.existsSync(normalizedFile)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }

    const stat = fs.statSync(normalizedFile);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 5 * 1024 * 1024, fileSize - 1); // 5MB chunks
      const chunkSize = end - start + 1;

      const stream = fs.createReadStream(normalizedFile, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(normalizedFile).pipe(res);
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

  // Root already handled above (hub.html)

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`🎬 vstack server running on http://localhost:${PORT}`);
  console.log(`   Hub:    http://localhost:${PORT}/`);
  console.log(`   API:    http://localhost:${PORT}/api/stats`);
  console.log(`   Frames: http://localhost:${PORT}/frame?file=...&t=N`);
  console.log(`   Cache:  ${MAX_CACHE} frames max`);
});
