#!/usr/bin/env node
/**
 * Delete ALL Gemini context caches across all regions.
 * Run this if you suspect caches are accumulating storage costs.
 *
 * Usage: node cleanup-caches.mjs
 */

import { execSync } from 'child_process';
import path from 'path';

const GCLOUD_PATH = process.env.GCLOUD_PATH ||
  'C:\\Users\\steve\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin';
const PROJECT = process.env.GCP_PROJECT;
if (!PROJECT) { console.error('❌ GCP_PROJECT env var required'); process.exit(1); }
const REGIONS = ['us-east1', 'us-central1', 'europe-west1', 'asia-northeast1', 'global'];

const ext = process.platform === 'win32' ? '.cmd' : '';
const token = execSync(`"${path.join(GCLOUD_PATH, 'gcloud' + ext)}" auth print-access-token`,
  { encoding: 'utf-8' }).trim();

let totalDeleted = 0;

for (const region of REGIONS) {
  const baseUrl = region === 'global'
    ? `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global`
    : `https://${region}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${region}`;

  try {
    const result = execSync(
      `curl -s "${baseUrl}/cachedContents" -H "Authorization: Bearer ${token}"`,
      { encoding: 'utf-8' }
    );
    const data = JSON.parse(result);
    const items = data.cachedContents || [];

    if (items.length === 0) {
      console.log(`  ${region}: no caches`);
      continue;
    }

    console.log(`  ${region}: ${items.length} caches found — deleting...`);
    for (const cache of items) {
      try {
        execSync(
          `curl -s -X DELETE "${baseUrl}/cachedContents/${cache.name.split('/').pop()}" -H "Authorization: Bearer ${token}"`,
          { encoding: 'utf-8' }
        );
        totalDeleted++;
        console.log(`    ✅ Deleted: ${cache.displayName || cache.name.split('/').pop()}`);
      } catch (e) {
        console.log(`    ❌ Failed: ${cache.name.split('/').pop()}`);
      }
    }
  } catch {
    console.log(`  ${region}: error checking`);
  }
}

console.log(`\n${totalDeleted > 0 ? '🗑️' : '✅'} ${totalDeleted} caches deleted. All clean.`);
