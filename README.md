# vstack

AI-powered video production pipeline for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Analyze source footage, generate narration, match clips, and render finished videos — all from your terminal.

## What it does

vstack turns source video files into finished video essays, supercuts, and montages:

1. **Analyze** — Gemini 2.5 Pro scans videos producing rich metadata: scenes, shots, camera types, character expressions, speaker-attributed dialogue, and searchable tags
2. **Review** — Interactive HTML report with first/last frame thumbnails, millisecond timestamp correction, and live frame preview
3. **Narrate** — Write scripts and generate natural TTS audio via ElevenLabs with per-sentence splitting
4. **Assign** — AI matches narration segments to the best clips from analyzed footage
5. **Render** — Preview in Remotion Studio or render final MP4

## Install

```bash
# Global install (available in all projects)
git clone https://github.com/GITWORX01/vstack.git ~/.claude/skills/vstack
cd ~/.claude/skills/vstack && ./setup

# Project-local install (team sharing via git)
cp -Rf ~/.claude/skills/vstack .claude/skills/vstack
```

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Node.js](https://nodejs.org/) 18+
- [ffmpeg](https://ffmpeg.org/) — frame extraction and audio processing
- [Google Cloud SDK](https://cloud.google.com/sdk) with Vertex AI enabled — video analysis
- [ElevenLabs API key](https://elevenlabs.io/) — TTS narration (optional)

## Skills (Slash Commands)

| Command | Description |
|---------|-------------|
| `/vstack-analyze` | Analyze video with Gemini 2.5 Pro — scenes, shots, dialogue |
| `/vstack-review` | Generate interactive Scene Review Report |
| `/vstack-narrate` | Write script + generate TTS audio |
| `/vstack-assign` | Match narration to best video clips |
| `/vstack-render` | Preview or render final video |
| `/vstack-supercut` | Quick supercut builder for specific moments |
| `/vstack-improve` | Read pipeline scripts and propose improvements |
| `/vstack-project` | Project init, save, load, status |

## Cost Estimates

### Video Analysis (Gemini 2.5 Pro via Vertex AI)

Uses `MEDIA_RESOLUTION_LOW` to minimize cost while maintaining metadata quality.

| Scope | Episodes | Runtime | Estimated Cost |
|-------|----------|---------|---------------|
| Single episode | 1 | ~45 min | **~$3.40** |
| Season (22 eps) | 22 | ~16 hrs | **~$75** |
| Full series (176 eps) | 176 | ~132 hrs | **~$600** |

**Per episode (~45 min, 3 chunks):**

| Component | Tokens | Rate | Cost |
|-----------|--------|------|------|
| Video input (LOW) | ~750K | $2.00/M | $1.50 |
| SRT + prompt | ~3K | $2.00/M | $0.01 |
| Output (metadata) | ~30K | $10.00/M | $0.30 |
| Thinking | ~50K | $2.00/M | $0.10 |
| **Total** | | | **~$1.91** |

### Audio (ElevenLabs)

| Component | Cost |
|-----------|------|
| Narration (~500 words) | ~$0.50-1.00 |
| Interjections (30 clips) | ~$0.30 |

### Rendering

Local via Remotion — no API costs.

## Configuration

Create `vstack.config.json` in your project root:

```json
{
  "projectDir": "./output",
  "ffmpegPath": "ffmpeg",
  "mediaDir": "/path/to/source/videos",
  "gcsBucket": "gs://your-bucket-name",
  "gcpProject": "your-gcp-project-id",
  "gcpRegion": "us-central1",
  "elevenLabsVoiceId": "your-voice-id",
  "model": "gemini-2.5-pro",
  "mediaResolution": "MEDIA_RESOLUTION_LOW",
  "chunkMinutes": 15,
  "maxRetries": 5
}
```

## Architecture

```
Source Video (.mp4)
    |
    +-- Gemini 2.5 Pro --> Scene + Shot metadata (JSON)
    |     \-- SRT subtitles --> Speaker-attributed dialogue
    |
    +-- ffmpeg scene detection --> Exact cut timestamps
    |
    +-- Frame extraction --> Thumbnails for review
    |
    \-- Scene Review Report (HTML)
            |
            +-- Narration Script --> ElevenLabs TTS --> Per-sentence audio
            |
            +-- Clip Assignment --> scenes.ts (Remotion config)
            |
            \-- Remotion Render --> Final MP4
```

## Resilience

Built to handle real-world API issues:

- **Exponential backoff** — Rate limits trigger 30s/60s/120s/240s/480s retries (5 attempts)
- **JSON repair** — Auto-fixes Gemini formatting bugs (markdown fences, trailing commas, malformed objects)
- **Shot validation** — Never accepts scenes without shot data; forces retry
- **Truncation detection** — Catches `MAX_TOKENS` responses and retries
- **Stale frame clearing** — Clears frame directory before extraction to prevent numbering mismatches
- **Resume capability** — Batch processor saves state; `--resume` picks up where it left off
- **Chunk caching** — Successful chunks are cached and reused

## Batch Processing

```bash
node batch-analyze.mjs --dry-run --season 2    # Cost estimate
node batch-analyze.mjs --season 2               # Process Season 2
node batch-analyze.mjs --season 2 --start 1 --end 5  # Range
node batch-analyze.mjs --resume                 # Resume after interrupt
node batch-analyze.mjs --status                 # Progress check
```

## Scene Review Report

Interactive HTML editing interface:

- Scene/shot hierarchy with full metadata
- First/last frame thumbnails per shot
- Millisecond timestamp adjustment (+-10ms, +-50ms, +-100ms)
- Live frame preview via local frame server
- Lock, export, and apply corrections
- Settings dropdown showing all analysis parameters

## Subagents

| Agent | Role |
|-------|------|
| `script-writer` | Narration scripts optimized for voiceover |
| `clip-matcher` | Finds best clips from metadata |
| `scene-reviewer` | Analyzes assignments, suggests improvements |
| `audio-engineer` | TTS generation, splitting, alignment |
| `pipeline-improver` | Reads scripts, proposes code changes |

## Safety

- **Destructive command blocking** — Prevents `rm -rf` inside media directories
- **Cost tracking** — Logs spend per API call, warns at budget limits
- **Audit logging** — All tool calls logged to `.claude/audit.log`

## License

MIT
