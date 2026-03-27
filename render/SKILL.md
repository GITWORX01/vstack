---
name: render
version: 0.1.0
description: Preview video in Remotion Studio or render final MP4 output
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# /render — Preview + Render

Launches Remotion Studio for live preview or renders the final video to MP4.

## Prerequisites

- Remotion project initialized (scenes.ts, narrationData.json, etc.)
- Source video files accessible
- Node.js + npm installed

## Workflow

### Preview
1. Kill any stale Remotion Studio processes
2. Launch `npx remotion studio` on configured port
3. Open browser to preview

### Render
1. Run `npx remotion render MainVideo out/video.mp4`
2. Report file size and duration

## Usage

```
/render preview            # Launch Remotion Studio
/render                    # Render final MP4
/render --output out/v2.mp4 --concurrency 4
```

## Cost

Free — all local rendering.
