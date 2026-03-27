---
name: supercut
version: 0.1.0
description: Quick supercut builder — scan for specific visual moments, curate clips, and assemble a montage
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, WebSearch
---

# /supercut — Quick Supercut Builder

Creates supercut videos by scanning source footage for specific visual moments (smiles, explosions, reactions, etc.), letting you curate the best clips, and assembling them into a tight montage.

## Workflow

1. **Define what to find** — describe the visual moment to search for
2. **Scan source footage** — AI vision scans extracted clips at 1fps
3. **Generate contact sheet** — thumbnail grid of all detected moments
4. **User selects clips** — pick the best moments from the contact sheet
5. **Set clip duration** — typically 2-3 seconds for tight supercut pacing
6. **Add narration/interjections** — optional voiceover or short comments
7. **Choose music** — background track selection
8. **Assemble** — generates scenes.ts, narrationData.json, project config
9. **Render** — preview in Remotion Studio, then render to MP4

## Usage

```
/supercut "Picard smiling" --source "C:\Star Trek\*.mp4"
/supercut "explosions" --source "./movies/" --duration 2s
```

## Cost Estimate

- **~$5-15** for AI vision scanning (depends on number of source clips)
- Music generation: ~$0.50 (ElevenLabs)
- Rendering: free (local)
