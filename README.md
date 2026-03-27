# vstack

AI-powered video production pipeline for [Claude Code](https://claude.ai/claude-code). Analyze source footage with Gemini vision, generate narration with ElevenLabs, match clips to script, and render with Remotion — all orchestrated through slash commands.

## What it does

vstack turns raw video files into narrated video essays, supercuts, and montages. The pipeline:

1. **Analyzes** source video with Gemini 2.5 Pro — extracts scene/shot metadata with sub-second timestamps, speaker-attributed dialogue, character expressions, camera work, and searchable tags
2. **Snaps** timestamps to exact cut points using ffmpeg scene detection
3. **Generates** an interactive Scene Review Report with frame previews and millisecond adjustment controls
4. **Writes** narration scripts and generates voiceover audio via ElevenLabs
5. **Matches** narration segments to the best clips from your analyzed footage
6. **Renders** the final video using Remotion (React-based video framework)

## Install

```bash
# Global install (available in all projects)
git clone https://github.com/GITWORX01/vstack.git ~/.claude/skills/vstack
cd ~/.claude/skills/vstack && ./setup

# Project-local install (shared with team via git)
git clone https://github.com/GITWORX01/vstack.git .claude/skills/vstack
cd .claude/skills/vstack && ./setup
```

### Prerequisites

- **Claude Code** — the CLI agent
- **Node.js** 18+
- **ffmpeg** — frame extraction and scene detection
- **Google Cloud SDK** (`gcloud`) — authenticated with a project that has Vertex AI enabled
- **ElevenLabs API key** — for TTS narration (optional, only needed for `/narrate`)

## Slash Commands

| Command | What it does |
|---------|-------------|
| `/analyze` | Analyze video files with Gemini 2.5 Pro — scene + shot + dialogue metadata |
| `/review` | Generate interactive Scene Review Report with live frame preview |
| `/narrate` | Write narration scripts + generate TTS audio via ElevenLabs |
| `/assign` | Match narration segments to best video clips from analyzed footage |
| `/render` | Preview in Remotion Studio or render final video to MP4 |
| `/supercut` | Quick supercut builder — scan for moments, select, assemble |
| `/improve` | Analyze and propose improvements to pipeline scripts |
| `/project` | Initialize, save, load, and manage video projects |

## Workflow

```
/project init     Set up a new video project with source files
/analyze          AI-scan source footage (Gemini 2.5 Pro + ffmpeg)
/review           Interactive visual review of analysis results
/narrate          Write script + generate voiceover
/assign           Match narration to best clips
/review           Review scene assignments, adjust timestamps
/render           Preview and render final video
```

## Analysis Costs

Video analysis uses Gemini 2.5 Pro via Vertex AI. Costs depend on video length and resolution setting.

### Per-episode costs (Gemini 2.5 Pro, LOW resolution)

| Duration | Input tokens | Output tokens | Estimated cost |
|----------|-------------|---------------|---------------|
| 5 min | ~125K | ~8K | ~$0.33 |
| 10 min | ~249K | ~16K | ~$0.66 |
| 15 min (1 chunk) | ~374K | ~24K | ~$0.99 |
| 45 min (standard TV episode) | ~1.12M | ~72K | ~$2.96 |
| 90 min (double episode / film) | ~2.24M | ~144K | ~$5.92 |

### Scaling estimates

| Scope | Episodes | Est. cost | Est. time |
|-------|----------|-----------|-----------|
| 1 episode (45 min) | 1 | ~$3 | ~20 min |
| 1 season (24 episodes) | 24 | ~$58-72 | ~8 hours |
| Full series (7 seasons) | 178 | ~$430-530 | ~2.5 days |

### Cost breakdown

- **Input tokens** are ~95% of the cost (video frames sent to Gemini)
- **Output tokens** are ~5% (scene/shot metadata returned)
- **Resolution** has the biggest impact: LOW is recommended for metadata extraction. MEDIUM/HIGH cost 2-4x more with minimal accuracy improvement for timestamps/descriptions
- **Speaker attribution** adds ~20% more output tokens (dialogue data) but no additional input cost
- **ffmpeg scene detection** is free (runs locally)
- **Frame extraction** is free (runs locally via ffmpeg)

### Other pipeline costs

| Step | Service | Est. cost |
|------|---------|-----------|
| Narration TTS | ElevenLabs | ~$1 per script |
| Clip matching | Claude API (Opus) | ~$3-5 per video |
| Script writing | Claude API (Sonnet) | ~$0.50 per script |
| Interjection audio | ElevenLabs | ~$0.25 per batch |
| Scene verification | Claude API (Sonnet) | ~$1-2 per run |
| Rendering | Local (Remotion) | Free |

## Configuration

Create `vstack.config.json` in your project directory:

```json
{
  "project": "my-video",
  "projectDir": "./analysis-output",
  "sourceDir": "./source-videos",
  "gcsBucket": "gs://my-video-analysis",
  "gcpProject": "my-gcp-project",
  "gcpRegion": "us-central1",
  "model": "gemini-2.5-pro",
  "mediaResolution": "MEDIA_RESOLUTION_LOW",
  "chunkMinutes": 15,
  "maxOutputTokens": 65536,
  "ffmpegPath": "ffmpeg",
  "elevenLabsVoice": "default",
  "budgetLimit": 100,
  "outputDir": "./out"
}
```

### Required API keys / auth

| Key | Purpose | Required for |
|-----|---------|-------------|
| `gcloud auth login` | Gemini via Vertex AI | `/analyze` |
| `ELEVENLABS_API_KEY` | TTS narration | `/narrate` |
| `ANTHROPIC_API_KEY` | Claude (script writing, clip matching) | `/narrate`, `/assign` |

## How Analysis Works

The analysis pipeline processes video in three stages:

### 1. Gemini Vision Analysis
Video is uploaded to Google Cloud Storage and analyzed by Gemini 2.5 Pro in 15-minute chunks. Each chunk returns:
- **Scenes** — logical story segments with location, characters, mood
- **Shots** within each scene — every camera cut with shot type, subject, action, character expressions, camera movement, and searchable tags
- **Dialogue** — speaker-attributed lines matched to exact SRT subtitle text (when available)

### 2. ffmpeg Scene Detection
ffmpeg's scene change detection runs locally on the full video, finding exact cut points at frame-level precision. Gemini's timestamps are then "snapped" to the nearest real cut point (typically within 0.2-0.4 seconds).

### 3. Frame Extraction
First and last frames are extracted for every shot at the snapped timestamps, then displayed in the Scene Review Report for visual verification.

### Known limitations
- Gemini sees video at ~1 fps, so timestamp precision is ~1 second before snapping
- ffmpeg snapping corrects most timing to within ~100ms
- Very fast cuts (<0.5s) may be merged into adjacent shots
- Character identification can be wrong for minor/guest characters
- Speaker attribution works best when SRT subtitles are provided

## Scene Review Report

The interactive HTML report is the primary editing interface:

- **Scene-level metadata**: location, characters, mood, plot significance
- **Shot-level detail**: first/last frame thumbnails, shot type, subject, action, expressions, dialogue
- **Timestamp adjustment**: +-10ms / +-50ms / +-100ms buttons for start and end of every shot
- **Live frame preview**: adjustments show real frames from the video via the frame server
- **Lock-in flow**: lock corrected shots to prevent accidental changes
- **Export corrections**: copy all adjustments as structured text for the pipeline to apply
- **Settings dropdown**: full parameter transparency (model, resolution, chunk size, thresholds)

### Frame server

The report uses a local frame server for live previews:

```bash
node lib/frame-server.mjs   # starts on http://localhost:3333
```

## Project Structure

```
vstack/
  setup                    # Cross-platform installer
  CLAUDE.md                # Skill registry for Claude Code
  README.md                # This file
  package.json
  analyze/SKILL.md         # /analyze skill definition
  review/SKILL.md          # /review skill definition
  narrate/SKILL.md         # /narrate skill definition
  assign/SKILL.md          # /assign skill definition
  render/SKILL.md          # /render skill definition
  supercut/SKILL.md        # /supercut skill definition
  improve/SKILL.md         # /improve skill definition
  project/SKILL.md         # /project skill definition
  lib/
    analyze-episode.mjs    # Core Gemini analysis engine
    config.mjs             # Shared config loader
    utils.mjs              # Timestamp parsing, SRT, helpers
    rebuild-report.mjs     # Scene Review Report builder
    frame-server.mjs       # Live frame extraction server
    integrate-srt.mjs      # SRT subtitle integration
    generate-audio.mjs     # ElevenLabs TTS + ffmpeg split
    generate-interjections.mjs
  agents/                  # Subagent definitions
    script-writer.md
    clip-matcher.md
    scene-reviewer.md
    audio-engineer.md
    pipeline-improver.md
  hooks/                   # Safety and tracking
    safety.mjs             # Blocks destructive operations
    cost-tracker.mjs       # Tracks API spend per session
    audit.mjs              # Logs all tool calls
```

## License

MIT
