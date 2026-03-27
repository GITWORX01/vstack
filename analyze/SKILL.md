---
name: analyze
version: 0.1.0
description: Analyze video files with Gemini 2.5 Pro — produces scene, shot, and speaker-attributed dialogue metadata with frame-accurate timestamps
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

# /analyze — Video Analysis with Gemini 2.5 Pro

Analyzes source video files to produce comprehensive scene and shot metadata. This is the foundation of the vstack pipeline — all other skills depend on this analysis data.

## What It Produces

For each video file:
- **Scenes** — logical story segments with location, characters, mood, plot significance
- **Shots** within each scene — every camera cut with shot type, subject, action, character expressions, camera movement, tags, and supercut potential categories
- **Speaker-attributed dialogue** — if an SRT subtitle file exists, each line is matched to the speaking character
- **Frame-accurate timestamps** — Gemini timestamps are snapped to exact ffmpeg scene-cut points (±200ms precision)
- **First/last frame images** for every shot

## Prerequisites

- Google Cloud account with Vertex AI API enabled
- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- A GCS bucket for video uploads (set in `vstack.config.json`)
- ffmpeg available on PATH or configured in config
- Source video files accessible locally

## Workflow

1. **Check config** — Read `vstack.config.json` for GCS bucket, project, model settings
2. **Upload video** to Google Cloud Storage (skip if `--skip-upload`)
3. **Chunk the video** into 15-minute segments (configurable via `chunkMinutes`)
4. **Run Gemini 2.5 Pro** on each chunk with scene+shot+dialogue prompt
   - If SRT file exists alongside video, subtitle text is included in the prompt for exact dialogue + speaker attribution
   - Failed chunks (missing shots) are automatically retried up to 3 times
5. **Merge chunks** — deduplicate overlapping scenes, renumber sequentially, detect gaps
6. **Run ffmpeg scene detection** — find exact cut points at full framerate
7. **Snap timestamps** — align Gemini's timestamps to nearest ffmpeg cut (within 2s tolerance)
8. **Extract frames** — first and last frame JPEG for every shot
9. **Save scenes.json** — complete metadata file
10. **Generate Scene Review Report** — interactive HTML with live frame preview

## Usage

```
/analyze path/to/video.mp4
/analyze S02E01 "C:\Movies\Episode.mp4"
/analyze S02E01 "C:\Movies\Episode.mp4" --skip-upload    # reuse existing GCS file
/analyze S02E01 "C:\Movies\Episode.mp4" --report-only    # just rebuild report
```

## Cost Estimate

- **~$2.50 per 45-minute episode** (Gemini 2.5 Pro, LOW resolution, 3 chunks)
- **~$5.00 per episode** at MEDIUM resolution
- ffmpeg scene detection: free (local)
- Frame extraction: free (local)

## Output Files

```
vstack-data/{EPISODE_ID}/
├── scenes.json              # Complete scene + shot metadata
├── scene-review-report.html # Interactive visual report
├── frames/                  # First/last frame JPEGs for every shot
├── chunk-0-15.json          # Raw Gemini response (chunk 1)
├── chunk-15-30.json         # Raw Gemini response (chunk 2)
└── chunk-30-45.json         # Raw Gemini response (chunk 3)
```
