# vstack — AI Video Production Pipeline

A collection of Claude Code skills for creating narrated video essays, supercuts, and montages from source footage. Powered by Gemini 2.5 Pro (video analysis), ElevenLabs (TTS), ffmpeg (frame extraction), and Remotion (rendering).

## Available Skills

| Command | Purpose |
|---------|---------|
| `/analyze` | Analyze video files with Gemini 2.5 Pro — produces scene + shot + dialogue metadata |
| `/review` | Generate interactive Scene Review Report with live frame preview |
| `/narrate` | Write narration scripts + generate TTS audio via ElevenLabs |
| `/assign` | Match narration segments to the best video clips from analyzed footage |
| `/render` | Preview in Remotion Studio or render final video to MP4 |
| `/supercut` | Quick supercut builder — scan for specific moments, select, assemble |
| `/improve` | Analyze pipeline scripts and propose targeted improvements |
| `/project` | Initialize, save, load, and check status of video projects |

## Typical Workflow

```
/project init          → Set up a new video project with source files
/analyze               → AI-scan source footage (scene + shot metadata)
/review                → Visual review of analysis results
/narrate               → Write script + generate voiceover audio
/assign                → Match narration to best clips from analyzed footage
/review                → Review scene assignments, adjust timestamps
/render                → Preview and render final video
```

## Configuration

Projects use `vstack.config.json` in the working directory:

```json
{
  "project": "my-video",
  "gcsBucket": "gs://my-video-analysis",
  "gcpProject": "my-gcp-project",
  "model": "gemini-2.5-pro",
  "mediaResolution": "MEDIA_RESOLUTION_LOW",
  "chunkMinutes": 15,
  "elevenLabsVoice": "default",
  "budgetLimit": 100,
  "sourceDir": "./source-videos",
  "outputDir": "./out"
}
```

## Required API Keys

- `ANTHROPIC_API_KEY` — Claude API (narration matching, script writing)
- `GOOGLE_APPLICATION_CREDENTIALS` or `gcloud auth` — Gemini via Vertex AI
- `ELEVENLABS_API_KEY` — TTS narration generation

## Safety Rules

- **NEVER** `rm -rf` inside `public/` — hardlinked source files could be destroyed
- **ALWAYS** rebuild the review report after changing scenes.ts
- **ALWAYS** warn about costs before running expensive analysis passes
- Pipeline script modifications require explicit user approval
