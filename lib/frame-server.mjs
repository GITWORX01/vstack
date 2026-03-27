#!/usr/bin/env node
/**
 * Frame Server -- serves frames from video files on demand.
 *
 * Used by the Scene Review Report for live timestamp adjustment preview.
 *
 * Endpoints:
 *   GET /frame?file=VIDEO_PATH&t=SECONDS   - Extract and return a JPEG frame
 *   GET /health                              - Server health check
 *   GET /                                    - Redirect to latest report
 *   GET /{episodeId}/...                     - Serve static report files
 *
 * Includes an in-memory LRU cache to avoid re-extracting the same frames.
 * Security: Only serves files from directories listed in allowedMediaDirs config.
 *
 * Requires a vstack.config.json in the current working directory.
 */

import http from 'http';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getConfig, getFFmpegPath } from './config.mjs';

// ── Config ───────────────────────────────────────────────────────────

const cfg = getConfig();
const FFMPEG = getFFmpegPath();
const PORT = cfg.frameServerPort;
const MAX_CACHE = cfg.maxCacheFrames;
const ALLOWED_DIRS = cfg.allowedMediaDirs || [];
const PROJECT_DIR = cfg.projectDir;

// Ensure project dir exists
fs.mkdirSync(PROJECT_DIR, { recursive: true });

// ── LRU Cache ────────────────────────────────────────────────────────

/** @type {Map<string, Buffer>} LRU frame cache */
const cache = new Map();

/**
 * Extract a single frame from a video file at the given timestamp.
 * Results are cached in an LRU map.
 *
 * @param {string} videoPath - Absolute path to the video file.
 * @param {number} timestamp - Timestamp in seconds.
 * @returns {Buffer|null} JPEG image buffer, or null on failure.
 */
function extractFrame(videoPath, timestamp) {
  const key = videoPath + '@' + timestamp.toFixed(3);

  if (cache.has(key)) {
    // Move to end (most recently used)
    const val = cache.get(key);
    cache.delete(key);
    cache.set(key, val);
    return val;
  }

  const tmpFile = path.join(PROJECT_DIR, '_tmp_frame_' + Date.now() + '.jpg');
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

/**
 * Check whether a file path is within one of the allowed media directories.
 *
 * @param {string} filePath - The path to validate.
 * @returns {boolean} True if the path is allowed.
 */
function isAllowedPath(filePath) {
  if (ALLOWED_DIRS.length === 0) {
    // No restrictions configured -- allow all paths
    return true;
  }

  const resolved = path.resolve(filePath).toLowerCase();
  return ALLOWED_DIRS.some(dir => {
    const resolvedDir = path.resolve(dir).toLowerCase();
    return resolved.startsWith(resolvedDir);
  });
}

// ── Server ───────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── /frame endpoint ──
  if (url.pathname === '/frame') {
    const file = url.searchParams.get('file');
    const t = parseFloat(url.searchParams.get('t'));

    if (!file || isNaN(t)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing ?file=PATH&t=SECONDS');
      return;
    }

    // Security: validate against allowed directories
    if (!isAllowedPath(file)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: file path not in allowedMediaDirs');
      return;
    }

    const frame = extractFrame(file, t);
    if (frame) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=60',
      });
      res.end(frame);
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Frame extraction failed');
    }
    return;
  }

  // ── /health endpoint ──
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', cacheSize: cache.size }));
    return;
  }

  // ── Serve report files from project directory ──
  const requestedPath = path.join(PROJECT_DIR, decodeURIComponent(url.pathname));
  const resolved = path.resolve(requestedPath);

  // Security: only serve files under the project directory
  if (
    resolved.startsWith(path.resolve(PROJECT_DIR)) &&
    fs.existsSync(resolved) &&
    fs.statSync(resolved).isFile()
  ) {
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    });
    res.end(fs.readFileSync(resolved));
    return;
  }

  // ── Root: redirect to latest report ──
  if (url.pathname === '/') {
    try {
      const episodes = fs
        .readdirSync(PROJECT_DIR)
        .filter(d =>
          fs.existsSync(path.join(PROJECT_DIR, d, 'scene-review-report.html'))
        );
      if (episodes.length > 0) {
        res.writeHead(302, {
          Location: '/' + episodes[episodes.length - 1] + '/scene-review-report.html',
        });
        res.end();
        return;
      }
    } catch { /* project dir may not exist yet */ }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Frame Server running on http://localhost:${PORT}`);
  console.log(`  GET /frame?file=PATH&t=SECONDS`);
  console.log(`  Cache: ${MAX_CACHE} frames max`);
  if (ALLOWED_DIRS.length > 0) {
    console.log(`  Allowed dirs: ${ALLOWED_DIRS.join(', ')}`);
  } else {
    console.log(`  Warning: no allowedMediaDirs configured -- all paths allowed`);
  }
});
