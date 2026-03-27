---
name: review
version: 0.1.0
description: Generate and open an interactive Scene Review Report with live frame preview and millisecond timestamp adjustment
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# /review — Interactive Scene Review Report

Generates a browser-based visual report showing every scene and shot from an analyzed video. Includes live frame preview for timestamp correction with millisecond precision.

## Features

- **Scene + Shot cards** with first/last frame thumbnails
- **Metadata display** — shot type, subject, action, expressions, camera movement, tags
- **Speaker-attributed dialogue** shown inline (gold text, blue speaker names)
- **Timestamp adjustment** — ±10ms, ±50ms, ±100ms buttons for start AND end of each shot
- **Live frame preview** — click adjust buttons to see frames update in real-time via the frame server
- **Lock/Unlock** — lock in corrections, update the static thumbnails
- **Export corrections** — copy all adjustments to clipboard for application
- **Settings dropdown** — shows all Gemini parameters and processing steps used
- **Scene navigation** — jump-to-scene dropdown

## Prerequisites

- Analyzed video (run `/analyze` first)
- Frame server running (`node lib/frame-server.mjs`) for live preview

## Workflow

1. Start the frame server if not running
2. Rebuild the Scene Review Report from scenes.json
3. Open the report at `http://localhost:3333/{EPISODE_ID}/scene-review-report.html`
4. Review each scene and shot visually
5. Use adjustment controls to fix any timestamp misalignments
6. Lock in corrections and export

## Usage

```
/review S02E01                    # Rebuild and open report
/review S02E01 --server-only      # Just start the frame server
```

## Cost

Free — all local processing.
