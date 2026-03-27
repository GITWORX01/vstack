/**
 * Generate narration audio via ElevenLabs TTS + music via ElevenLabs
 * Outputs per-sentence audio files and a music track.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', 'extracted');

const API_KEY = 'sk_70e6844ef461bf8177c5dde2c355ecb58b5116a8780b7ddf';
const VOICE_ID = 'BTEPH6wbWkb66Dys0ry6';

// Find ffmpeg
const ffmpegDir = path.join(__dirname, 'ffmpeg');
let FFMPEG = '';
const subdirs = fs.readdirSync(ffmpegDir).filter(d =>
  d.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, d)).isDirectory()
);
if (subdirs.length > 0) FFMPEG = path.join(ffmpegDir, subdirs[0], 'bin', 'ffmpeg.exe');

// Scene index → narration text (null = silent, use show audio)
// Scenes: 0=Lessons opener, 1=Flute, 2=Tapestry, 3=Allegiance, 4=AGT,
//   5-12=montage clips, 13=Family finale
const SENTENCES = [
  null,  // S0: Lessons duet opener — silent, full show audio
  null,  // S1: Inner Light flute — silent, full show audio
  "He was known... as the most serious captain in Starfleet.",
  "A man of duty... discipline... and Shakespeare.",
  "But every now and then, the mask would slip. And Jean-Luc Picard... would smile.",
  null,  // montage
  "Hey... nice smile!",
  null,  // montage
  null,  // montage
  "Oooh, I see a smile!",
  null,  // montage
  "Keep smiling!",
  "Smile!",
  null,  // Family finale — silent, full show audio
];

const AUDIO_DIR = path.join(ROOT, 'public', 'audio', 'narration');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ── Step 1: Generate narration as one combined file ─────────────────
async function generateNarration() {
  console.log('🎙️ Generating narration...');

  // Concatenate non-null sentences with pauses
  const fullText = SENTENCES.filter(s => s != null).join(' ');

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: fullText,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.8,
          style: 0.4,
          use_speaker_boost: true,
        },
        speed: 0.85,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${err}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const combinedPath = path.join(ROOT, 'public', 'audio', 'narration.mp3');
  fs.writeFileSync(combinedPath, buffer);
  console.log(`✅ Combined narration: ${combinedPath} (${(buffer.length / 1024).toFixed(0)} KB)`);

  // Get duration
  const duration = parseFloat(
    execSync(`"${FFMPEG}" -i "${combinedPath}" 2>&1 | grep Duration || true`, { encoding: 'utf-8' })
      .match(/Duration: (\d+):(\d+):(\d+\.\d+)/)
      ?.slice(1)
      .reduce((acc, v, i) => acc + parseFloat(v) * [3600, 60, 1][i], 0) ?? '12'
  );
  console.log(`  Duration: ${duration.toFixed(1)}s`);

  // Now generate each sentence individually for per-sentence files
  console.log('🎙️ Generating per-sentence audio...');
  const segments = [];

  for (let i = 0; i < SENTENCES.length; i++) {
    const padded = `S${String(i).padStart(3, '0')}`;

    // Silent segment (e.g. flute scene opener)
    if (SENTENCES[i] == null) {
      const silentPath = path.join(AUDIO_DIR, `${padded}.mp3`);
      execSync(`"${FFMPEG}" -f lavfi -i anullsrc=r=44100:cl=mono -t 4 -q:a 9 "${silentPath}" -y`, { stdio: 'pipe' });
      segments.push({
        index: i,
        text: '',
        startTime: 0,
        endTime: 0,
        file: `audio/narration/${padded}.mp3`,
        fileDuration: 4,
      });
      console.log(`  ${padded}: [silent — 4s]`);
      continue;
    }

    console.log(`  ${padded}: "${SENTENCES[i].slice(0, 50)}..."`);

    const sentRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: SENTENCES[i],
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!sentRes.ok) {
      console.log(`  ❌ Failed: ${sentRes.status}`);
      continue;
    }

    const sentBuffer = Buffer.from(await sentRes.arrayBuffer());
    const sentPath = path.join(AUDIO_DIR, `${padded}.mp3`);
    fs.writeFileSync(sentPath, sentBuffer);

    // Get per-sentence duration
    let sentDuration = 3;
    try {
      const probe = execSync(
        `"${FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe')}" -v error -show_entries format=duration -of csv=p=0 "${sentPath}"`,
        { encoding: 'utf-8' }
      );
      sentDuration = parseFloat(probe.trim());
    } catch {}

    segments.push({
      index: i,
      text: SENTENCES[i],
      startTime: 0, // Will be computed below
      endTime: 0,
      file: `audio/narration/${padded}.mp3`,
      fileDuration: sentDuration,
    });

    console.log(`  ✅ ${padded}.mp3 (${sentDuration.toFixed(1)}s)`);
  }

  // Compute cumulative start/end times
  let cumulative = 0;
  for (const seg of segments) {
    seg.startTime = cumulative;
    seg.endTime = cumulative + seg.fileDuration;
    cumulative = seg.endTime;
  }

  const narrationData = {
    segments,
    totalDurationSeconds: cumulative,
  };

  fs.writeFileSync(
    path.join(ROOT, 'src', 'narrationData.json'),
    JSON.stringify(narrationData, null, 2)
  );
  console.log(`\n📋 narrationData.json updated (${segments.length} segments, ${cumulative.toFixed(1)}s total)`);

  return cumulative;
}

// ── Step 2: Generate music via ElevenLabs ───────────────────────────
async function generateMusic() {
  console.log('\n🎵 Generating music via ElevenLabs...');

  const res = await fetch(
    'https://api.elevenlabs.io/v1/music/generate',
    {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: 'Very jaunty jazzy flute music, playful swinging rhythm, upbeat and cheerful with jazz piano and light percussion, feel-good groove',
        duration_seconds: 60,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.log(`❌ Music generation failed: ${res.status} ${err}`);
    console.log('Falling back to existing music track.');
    return;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const musicPath = path.join(ROOT, 'public', 'music', 'music.mp3');
  fs.writeFileSync(musicPath, buffer);
  console.log(`✅ Music generated: ${musicPath} (${(buffer.length / 1024).toFixed(0)} KB)`);

  // Get duration and update musicData.json
  let musicDuration = 60;
  try {
    const probe = execSync(
      `"${FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe')}" -v error -show_entries format=duration -of csv=p=0 "${musicPath}"`,
      { encoding: 'utf-8' }
    );
    musicDuration = parseFloat(probe.trim());
  } catch {}

  const musicData = [{
    file: 'music/music.mp3',
    section: 'Picard Smile Supercut',
    startSec: 0,
    endSec: Math.round(musicDuration),
    durationMs: Math.round(musicDuration * 1000),
    prompt: 'Jaunty flute music, lighthearted and warm',
  }];

  fs.writeFileSync(
    path.join(ROOT, 'src', 'musicData.json'),
    JSON.stringify(musicData, null, 2)
  );
  console.log(`📋 musicData.json updated (${musicDuration.toFixed(1)}s)`);
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const narrationDuration = await generateNarration();
  await generateMusic();
  console.log('\n✅ All audio generated!');
  console.log(`Narration: ${narrationDuration.toFixed(1)}s`);
  console.log('Restart Remotion Studio to preview with real audio.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
