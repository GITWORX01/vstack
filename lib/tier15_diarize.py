#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os
os.environ['PYTHONIOENCODING'] = 'utf-8'
import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

"""
Tier 1.5 -- Speaker Diarization using pyannote-audio

Identifies "who spoke when" in an episode audio track.
Outputs a JSON file mapping time ranges to speaker IDs.

Usage:
  python tier15_diarize.py "C:/Star Trek/episode.mp4" output.json [--num-speakers N]

Requires:
  pip install pyannote.audio torch torchaudio
  Hugging Face token with access to pyannote models
"""

import sys
import os
import json
import time
import tempfile
import subprocess
from pathlib import Path

def extract_audio(video_path, output_path, sample_rate=16000):
    """Extract mono 16kHz audio from video using ffmpeg."""
    # Find ffmpeg
    ffmpeg_dir = Path(__file__).parent / 'ffmpeg'
    ffmpeg_subs = [d for d in ffmpeg_dir.iterdir() if d.is_dir() and d.name.startswith('ffmpeg-')]
    ffmpeg = str(ffmpeg_subs[0] / 'bin' / 'ffmpeg.exe') if ffmpeg_subs else 'ffmpeg'

    cmd = [
        ffmpeg, '-i', str(video_path),
        '-ac', '1',           # mono
        '-ar', str(sample_rate),  # 16kHz
        '-acodec', 'pcm_s16le',  # WAV format
        '-y', str(output_path)
    ]

    print(f"  Extracting audio ({sample_rate}Hz mono)...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        print(f"  ⚠️  ffmpeg stderr: {result.stderr[:200]}")

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"  ✅ Audio extracted: {size_mb:.1f} MB")
    return output_path


def run_diarization(audio_path, num_speakers=None, hf_token=None):
    """Run pyannote speaker diarization on audio file."""
    from pyannote.audio import Pipeline

    # Use community model (open source, no token needed) or authenticated model
    model_name = "pyannote/speaker-diarization-3.1"

    print(f"  Loading diarization model: {model_name}")

    kwargs = {}
    if hf_token:
        kwargs['token'] = hf_token

    try:
        pipeline = Pipeline.from_pretrained(model_name, **kwargs)
    except Exception as e:
        print(f"  ⚠️  Failed to load 3.1, trying community model...")
        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", **kwargs)

    # Use GPU if available
    import torch
    if torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))
        print(f"  Using GPU: {torch.cuda.get_device_name(0)}")
    else:
        print(f"  Using CPU (slower)")

    # Load audio as waveform using scipy (bypasses broken torchcodec/torchaudio)
    import numpy as np
    try:
        from scipy.io import wavfile
    except ImportError:
        subprocess.run([sys.executable, '-m', 'pip', 'install', 'scipy'], capture_output=True)
        from scipy.io import wavfile

    print(f"  Loading audio waveform (scipy)...")
    sample_rate, audio_np = wavfile.read(str(audio_path))
    # Convert to float32 tensor, normalize to [-1, 1]
    if audio_np.dtype == np.int16:
        audio_np = audio_np.astype(np.float32) / 32768.0
    elif audio_np.dtype == np.int32:
        audio_np = audio_np.astype(np.float32) / 2147483648.0
    # Make it (1, samples) shape for pyannote
    waveform = torch.from_numpy(audio_np).unsqueeze(0)
    if sample_rate != 16000:
        # Simple resample using torch interpolation
        target_len = int(waveform.shape[1] * 16000 / sample_rate)
        waveform = torch.nn.functional.interpolate(waveform.unsqueeze(0), size=target_len, mode='linear', align_corners=False).squeeze(0)
        sample_rate = 16000
    audio_input = {"waveform": waveform, "sample_rate": sample_rate}
    print(f"  Audio: {waveform.shape[1] / sample_rate:.1f}s, {sample_rate}Hz")

    print(f"  Running diarization...")
    start_time = time.time()

    diarization_params = {}
    if num_speakers:
        diarization_params['num_speakers'] = num_speakers

    diarization = pipeline(audio_input, **diarization_params)

    elapsed = time.time() - start_time
    print(f"  ✅ Diarization complete in {elapsed:.1f}s")

    return diarization


def diarization_to_json(diarization):
    """Convert pyannote diarization result to JSON-serializable list."""
    # pyannote 4.x returns DiarizeOutput
    # Try multiple approaches to extract segments
    segments = []

    if hasattr(diarization, 'speaker_diarization'):
        # pyannote 4.x DiarizeOutput — access the Annotation directly
        annotation = diarization.speaker_diarization
        if hasattr(annotation, 'itertracks'):
            for turn, _, speaker in annotation.itertracks(yield_label=True):
                segments.append({
                    'speaker': speaker,
                    'start': round(turn.start, 3),
                    'end': round(turn.end, 3),
                    'duration': round(turn.end - turn.start, 3)
                })
            print(f"  Extracted {len(segments)} segments from speaker_diarization")
    elif hasattr(diarization, 'itertracks'):
        # Old-style Annotation object
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append({
                'speaker': speaker,
                'start': round(turn.start, 3),
                'end': round(turn.end, 3),
                'duration': round(turn.end - turn.start, 3)
            })
    elif hasattr(diarization, 'serialize'):
        # pyannote 4.x DiarizeOutput — serialize returns a dict
        serialized = diarization.serialize()
        print(f"  Serialized type: {type(serialized)}, keys: {list(serialized.keys()) if isinstance(serialized, dict) else 'N/A'}")

        if isinstance(serialized, dict):
            # Try to extract from the dict structure
            if 'content' in serialized:
                for item in serialized['content']:
                    segments.append({
                        'speaker': item.get('speaker', item.get('label', 'Unknown')),
                        'start': round(item.get('start', item.get('segment', {}).get('start', 0)), 3),
                        'end': round(item.get('end', item.get('segment', {}).get('end', 0)), 3),
                        'duration': round(item.get('end', 0) - item.get('start', 0), 3)
                    })
            elif 'annotation' in serialized:
                ann = serialized['annotation']
                if hasattr(ann, 'itertracks'):
                    for turn, _, speaker in ann.itertracks(yield_label=True):
                        segments.append({
                            'speaker': speaker,
                            'start': round(turn.start, 3),
                            'end': round(turn.end, 3),
                            'duration': round(turn.end - turn.start, 3)
                        })
            else:
                # Dump the structure for debugging
                import json as jsonmod
                print(f"  Unknown dict structure: {jsonmod.dumps({k: str(type(v))[:50] for k,v in serialized.items()})}")
                # Try RTTM approach instead
                print(f"  Trying write_rttm approach...")

    # Fallback: use write_rttm to get segments
    if not segments:
        try:
            rttm_path = str(audio_path) + '.rttm'
            if hasattr(diarization, 'write_rttm'):
                with open(rttm_path, 'w') as f:
                    diarization.write_rttm(f)
            elif hasattr(diarization, 'serialize'):
                s = diarization.serialize()
                if hasattr(s, 'write_rttm'):
                    with open(rttm_path, 'w') as f:
                        s.write_rttm(f)

            if os.path.exists(rttm_path):
                with open(rttm_path) as f:
                    for line in f:
                        parts = line.strip().split()
                        if len(parts) >= 8 and parts[0] == 'SPEAKER':
                            start = float(parts[3])
                            dur = float(parts[4])
                            speaker = parts[7]
                            segments.append({
                                'speaker': speaker,
                                'start': round(start, 3),
                                'end': round(start + dur, 3),
                                'duration': round(dur, 3)
                            })
                os.unlink(rttm_path)
                print(f"  Parsed {len(segments)} segments from RTTM")
        except Exception as e:
            print(f"  RTTM fallback failed: {e}")

    if not segments:
        print(f"  ⚠️  No segments extracted! Diarization type: {type(diarization)}")
        print(f"  Dir: {[m for m in dir(diarization) if not m.startswith('_')]}")
        return {'segments': [], 'speakers': [], 'speakerStats': {}, 'totalSegments': 0, 'totalSpeakers': 0}
        segments.append({
            'speaker': speaker,
            'start': round(turn.start, 3),
            'end': round(turn.end, 3),
            'duration': round(turn.end - turn.start, 3)
        })

    # Get unique speakers
    speakers = sorted(set(s['speaker'] for s in segments))

    # Calculate stats per speaker
    speaker_stats = {}
    for sp in speakers:
        sp_segs = [s for s in segments if s['speaker'] == sp]
        total_time = sum(s['duration'] for s in sp_segs)
        speaker_stats[sp] = {
            'segments': len(sp_segs),
            'totalTime': round(total_time, 1),
            'percentage': 0  # filled below
        }

    total_speech = sum(s['totalTime'] for s in speaker_stats.values())
    for sp in speaker_stats:
        speaker_stats[sp]['percentage'] = round(speaker_stats[sp]['totalTime'] / total_speech * 100, 1) if total_speech > 0 else 0

    return {
        'segments': segments,
        'speakers': speakers,
        'speakerStats': speaker_stats,
        'totalSegments': len(segments),
        'totalSpeakers': len(speakers)
    }


def main():
    if len(sys.argv) < 3:
        print("Usage: python tier15_diarize.py VIDEO_PATH OUTPUT_JSON [--num-speakers N] [--hf-token TOKEN]")
        sys.exit(1)

    video_path = sys.argv[1]
    output_path = sys.argv[2]

    # Parse optional args
    num_speakers = None
    hf_token = os.environ.get('HF_TOKEN', None)

    for i, arg in enumerate(sys.argv[3:], 3):
        if arg == '--num-speakers' and i + 1 < len(sys.argv):
            num_speakers = int(sys.argv[i + 1])
        elif arg == '--hf-token' and i + 1 < len(sys.argv):
            hf_token = sys.argv[i + 1]

    if not os.path.exists(video_path):
        print(f"❌ Video not found: {video_path}")
        sys.exit(1)

    print(f"\n{'='*60}")
    print(f"  Tier 1.5 — Speaker Diarization")
    print(f"  Video: {os.path.basename(video_path)}")
    if num_speakers:
        print(f"  Expected speakers: {num_speakers}")
    print(f"{'='*60}\n")

    # Step 1: Extract audio
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        audio_path = tmp.name

    try:
        extract_audio(video_path, audio_path)

        # Step 2: Run diarization
        diarization = run_diarization(audio_path, num_speakers=num_speakers, hf_token=hf_token)

        # Step 3: Convert to JSON
        result = diarization_to_json(diarization)

        # Save
        with open(output_path, 'w') as f:
            json.dump(result, f, indent=2)

        print(f"\n  📊 Results:")
        print(f"     Speakers found: {result['totalSpeakers']}")
        print(f"     Segments: {result['totalSegments']}")
        for sp, stats in result['speakerStats'].items():
            print(f"     {sp}: {stats['totalTime']}s ({stats['percentage']}%) — {stats['segments']} segments")
        print(f"\n  💾 Saved to: {output_path}")

    finally:
        # Cleanup temp audio
        if os.path.exists(audio_path):
            os.unlink(audio_path)

    print(f"\n{'='*60}")
    print(f"  ✅ Diarization complete!")
    print(f"{'='*60}\n")


if __name__ == '__main__':
    main()
