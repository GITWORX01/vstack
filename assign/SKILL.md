---
name: assign
version: 0.2.0
description: Match narration segments to the best video clips using SQLite database search with AI semantic expansion
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

# /assign — Clip Assignment

Matches each narration segment to the best video clip from your analyzed footage. Searches the SQLite database across all analyzed episodes to find clips that match the emotional tone, visual content, and pacing of each sentence.

## How It Works

1. **Read narration data** — segments with text, timing, and audio file paths
2. **For each segment, the clip-matcher agent:**
   - Expands the narration text into semantic search queries
   - Searches the SQLite database (shots table) across all episodes
   - Scores results by emotional match, visual relevance, and variety
   - Avoids reusing the same clip or similar clips
3. **Generate scenes.ts** — Remotion config with SceneGroup entries pointing to source videos
4. **Validate** — check for gaps, overlaps, and missing clips
5. **Generate review report** — visual verification of all assignments

## Subagents

Uses the **clip-matcher** subagent with these matching rules:
- Default to 1 sentence per scene for fast, dynamic cuts
- Match EMOTION over literal keywords
- Isolate dramatic pivot sentences as solo scenes
- Never reuse the same clip timestamp
- Close-ups for emotional beats, wide shots for chapter cards
- Cross-source thematic parallels work well (clips from different episodes/movies)

## Output

```typescript
// scenes.ts — Remotion composition config
export const SCENES: SceneGroup[] = [
  { range: [0, 0], src: staticFile('movies/S02E01.mp4'), startSec: 1643 },
  { range: [1, 1], src: staticFile('movies/S05E25.mp4'), startSec: 856 },
  ...
];
```

Each SceneGroup maps a narration segment range to a specific source video + timestamp.

## Usage

```
/assign                    # Auto-assign all segments using DB search
/assign --interactive      # Approve each assignment before continuing
/assign --episode S02E01   # Only use clips from a specific episode
```

## Cost Estimate

- **~$3-5 total** (Claude API for matching logic)
- Database search: free (local SQLite)
