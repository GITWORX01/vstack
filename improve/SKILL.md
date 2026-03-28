---
name: improve
version: 0.2.0
description: Analyze pipeline scripts and propose targeted improvements with diff preview and user approval
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

# /improve — Pipeline Improvement

Analyzes vstack's own pipeline scripts and proposes targeted improvements. Uses the **pipeline-improver** subagent to read script source code, understand the logic, and suggest changes.

## Safety

- All edits require explicit user approval (shown as diffs)
- Current state is committed via git before any modification
- Changes can be rolled back with `git checkout`

## Pipeline Scripts

| Script | Purpose |
|--------|---------|
| `lib/analyze-episode.mjs` | Core Gemini two-pass analysis engine (most commonly improved) |
| `lib/db.mjs` | SQLite database — schema, indexing, search, semantic query expansion |
| `lib/rebuild-report.mjs` | Scene Review Report HTML generation |
| `lib/frame-server.mjs` | HTTP server for hub, frames, video streaming, API |
| `lib/hub-api.mjs` | REST API endpoints for the media library hub |
| `lib/batch-analyze.mjs` | Multi-episode batch processor with resume |
| `lib/apply-corrections.mjs` | Apply timestamp corrections from report export |
| `lib/generate-audio.mjs` | ElevenLabs TTS + ffmpeg splitting |
| `lib/generate-interjections.mjs` | Short narrator interjection audio clips |
| `lib/integrate-srt.mjs` | SRT subtitle parsing and integration |
| `lib/config.mjs` | Shared configuration loader |
| `lib/utils.mjs` | Shared utilities (parseTs, fmtTs, parseSRT, etc.) |

## Common Improvements

- **Prompt engineering** — improve Gemini prompts for better metadata quality
- **Error handling** — better retry logic, region failover tuning
- **Performance** — increase concurrency, optimize frame extraction
- **New flags** — add --dry-run, --verbose, --resume options
- **Edge cases** — fix timing calculations, handle unusual video formats
- **Report features** — add new UI controls, search capabilities, bulk operations
- **Database schema** — add new fields, improve search indexing
- **Hub features** — new pages, collection management, data visualization

## Usage

```
/improve "The analysis keeps returning scenes without shots — fix the retry logic"
/improve "Add a --resume flag to batch-analyze.mjs"
/improve "The frame server crashes on large videos"
/improve "Add a character timeline visualization to the hub"
```

## Cost

Free (code analysis only). Rerunning modified passes costs normal API rates.
