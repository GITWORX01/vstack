---
name: improve
version: 0.1.0
description: Analyze pipeline scripts and propose targeted improvements with diff preview and user approval
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

# /improve — Pipeline Improvement

Analyzes vstack's own pipeline scripts and proposes targeted improvements. Uses the **pipeline-improver** subagent to read script source code, understand the logic, and suggest changes.

## Safety

- All edits require explicit user approval (shown as diffs)
- Current state is committed via git before any modification
- Changes can be rolled back with `git checkout`

## Common Improvements

- **Prompt engineering** — improve Gemini analysis prompts for better metadata
- **Error handling** — add retry logic, better error messages
- **Performance** — increase concurrency, add caching
- **New flags** — add --dry-run, --verbose, --resume options
- **Edge cases** — fix timing calculations, handle unusual video formats

## Usage

```
/improve "The analysis is missing establishing shots — fix the Gemini prompt"
/improve "Add a --resume flag to analyze-episode.mjs"
/improve "The frame server crashes on large videos"
```

## Cost

Free (code analysis only). Rerunning modified passes costs normal API rates.
