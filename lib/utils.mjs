/**
 * Shared utilities for the vstack video analysis pipeline.
 *
 * Common functions used across analyze, integrate, frame-server, and report scripts.
 */

import fs from 'fs';
import { execSync, spawn } from 'child_process';
import path from 'path';
import { getConfig } from './config.mjs';

/**
 * Parse a MM:SS.s timestamp string into total seconds.
 *
 * @param {string} ts - Timestamp in "MM:SS.s" format (e.g. "03:21.5").
 * @returns {number} Total seconds. Returns 0 for invalid input.
 *
 * @example
 * parseTs("02:30.0") // => 150
 * parseTs("00:05.5") // => 5.5
 */
export function parseTs(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const [minStr, secStr] = ts.split(':');
  if (!secStr) return 0;
  return parseInt(minStr, 10) * 60 + parseFloat(secStr);
}

/**
 * Format a number of seconds into MM:SS.s timestamp string.
 *
 * @param {number} sec - Total seconds.
 * @returns {string} Formatted timestamp (e.g. "03:21.5").
 *
 * @example
 * fmtTs(150)  // => "02:30.0"
 * fmtTs(5.5)  // => "00:05.5"
 */
export function fmtTs(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

/**
 * Format seconds into MM:SS.sss (millisecond precision) timestamp string.
 *
 * @param {number} sec - Total seconds.
 * @returns {string} Formatted timestamp (e.g. "03:21.500").
 */
export function fmtTsMs(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0');
}

/**
 * Parse an SRT subtitle file into an array of timed entries.
 *
 * Handles:
 * - Standard SRT format with HH:MM:SS,mmm timestamps
 * - HTML tags and SSA/ASS style overrides in text
 * - Windows and Unix line endings
 *
 * @param {string} filePath - Absolute path to the .srt file.
 * @returns {Array<{start: number, end: number, text: string}>} Parsed subtitle entries.
 *
 * @example
 * const subs = parseSRT("/path/to/subtitle.srt");
 * // => [{ start: 10.5, end: 13.2, text: "Hello there." }, ...]
 */
export function parseSRT(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const entries = [];
  const blocks = content.replace(/\r\n/g, '\n').split('\n\n').filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    const tm = lines[1].match(
      /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/
    );
    if (!tm) continue;

    const start =
      parseInt(tm[1]) * 3600 +
      parseInt(tm[2]) * 60 +
      parseInt(tm[3]) +
      parseInt(tm[4]) / 1000;
    const end =
      parseInt(tm[5]) * 3600 +
      parseInt(tm[6]) * 60 +
      parseInt(tm[7]) +
      parseInt(tm[8]) / 1000;

    const text = lines
      .slice(2)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .trim();

    if (text) entries.push({ start, end, text });
  }

  return entries;
}

/**
 * Promise-based sleep.
 *
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Get a Google Cloud access token via gcloud CLI.
 *
 * Uses the `gcloudPath` from config if set, otherwise assumes `gcloud` is on PATH.
 *
 * @returns {string} OAuth2 access token.
 * @throws {Error} If gcloud is not available or authentication fails.
 */
export function getAccessToken() {
  const cfg = getConfig();
  const gcloudBin = cfg.gcloudPath
    ? path.join(cfg.gcloudPath, 'gcloud')
    : 'gcloud';

  return execSync(`"${gcloudBin}" auth print-access-token`, {
    encoding: 'utf-8',
  }).trim();
}

/**
 * Run a command as a child process and return a promise with its output.
 *
 * @param {string} cmd - The command to run.
 * @param {string[]} args - Command arguments.
 * @param {string} [cwd] - Working directory. Defaults to process.cwd().
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 *
 * @example
 * const result = await runCommand('ffmpeg', ['-version']);
 * console.log(result.stdout);
 */
export function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', reject);
    proc.on('close', code => {
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Get the duration of a video file in seconds using ffprobe.
 *
 * @param {string} videoPath - Absolute path to the video file.
 * @param {string} [ffprobePath] - Override ffprobe path (defaults to config).
 * @returns {number} Duration in seconds.
 */
export function getVideoDuration(videoPath, ffprobePath) {
  const probe = ffprobePath || getConfig().ffprobePath;
  return parseFloat(
    execSync(
      `"${probe}" -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
      { encoding: 'utf-8' }
    ).trim()
  );
}

/**
 * Filter SRT entries that overlap a given time range and format them for a prompt.
 *
 * @param {Array<{start: number, end: number, text: string}>} srtEntries - Parsed SRT entries.
 * @param {number} startSec - Range start in seconds.
 * @param {number} endSec - Range end in seconds.
 * @returns {string} Formatted subtitle block for inclusion in a prompt, or empty string.
 */
export function getSrtForRange(srtEntries, startSec, endSec) {
  if (!srtEntries?.length) return '';
  const relevant = srtEntries.filter(s => s.start < endSec && s.end > startSec);
  if (!relevant.length) return '';
  return (
    '\n\nSUBTITLE DATA for this time range (use exact text, attribute each line to the speaking character):\n' +
    relevant.map(s => `[${fmtTs(s.start)} -> ${fmtTs(s.end)}] "${s.text}"`).join('\n')
  );
}
