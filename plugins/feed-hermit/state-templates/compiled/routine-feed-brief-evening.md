---
title: "Routine: Evening Brief"
type: routine-prompt
created: 2026-07-16T00:00:00+00:00
tags: [routine, brief]
---

# Routine: Evening Brief
# Fires: per config.json routines[] schedule (default 21:30 daily)
# Purpose: Backward-looking evening brief from the source registry

## Task

Produce and deliver the evening brief.

## Steps

1. Invoke `/feed-hermit:feed-brief --evening`.
2. The skill owns the full 7-phase pipeline and delivers via the configured channel; on send failure it queues to `compiled/pending-delivery.md`.
3. Close session idle when the brief is delivered or queued.
