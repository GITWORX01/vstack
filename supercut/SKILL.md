---
name: supercut
version: 0.2.0
description: Quick supercut builder — search the database for specific moments, curate clips, and assemble a montage
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, WebSearch
---

# /supercut — Quick Supercut Builder

Creates supercut videos by searching the analyzed video database for specific moments, letting you curate the best clips, and assembling them into a tight montage.

## Prerequisites

- Videos must be analyzed first (run `/analyze` on your source videos)
- SQLite database populated with scene/shot metadata
- Frame server running for visual review (`node lib/frame-server.mjs`)

## Workflow

1. **Define what to find** — describe the visual moment (e.g., "Picard smiling", "explosions", "Riker sitting down")
2. **Search the database** — AI expands your query into synonyms and searches across all analyzed episodes
   - Uses semantic search with query expansion (smile → grin, laugh, chuckle, amused, warm)
   - Searches shot descriptions, character expressions, dialogue, and tags
3. **Generate contact sheet** — thumbnail grid of all detected moments for visual review
4. **User selects clips** — pick the best moments from the contact sheet
5. **Set clip duration** — typically 2-3 seconds for tight supercut pacing
6. **Add narration/interjections** — optional voiceover or short comments (uses ElevenLabs)
7. **Choose music** — background track selection or generation
8. **Assemble** — generates scenes.ts and project config for Remotion
9. **Render** — preview in Remotion Studio, then render to MP4

## Search Examples

```
/supercut "every time Picard smiles" --source tng
/supercut "Worf being rude" --duration 2s
/supercut "Enterprise beauty shots" --source all
/supercut "dramatic close-ups" --characters "Data"
```

## How Search Works

The AI clip selector uses semantic search with query expansion:

1. Your intent ("Picard smiling") is expanded into multiple search groups:
   - Primary: smile, grin, beam (weight: 1.0)
   - Secondary: laugh, chuckle, amused (weight: 0.8)
   - Tertiary: warm, gentle, happy (weight: 0.6)
2. Each group runs an FTS5 search on the shots table
3. Results are scored and merged — shots matching more groups rank higher
4. Deduplication ensures each moment appears once

## Cost Estimate

- **Search**: Free (local SQLite queries)
- **Contact sheet generation**: Free (frame extraction)
- **Narration/interjections**: ~$0.50-1.00 (ElevenLabs)
- **Music generation**: ~$0.50 (ElevenLabs)
- **Rendering**: Free (local Remotion)
