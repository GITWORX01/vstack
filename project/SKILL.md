---
name: project
version: 0.1.0
description: Initialize, save, load, and check status of video projects
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# /project — Project Management

Manages video project lifecycle: initialization, configuration, snapshots, and status checks.

## Commands

### init
Create a new video project with source files and configuration.
```
/project init "my-documentary" --source "C:\Movies\*.mp4"
```

### status
Check what's configured and what pipeline steps have been completed.
```
/project status
```

### save
Save current project state as a named snapshot.
```
/project save "before-re-edit" --note "Good version, trying new clip order"
```

### load
Restore a previously saved snapshot.
```
/project load "before-re-edit"
```

### list
Show all saved snapshots.
```
/project list
```

## Configuration

Creates/updates `vstack.config.json` with:
- Project name and title
- Source video file paths
- GCS bucket and GCP project
- Model settings (resolution, chunk size)
- Budget limits
- Output directory

## Cost

Free — all local operations.
