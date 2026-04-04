#!/usr/bin/env python3
"""
Pass 1.1 — Whisper Word-Level Transcription

Extracts word-level timestamps from an audio file using faster-whisper.
Outputs JSON array of {word, start, end} to stdout.

Usage:
    python pass11_whisper.py "path/to/audio.wav" [--model base] [--device cuda]

Requires: pip install faster-whisper
"""

import sys
import json
import os
import time

# Fix Windows Unicode output
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

def main():
    if len(sys.argv) < 2:
        print("Usage: python pass11_whisper.py <audio_file> [--model base] [--device cuda]", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]

    # Parse optional args
    model_name = "base"
    device = "cuda"
    output_file = None

    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--model" and i + 1 < len(sys.argv):
            model_name = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--device" and i + 1 < len(sys.argv):
            device = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--output" and i + 1 < len(sys.argv):
            output_file = sys.argv[i + 1]
            i += 2
        else:
            i += 1

    if not os.path.exists(audio_path):
        print(f"Error: Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading faster-whisper model '{model_name}' on {device}...", file=sys.stderr)
    start_time = time.time()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("Error: faster-whisper not installed. Run: pip install faster-whisper", file=sys.stderr)
        sys.exit(1)

    # Try CUDA first, fall back to CPU
    try:
        model = WhisperModel(model_name, device=device, compute_type="float16" if device == "cuda" else "int8")
    except Exception as e:
        if device == "cuda":
            print(f"CUDA failed ({e}), falling back to CPU...", file=sys.stderr)
            device = "cpu"
            model = WhisperModel(model_name, device="cpu", compute_type="int8")
        else:
            raise

    load_time = time.time() - start_time
    print(f"Model loaded in {load_time:.1f}s", file=sys.stderr)

    print(f"Transcribing: {os.path.basename(audio_path)}", file=sys.stderr)
    trans_start = time.time()

    segments, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        language="en",
        vad_filter=True,       # Voice Activity Detection — skip silence
        vad_parameters=dict(
            min_silence_duration_ms=300,  # Minimum silence to split on
        ),
    )

    # Collect all words with timestamps
    words = []
    segment_count = 0
    for segment in segments:
        segment_count += 1
        if segment.words:
            for w in segment.words:
                words.append({
                    "word": w.word.strip(),
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                })

        # Progress update every 50 segments
        if segment_count % 50 == 0:
            print(f"  Processed {segment_count} segments, {len(words)} words...", file=sys.stderr)

    trans_time = time.time() - trans_start
    print(f"Transcription complete: {len(words)} words in {trans_time:.1f}s ({segment_count} segments)", file=sys.stderr)
    print(f"Audio duration: {info.duration:.1f}s | Language: {info.language} (prob: {info.language_probability:.2f})", file=sys.stderr)

    # Output JSON
    result = json.dumps(words, ensure_ascii=False)

    if output_file:
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(result)
        print(f"Saved to {output_file}", file=sys.stderr)
    else:
        print(result)


if __name__ == "__main__":
    main()
