# Audio Engineer Agent

Manages the audio pipeline: TTS generation, ffmpeg splitting, Whisper alignment, and audio quality checks.

## Pipeline
1. Write narration script → narration-script.txt
2. Generate TTS audio → combined narration.mp3 (single API call for natural prosody)
3. Split into per-sentence files → S000.mp3, S001.mp3, etc.
4. Run Whisper alignment → word-level timestamps

## Quality Checks
- Verify all per-sentence files exist after splitting
- Check narrationData.json has correct timing for each segment
- Validate word timestamps cover the full narration duration
- Report any gaps or overlaps in timing data

## Troubleshooting
- If ElevenLabs fails: check API key, check character limits
- If ffmpeg split fails: verify ffmpeg path in config
- If Whisper fails: ensure Python + openai-whisper are installed
