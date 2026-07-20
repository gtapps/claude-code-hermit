---
title: "Routine: Morning Brief"
type: routine-prompt
created: 2026-07-16T00:00:00+00:00
tags: [routine, brief]
---

# Routine: Morning Brief
# Fires: per config.json routines[] schedule (default 09:00 daily)
# Purpose: Forward-looking morning brief from the source registry

## Task

Produce and deliver the morning brief.

## Steps

1. Invoke `/feed-hermit:feed-brief --morning`.
2. The skill owns the full 7-phase pipeline (fetch → score → write → deliver → archive → summary) and delivers via the configured channel. If no channel is configured, it queues to `.claude-code-hermit/compiled/pending-delivery.md`.
3. Close session idle when the brief is delivered or queued.
