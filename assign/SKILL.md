---
name: assign
version: 0.1.0
description: Match narration segments to the best video clips from analyzed footage using AI scene matching
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

# /assign — Clip Assignment

Matches each narration segment to the best video clip from your analyzed footage. Uses the scene library (from `/analyze`) to find clips that match the emotional tone, visual content, and pacing of each sentence.

## Subagents

Uses the **clip-matcher** subagent with these matching rules:
- Default to 1 sentence per scene for fast, dynamic cuts
- Match EMOTION over literal keywords
- Isolate dramatic pivot sentences as solo scenes
- Never reuse the same clip timestamp
- Close-ups for emotional beats, wide shots for chapter cards
- Cross-source thematic parallels work well

## Workflow

1. Read narration data (segments + timing)
2. Load scene library from all analyzed sources
3. For each narration segment, search for matching clips
4. Generate scenes.ts with SceneGroup + Interstitial arrays
5. Run validation to check for errors
6. Generate review report for user verification

## Usage

```
/assign                    # Auto-assign all segments
/assign --interactive      # Approve each assignment
```

## Cost Estimate

- **~$3-5 total** (Claude API for matching logic)
