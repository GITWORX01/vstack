# vstack — AI Video Production Pipeline

A collection of Claude Code skills for creating narrated video essays, supercuts, and montages from source footage. Powered by Gemini 2.5 Pro (video analysis), ElevenLabs (TTS), ffmpeg (frame extraction), SQLite (metadata search), and Remotion (rendering).

## Available Skills

| Command | Purpose |
|---------|---------|
| `/analyze` | Two-pass video analysis with Gemini 2.5 Pro — scenes, shots, dialogue, context caching |
| `/review` | Interactive Scene Review Report with video player, search, shot joining, timestamp correction |
| `/narrate` | Write narration scripts + generate TTS audio via ElevenLabs |
| `/assign` | Match narration to best clips using SQLite semantic search across all analyzed videos |
| `/render` | Preview in Remotion Studio or render final video to MP4 |
| `/supercut` | Quick supercut builder — search DB for specific moments, curate, assemble |
| `/improve` | Analyze pipeline scripts and propose targeted improvements |
| `/project` | Initialize, save, load, and check status of video projects |

## Media Library Hub

The hub serves at `http://localhost:3333/` when the frame server is running:
- **Collections** — organize videos into named collections (e.g., "Star Trek TNG")
- **Episode grid** — thumbnails, metadata stats, analysis status
- **Episode detail** — character bars, shot type distribution, dialogue counts
- **Search** — search across all analyzed shots from the hub
- **Export/Import** — share collections as `.vstack.zip` files (metadata + thumbnails)
- **Advanced page** — raw database tables, API endpoint reference

Start the hub: `node lib/frame-server.mjs`

## SQLite Database

All analyzed metadata lives in `vstack.db` with FTS5 full-text search:
- Auto-rebuilds after each episode analysis (hash-based change detection)
- Semantic search with AI query expansion (`--find "picard smiling"`)
- Direct FTS5 search (`--search "close-up AND picard"`)
- Dialogue search (`--search-dialogue "make it so"`)

## Typical Workflow

```
/project init          → Set up a new video project with source files
/analyze               → AI-scan source footage (two-pass scene + shot metadata)
/review                → Visual review in Scene Review Report
/narrate               → Write script + generate voiceover audio
/assign                → Match narration to best clips via DB search
/review                → Review assignments, adjust timestamps
/render                → Preview and render final video
```

## Batch Processing

```bash
node lib/batch-analyze.mjs --dry-run --season 2    # cost estimate
node lib/batch-analyze.mjs --season 2               # process full season
node lib/batch-analyze.mjs --resume                  # resume after interrupt
node lib/batch-analyze.mjs --status                  # check progress
```

## Configuration

Projects use `vstack.config.json` in the working directory. API keys go in `.env` (gitignored):

```
# .env
ELEVENLABS_API_KEY=sk_...
ANTHROPIC_API_KEY=sk-ant-...
MEDIA_DIR=C:\Movies
GCLOUD_PATH=C:\...\google-cloud-sdk\bin
```

## Required Services

- **Google Cloud** — Vertex AI for Gemini 2.5 Pro video analysis (`gcloud auth login`)
- **ElevenLabs** — TTS narration + music generation (API key in `.env`)
- **ffmpeg** — frame extraction, audio splitting, scene detection (local)
- **Remotion** — React-based video rendering (local)

## Safety Rules

- **NEVER** `rm -rf` inside media directories — source files could be destroyed
- **ALWAYS** rebuild the review report after changing scenes.json
- **ALWAYS** warn about costs before running expensive analysis passes
- **ALWAYS** clear frames/ directory before re-extracting (prevents stale frame mismatch)
- Pipeline script modifications require explicit user approval
