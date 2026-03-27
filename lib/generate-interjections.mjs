/**
 * Generate a big library of narrator interjections for the 5-minute supercut.
 * Each one is a short, punchy comment about Picard smiling.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', 'extracted');
const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) { console.error('Set ELEVENLABS_API_KEY in .env or environment'); process.exit(1); }
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'BTEPH6wbWkb66Dys0ry6';

const INTERJECTION_DIR = path.join(ROOT, 'public', 'audio', 'interjections');
fs.mkdirSync(INTERJECTION_DIR, { recursive: true });

const FFMPEG_DIR = path.join(__dirname, 'ffmpeg');
let FFPROBE = '';
const subdirs = fs.readdirSync(FFMPEG_DIR).filter(d => d.startsWith('ffmpeg-') && fs.statSync(path.join(FFMPEG_DIR, d)).isDirectory());
if (subdirs.length > 0) FFPROBE = path.join(FFMPEG_DIR, subdirs[0], 'bin', 'ffprobe.exe');

import { execSync } from 'child_process';

const COMMENTS = [
  // Noticing smiles
  "Hey, nice smile!",
  "Oooh, do I see a smile?",
  "There it is!",
  "Oh yeah, that's a good one.",
  "Look at that smile.",
  "He's smiling!",
  "Captain's smiling!",
  "Is that a grin?",
  "Oh, he's definitely smiling.",
  "That's the one.",

  // Encouragement
  "Keep smiling!",
  "Smile away!",
  "Smile time!",
  "Don't stop now!",
  "There you go!",
  "That's what we like to see!",
  "More of that, please!",
  "Yes! That's it!",

  // Commentary
  "A rare sight indeed.",
  "You don't see that every day.",
  "Now that's a captain's smile.",
  "The man can smile!",
  "Who knew?",
  "See? He's human after all.",
  "Even captains smile sometimes.",
  "Classic Picard.",
  "Beautiful.",
  "Wonderful.",
  "Magnifique!",
  "Make it so... smile.",

  // Reactions
  "Oh!",
  "Ha!",
  "There we go!",
  "Ooh!",
  "Nice!",
];

async function tts(text, outputPath) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.6, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
        speed: 1.0,
      }),
    }
  );
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
  fs.writeFileSync(outputPath, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  console.log(`🗣️ Generating ${COMMENTS.length} interjections...\n`);

  const manifest = [];

  for (let i = 0; i < COMMENTS.length; i++) {
    const fname = `interjection-${i}.mp3`;
    const fpath = path.join(INTERJECTION_DIR, fname);

    try {
      await tts(COMMENTS[i], fpath);
      const dur = parseFloat(execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${fpath}"`, { encoding: 'utf-8' }).trim());
      manifest.push({ index: i, text: COMMENTS[i], file: `audio/interjections/${fname}`, duration: dur });
      console.log(`  ✅ ${i}: "${COMMENTS[i]}" (${dur.toFixed(1)}s)`);
    } catch (err) {
      console.log(`  ❌ ${i}: "${COMMENTS[i]}" — ${err.message}`);
    }

    // Small delay to avoid rate limiting
    if (i % 5 === 4) await new Promise(r => setTimeout(r, 1000));
  }

  fs.writeFileSync(path.join(INTERJECTION_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n✅ Generated ${manifest.length} interjections`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
