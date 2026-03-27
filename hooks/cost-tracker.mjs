/**
 * vstack Cost Tracker
 *
 * Tracks estimated API costs across pipeline operations.
 * Logs to .vstack/costs.jsonl for session-level tracking.
 */

import fs from 'fs';
import path from 'path';

const COST_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.vstack', 'costs.jsonl');

const COST_ESTIMATES = {
  'analyze-chunk': { input: 2.00, output: 10.00, unit: 'per 1M tokens' },
  'narrate': { flat: 1.00, unit: 'per script' },
  'assign': { flat: 4.00, unit: 'per project' },
  'verify': { flat: 1.50, unit: 'per run' },
  'scan': { flat: 0.03, unit: 'per clip' },
};

export function logCost(operation, details = {}) {
  const dir = path.dirname(COST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const entry = {
    timestamp: new Date().toISOString(),
    operation,
    ...details,
  };
  fs.appendFileSync(COST_FILE, JSON.stringify(entry) + '\n');
}

export function getSessionCosts() {
  if (!fs.existsSync(COST_FILE)) return { entries: [], total: 0 };
  const lines = fs.readFileSync(COST_FILE, 'utf-8').split('\n').filter(Boolean);
  const entries = lines.map(l => JSON.parse(l));
  const total = entries.reduce((sum, e) => sum + (e.cost || 0), 0);
  return { entries, total };
}

export function getEstimate(operation) {
  return COST_ESTIMATES[operation] || null;
}
