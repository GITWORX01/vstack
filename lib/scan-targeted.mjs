// ═══════════════════════════════════════════════════════════════════════════
//  Picard Smile Scanner — Targeted AI vision scan on extracted clips
// ═══════════════════════════════════════════════════════════════════════════
// Scans the pre-extracted 2-minute clips at 1fps using Sonnet vision,
// specifically looking for frames where Picard is smiling, laughing, or
// showing warmth. Much cheaper than scanning full episodes.
//
// Usage:
//   node tng-data/scan-smiles.mjs
//   node tng-data/scan-smiles.mjs --dry-run    # just count frames, no API calls
//
// Output: tng-data/smile-frames.json
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
const envFiles = [
  path.join(__dirname, '..', 'extracted', '.env'),
  path.join(__dirname, '..', '.env'),
];
for (const envFile of envFiles) {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1].trim()]) {
        process.env[match[1].trim()] = match[2].trim();
      }
    }
  }
}

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY && !process.argv.includes('--dry-run')) {
  console.error('Set ANTHROPIC_API_KEY in .env or environment');
  process.exit(1);
}

// ── Config ──────────────────────────────────────────────────────────────
const CLIPS_DIR = path.join(__dirname, 'smile-clips');
const MANIFEST_PATH = path.join(CLIPS_DIR, 'clip-manifest.json');
const OUTPUT_PATH = path.join(__dirname, 'smile-frames.json');
const FRAME_WIDTH = 512;
const JPEG_QUALITY = 8;
const BATCH_SIZE = 20;   // frames per API call
const MODEL = 'claude-sonnet-4-6';
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;
const CONCURRENCY = 3;
const DRY_RUN = process.argv.includes('--dry-run');

// Find ffmpeg
const FFMPEG_DIR = path.join(__dirname, 'ffmpeg');
let FFMPEG = '';
if (fs.existsSync(FFMPEG_DIR)) {
  const subdirs = fs.readdirSync(FFMPEG_DIR).filter(d =>
    d.startsWith('ffmpeg-') && fs.statSync(path.join(FFMPEG_DIR, d)).isDirectory()
  );
  if (subdirs.length > 0) FFMPEG = path.join(FFMPEG_DIR, subdirs[0], 'bin', 'ffmpeg.exe');
}
if (!FFMPEG || !fs.existsSync(FFMPEG)) {
  console.error('ffmpeg not found in tng-data/ffmpeg/');
  process.exit(1);
}

// ── Load manifest ───────────────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
console.log(`📋 ${manifest.length} clips to scan`);

// ── Frame extraction ────────────────────────────────────────────────────
function extractFrame(videoPath, timeSec) {
  const tmpFile = path.join(__dirname, `_tmp_frame_${Date.now()}.jpg`);
  try {
    execSync(
      `"${FFMPEG}" -ss ${timeSec} -i "${videoPath}" -vframes 1 -q:v ${JPEG_QUALITY} -vf "scale=${FRAME_WIDTH}:-1" "${tmpFile}" -y`,
      { stdio: 'pipe' }
    );
    const buf = fs.readFileSync(tmpFile);
    return buf.toString('base64');
  } catch {
    return null;
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

function getVideoDuration(videoPath) {
  const ffprobe = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe');
  try {
    const out = execSync(
      `"${ffprobe}" -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
      { stdio: 'pipe', encoding: 'utf-8' }
    );
    return parseFloat(out.trim());
  } catch {
    return 120; // default 2 min
  }
}

// ── API call ────────────────────────────────────────────────────────────
async function analyzeFrameBatch(frames, clipInfo) {
  const imageBlocks = frames.map((f, i) => ([
    {
      type: 'text',
      text: `Frame ${i + 1} (clip time: ${f.clipTime.toFixed(1)}s, episode time: ${f.episodeTime.toFixed(1)}s):`
    },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: f.base64 }
    }
  ])).flat();

  const systemPrompt = `You are analyzing frames from Star Trek: The Next Generation to find Captain Jean-Luc Picard smiling, laughing, grinning, or showing warmth/amusement.

For EACH frame, respond with a JSON object on its own line:
{"frame": N, "picard_visible": true/false, "smiling": true/false, "smile_type": "warm|amused|laugh|grin|subtle|none", "confidence": "high|medium|low", "description": "brief scene description"}

Focus ONLY on Picard (bald man, often in Starfleet uniform or civilian clothes). Ignore other characters smiling.

Smile types:
- "warm" = genuine warm smile (eyes engaged)
- "amused" = suppressing a smile or showing amusement
- "laugh" = actively laughing
- "grin" = broad open grin
- "subtle" = slight upturn of lips, hint of smile
- "none" = not smiling

Only mark "smiling": true if Picard is CLEARLY showing positive emotion. Be strict — we want quality over quantity.`;

  const body = {
    model: MODEL,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `Analyze these ${frames.length} frames from ${clipInfo.episode} for Picard smiling:` },
        ...imageBlocks,
      ]
    }]
  };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status === 529) {
        const wait = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`  ⏳ Rate limited, waiting ${(wait/1000).toFixed(0)}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data.content?.[0]?.text || '';

      // Parse JSON lines from response
      const results = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          try {
            results.push(JSON.parse(trimmed));
          } catch { /* skip malformed lines */ }
        }
      }

      return {
        results,
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      };
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      console.log(`  ⚠️ Attempt ${attempt + 1} failed: ${err.message.slice(0, 100)}`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
    }
  }
}

// ── Concurrency limiter ─────────────────────────────────────────────────
function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];

  return async function limit(fn) {
    while (active >= maxConcurrent) {
      await new Promise(resolve => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length > 0) queue.shift()();
    }
  };
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const allSmileFrames = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalApiCalls = 0;

  // Load existing progress
  if (fs.existsSync(OUTPUT_PATH)) {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    allSmileFrames.push(...(existing.frames || []));
    console.log(`📂 Resuming: ${allSmileFrames.length} smile frames already found`);
  }

  const processedClips = new Set(allSmileFrames.map(f => f.clipFile));
  const limit = createLimiter(CONCURRENCY);

  for (const clip of manifest) {
    if (processedClips.has(clip.clip)) {
      console.log(`⏭️  Skipping ${clip.clip} (already scanned)`);
      continue;
    }

    const clipPath = path.join(CLIPS_DIR, clip.clip);
    if (!fs.existsSync(clipPath)) {
      console.log(`⚠️  Missing: ${clip.clip}`);
      continue;
    }

    const duration = getVideoDuration(clipPath);
    const frameCount = Math.floor(duration);
    console.log(`\n🎬 ${clip.clip} (${frameCount} frames, ${clip.smileCount} expected smiles)`);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would extract ${frameCount} frames in ${Math.ceil(frameCount / BATCH_SIZE)} batches`);
      continue;
    }

    // Extract all frames
    const frames = [];
    for (let t = 0; t < duration; t += 1) {
      const base64 = extractFrame(clipPath, t);
      if (base64) {
        frames.push({
          clipTime: t,
          episodeTime: clip.startSec + t,
          base64,
        });
      }
    }
    console.log(`  📸 Extracted ${frames.length} frames`);

    // Process in batches
    const batches = [];
    for (let i = 0; i < frames.length; i += BATCH_SIZE) {
      batches.push(frames.slice(i, i + BATCH_SIZE));
    }

    const clipSmiles = [];
    const batchPromises = batches.map((batch, batchIdx) =>
      limit(async () => {
        try {
          const { results, inputTokens, outputTokens } = await analyzeFrameBatch(batch, clip);
          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;
          totalApiCalls++;

          const smiles = results.filter(r => r.smiling === true);
          for (const smile of smiles) {
            const frameIdx = (smile.frame || 1) - 1;
            const frame = batch[frameIdx];
            if (frame) {
              clipSmiles.push({
                clipFile: clip.clip,
                episode: clip.episode,
                episodeTime: frame.episodeTime,
                clipTime: frame.clipTime,
                smileType: smile.smile_type,
                confidence: smile.confidence,
                description: smile.description,
              });
            }
          }

          process.stdout.write(`  ✅ Batch ${batchIdx + 1}/${batches.length}: ${smiles.length} smiles found\n`);
        } catch (err) {
          console.log(`  ❌ Batch ${batchIdx + 1} failed: ${err.message.slice(0, 100)}`);
        }
      })
    );

    await Promise.all(batchPromises);
    allSmileFrames.push(...clipSmiles);
    console.log(`  🎯 ${clipSmiles.length} Picard smiles found in this clip`);

    // Save progress after each clip
    const output = {
      scanDate: new Date().toISOString(),
      totalFramesScanned: allSmileFrames.length,
      totalApiCalls,
      estimatedCost: `~$${((totalInputTokens * 3 + totalOutputTokens * 15) / 1_000_000).toFixed(2)}`,
      frames: allSmileFrames,
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  }

  // Final summary
  console.log('\n═══════════════════════════════════════════');
  console.log(`✅ Scan complete!`);
  console.log(`📊 ${allSmileFrames.length} Picard smile frames found`);
  console.log(`💰 API calls: ${totalApiCalls}`);
  console.log(`💰 Estimated cost: ~$${((totalInputTokens * 3 + totalOutputTokens * 15) / 1_000_000).toFixed(2)}`);
  console.log(`📁 Results saved to ${OUTPUT_PATH}`);

  // Show breakdown by smile type
  const byType = {};
  for (const f of allSmileFrames) {
    byType[f.smileType] = (byType[f.smileType] || 0) + 1;
  }
  console.log('\nSmile types:');
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // Show top episodes
  const byEp = {};
  for (const f of allSmileFrames) {
    byEp[f.episode] = (byEp[f.episode] || 0) + 1;
  }
  console.log('\nBy episode:');
  for (const [ep, count] of Object.entries(byEp).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ep}: ${count} smiles`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
