---
name: review
version: 0.2.0
description: Generate and serve the interactive Scene Review Report with video playback, search, shot joining, and millisecond timestamp adjustment
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# /review — Interactive Scene Review Report

Generates and serves a browser-based visual report showing every scene and shot from an analyzed video. The primary editing interface for reviewing and correcting metadata.

## Features

### Scene Level
- Location, characters, mood, plot significance
- Lighting, music/score, costuming details
- Tags and supercut potential categories

### Shot Level
- **First/last frame thumbnails** for every shot
- Shot type badge (color-coded), duration, subject
- Action description, camera movement, character expressions
- **Speaker-attributed dialogue** with timestamps
- Tags and supercut potential

### Editing Tools
- **Video player** — floating panel, click any thumbnail to play that clip with audio
- **Search/filter** — find shots by keyword (filter by scenes, shots, or both)
- **Millisecond timestamp adjustment** — ±10ms, ±50ms, ±100ms for start AND end timestamps
- **Live frame preview** — see frames update in real-time as you adjust timestamps
- **Lock/Unlock** — lock corrected shots, update static thumbnails
- **Shot joining** — select multiple shots with checkboxes, join into one with conflict resolution dialog
- **Export corrections** — copy all adjustments to clipboard
- **Apply corrections** — `node lib/apply-corrections.mjs` updates scenes.json + re-extracts frames

### Navigation
- Jump-to-scene dropdown
- Keyboard shortcuts: Space (play/pause), ←→ (seek), ? (help)
- Settings dropdown showing all analysis parameters

## Prerequisites

- Analyzed video (run `/analyze` first)
- Frame server running for video playback and live preview

## Workflow

1. Start the vstack server: `node lib/frame-server.mjs`
2. Open the hub at `http://localhost:3333/`
3. Navigate to episode → click "Open Scene Review Report"
4. Or direct: `http://localhost:3333/{EPISODE_ID}/scene-review-report.html`
5. Review scenes and shots visually
6. Fix timestamps, join shots as needed
7. Export corrections → paste to Claude → apply

## Applying Corrections

When you export corrections from the report, paste them and Claude will apply them:
```
SCENE REVIEW CORRECTIONS
Episode: S02E01
Scene 1, Shot 3: start -30ms end -70ms [LOCKED]
Scene 4, Shot 2: end -50ms [LOCKED]
```

This runs `node lib/apply-corrections.mjs` which updates scenes.json and re-extracts affected frames.

## Usage

```
/review S02E01                    # Rebuild and open report
/review                           # Open the hub (all episodes)
```

## Cost

Free — all local processing.
