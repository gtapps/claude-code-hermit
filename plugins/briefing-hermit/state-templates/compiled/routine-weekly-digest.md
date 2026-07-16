---
title: "Routine: Weekly Digest"
type: routine-prompt
created: 2026-07-16T00:00:00+00:00
tags: [routine, briefing]
---

# Routine: Weekly Digest
# Fires: per config.json routines[] schedule (default Sunday 10:30)
# Purpose: 7-day synthesis over archived briefs + source-performance readout

## Task

Produce and deliver the weekly digest.

## Steps

1. Invoke `/briefing-hermit:weekly-digest`.
2. The skill synthesizes the past 7 days of archived briefs, computes per-source performance from archive frontmatter, aggregates any reaction feedback that exists, delivers via the configured channel, and archives to `briefings/weekly/`.
3. Close session idle when the digest is delivered or queued.
