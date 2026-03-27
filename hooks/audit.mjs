/**
 * vstack Audit Logger
 *
 * Logs all pipeline operations to .vstack/audit.log for debugging and accountability.
 */

import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.vstack', 'audit.log');

export function logAction(action, details = {}) {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    action,
    ...details,
  });
  fs.appendFileSync(LOG_FILE, entry + '\n');
}

export function getLogPath() {
  return LOG_FILE;
}
