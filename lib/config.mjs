#!/usr/bin/env node
/**
 * Shared configuration loader for the vstack video analysis pipeline.
 *
 * Reads `vstack.config.json` from the current working directory and provides
 * validated, defaulted access to all pipeline settings.
 *
 * Expected config file format (vstack.config.json):
 * {
 *   "projectDir": "./analysis",          // Where analysis output goes (required)
 *   "ffmpegPath": "C:/tools/ffmpeg.exe",  // Path to ffmpeg binary (required)
 *   "ffprobePath": "C:/tools/ffprobe.exe",// Path to ffprobe binary (optional, derived from ffmpegPath)
 *   "gcsBucket": "gs://my-bucket",        // GCS bucket URI (required for upload/analysis)
 *   "gcpProject": "my-project-id",        // GCP project ID (required for Gemini API)
 *   "gcpRegion": "us-central1",           // GCP region (default: us-central1)
 *   "gcloudPath": "",                     // Path to gcloud SDK bin dir (optional)
 *   "allowedMediaDirs": ["C:/Videos"],    // Directories allowed for frame serving (security)
 *   "model": "gemini-2.5-pro",            // Gemini model name
 *   "chunkMinutes": 15,                   // Analysis chunk size in minutes
 *   "mediaResolution": "MEDIA_RESOLUTION_LOW",
 *   "maxOutputTokens": 32768,
 *   "temperature": 0.1,
 *   "maxRetries": 3,
 *   "sceneDetectThreshold": 0.3,
 *   "snapMaxDistance": 2.0,
 *   "chunkCooldownMs": 10000,
 *   "frameServerPort": 3333,
 *   "maxCacheFrames": 200
 * }
 */

import fs from 'fs';
import path from 'path';

/** @type {object|null} Cached config singleton */
let _config = null;

/** Default values for optional config fields */
const DEFAULTS = {
  gcpRegion: 'us-central1',
  gcloudPath: '',
  model: 'gemini-2.5-pro',
  chunkMinutes: 15,
  mediaResolution: 'MEDIA_RESOLUTION_LOW',
  maxOutputTokens: 32768,
  temperature: 0.1,
  maxRetries: 3,
  sceneDetectThreshold: 0.3,
  snapMaxDistance: 2.0,
  chunkCooldownMs: 10000,
  frameServerPort: 3333,
  maxCacheFrames: 200,
  allowedMediaDirs: [],
};

/**
 * Load and validate the vstack config from the current working directory.
 * Results are cached after the first call.
 *
 * @param {string} [configPath] - Override path to config file. Defaults to `cwd/vstack.config.json`.
 * @returns {object} The validated configuration object with defaults applied.
 * @throws {Error} If the config file is missing or required fields are absent.
 */
export function getConfig(configPath) {
  if (_config) return _config;

  const cfgFile = configPath || path.join(process.cwd(), 'vstack.config.json');

  if (!fs.existsSync(cfgFile)) {
    throw new Error(
      `Config file not found: ${cfgFile}\n` +
      `Create a vstack.config.json in your project directory.\n` +
      `See lib/config.mjs for the expected format.`
    );
  }

  const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));

  // Validate required fields
  const required = ['projectDir', 'ffmpegPath'];
  for (const field of required) {
    if (!raw[field]) {
      throw new Error(`Missing required config field: "${field}" in ${cfgFile}`);
    }
  }

  // Build config with defaults
  _config = { ...DEFAULTS, ...raw };

  // Derive ffprobe path from ffmpeg path if not specified
  if (!_config.ffprobePath) {
    const dir = path.dirname(_config.ffmpegPath);
    const ext = path.extname(_config.ffmpegPath);
    _config.ffprobePath = path.join(dir, `ffprobe${ext}`);
  }

  // Resolve projectDir relative to config file location
  if (!path.isAbsolute(_config.projectDir)) {
    _config.projectDir = path.resolve(path.dirname(cfgFile), _config.projectDir);
  }

  return _config;
}

/**
 * Get the path to the ffmpeg binary.
 * @returns {string} Absolute path to ffmpeg.
 */
export function getFFmpegPath() {
  return getConfig().ffmpegPath;
}

/**
 * Get the path to the ffprobe binary.
 * @returns {string} Absolute path to ffprobe.
 */
export function getFFprobePath() {
  return getConfig().ffprobePath;
}

/**
 * Get the GCS bucket URI (e.g. "gs://my-bucket").
 * @returns {string} GCS bucket URI.
 * @throws {Error} If gcsBucket is not configured.
 */
export function getGCSBucket() {
  const cfg = getConfig();
  if (!cfg.gcsBucket) {
    throw new Error('gcsBucket is not configured in vstack.config.json');
  }
  return cfg.gcsBucket;
}

/**
 * Get the project analysis output directory.
 * @returns {string} Absolute path to the project directory.
 */
export function getProjectDir() {
  return getConfig().projectDir;
}

/**
 * Reset the cached config. Useful for testing or reloading.
 */
export function resetConfig() {
  _config = null;
}
