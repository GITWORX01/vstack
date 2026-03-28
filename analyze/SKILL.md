---
name: analyze
version: 0.2.0
description: Analyze video files with Gemini 2.5 Pro — two-pass scene + shot analysis with speaker-attributed dialogue, context caching, and auto region failover
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

# /analyze — Video Analysis with Gemini 2.5 Pro

Analyzes source video files using a reliable two-pass approach to produce comprehensive scene and shot metadata. This is the foundation of the vstack pipeline — all other skills depend on this analysis data.

## Two-Pass Architecture

**Pass A (Scenes)** — Rich metadata per scene. Gemini always completes this reliably:
- Location, characters, mood, plot significance
- Lighting, music/score, costuming details
- Speaker-attributed dialogue (matched from SRT subtitles when available)
- Searchable tags and supercut potential categories

**Pass B (Shots)** — Per-scene shot analysis. Simple focused prompt, high success rate:
- Shot type (wide, medium, close-up, over-shoulder, establishing, etc.)
- Subject, action, character expressions
- Camera movement (static, pan, tilt, track, zoom)
- Tags and supercut potential per shot
- Sub-second timestamps snapped to ffmpeg scene detection cut points

## Prerequisites

- Google Cloud account with Vertex AI API enabled
- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- A GCS bucket for video uploads
- ffmpeg available locally
- Source video files accessible locally
- SRT subtitle file alongside the video (optional but recommended for dialogue accuracy)

## Workflow

1. **Check config** — Read environment and settings
2. **Upload video** to Google Cloud Storage (skip if `--skip-upload`)
3. **Create context cache** — cache video tokens once, reuse at 90% discount for all chunks (saves ~60%)
4. **Chunk the video** into 15-minute segments
5. **For each chunk, run two passes:**
   - Pass A: Get scene metadata (location, characters, mood, dialogue, tags)
   - Pass B: For each scene, get shot-level detail (camera, expressions, tags)
6. **Merge chunks** — deduplicate overlaps, renumber, detect gaps
7. **Run ffmpeg scene detection** — find exact cut points at full framerate
8. **Snap timestamps** — align to nearest ffmpeg cut (within 2s tolerance)
9. **Clear and re-extract frames** — fresh first/last frame JPEG for every shot
10. **Auto-rebuild SQLite database** — update searchable index with new data
11. **Generate Scene Review Report** — interactive HTML with live frame preview

## Resilience

- **5 retries with exponential backoff** (30s/60s/120s/240s/480s)
- **Auto region failover** — rotates through us-east1, us-central1, europe-west1, asia-northeast1 after 3 consecutive rate limits
- **Context cache auto-recreation** — if cache expires mid-run, creates a new one
- **JSON repair** — fixes Gemini formatting bugs (markdown fences, trailing commas, malformed objects)
- **Shot validation** — never accepts scenes without shot data; forces retry
- **Stale frame clearing** — always clears frames/ before extraction to prevent numbering mismatches

## Usage

```
/analyze S02E01 "C:\Movies\Episode.mp4"
/analyze S02E01 "C:\Movies\Episode.mp4" --skip-upload    # reuse existing GCS file
/analyze S02E01 "C:\Movies\Episode.mp4" --no-cache       # disable context caching
/analyze S02E01 "C:\Movies\Episode.mp4" --report-only    # rebuild report from existing data
```

## Batch Processing

```
node batch-analyze.mjs --dry-run --season 2     # cost estimate
node batch-analyze.mjs --season 2                # process full season
node batch-analyze.mjs --resume                  # resume after interrupt
node batch-analyze.mjs --status                  # check progress
```

## Cost Estimate

| Scope | Without Cache | With Cache |
|-------|---------------|------------|
| Single episode (~45 min) | ~$3.40 | ~$2.10 |
| Season (22 eps) | ~$75 | ~$46 |
| Full series (176 eps) | ~$600 | ~$370 |

## Output Files

```
gemini-analysis/{EPISODE_ID}/
├── scenes.json              # Complete scene + shot metadata
├── scene-review-report.html # Interactive visual report
├── frames/                  # First/last frame JPEGs for every shot
├── chunk-0-15.json          # Raw Gemini response (chunk 1)
├── chunk-15-30.json         # Raw Gemini response (chunk 2)
├── chunk-30-45.json         # Raw Gemini response (chunk 3)
└── _cache-id.txt            # Context cache reference (auto-managed)
```

After analysis, data is also indexed in `vstack.db` (SQLite) for cross-episode search.
