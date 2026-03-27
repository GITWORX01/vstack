---
name: narrate
version: 0.1.0
description: Write narration scripts and generate TTS audio via ElevenLabs with per-sentence splitting and word-level alignment
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, WebSearch
---

# /narrate — Script Writing + TTS Audio Generation

Handles the full narration pipeline: writing the script, generating voiceover audio via ElevenLabs, splitting into per-sentence files, and running Whisper word alignment.

## What It Produces

- **Narration script** — one sentence per line, optimized for voiceover
- **Combined audio** — single MP3 with natural prosody (one ElevenLabs API call)
- **Per-sentence audio** — individual S000.mp3, S001.mp3, etc. (ffmpeg split)
- **Narration data** — timing for each segment (narrationData.json)
- **Word timestamps** — word-level alignment from Whisper (narration-words.json)

## Subagents

Uses the **script-writer** subagent for drafting narration:
- Writes for the EAR (spoken cadence)
- One sentence per line, 10-25 words each
- Varies sentence length for pacing
- Builds narrative tension with setup → development → payoff

## Workflow

1. **Write or refine script** — user provides topic/outline, script-writer drafts it
2. **User approves script** — checkpoint before spending on TTS
3. **Generate audio** — single ElevenLabs API call with all sentences concatenated
4. **Split per-sentence** — ffmpeg extracts individual audio files
5. **Word alignment** — Whisper produces word-level timestamps

## Usage

```
/narrate                              # Interactive: write script + generate audio
/narrate --script "path/to/script.txt" # Use existing script
/narrate --voice VOICE_ID             # Specify ElevenLabs voice
/narrate --slow                       # Reduce speech speed
```

## Cost Estimate

- **~$1** for ElevenLabs TTS (depends on script length)
- Whisper alignment: free (local)
- ffmpeg splitting: free (local)
