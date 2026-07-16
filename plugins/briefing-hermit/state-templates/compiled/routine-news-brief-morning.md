---
title: "Routine: Morning News Brief"
type: routine-prompt
created: 2026-07-16T00:00:00+00:00
tags: [routine, briefing]
---

# Routine: Morning News Brief
# Fires: per config.json routines[] schedule (default 09:00 daily)
# Purpose: Forward-looking morning briefing from the source registry

## Task

Produce and deliver the morning briefing.

## Steps

1. Invoke `/briefing-hermit:news-brief --morning`.
2. The skill owns the full 7-phase pipeline (fetch → score → write → deliver → archive → summary) and delivers via the configured channel. If no channel is configured, it queues to `compiled/pending-delivery.md`.
3. Close session idle when the brief is delivered or queued.
