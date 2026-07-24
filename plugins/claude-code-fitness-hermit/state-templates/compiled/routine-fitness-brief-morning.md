---
title: "Routine: Morning Brief"
type: routine-prompt
created: 2026-07-24T00:00:00+00:00
tags: [routine, brief]
---

# Routine: Morning Brief
# Fires: per config.json routines[] schedule
# Purpose: Forward-looking daily brief — readiness + today's plan

## Steps

1. Invoke `/claude-code-fitness-hermit:fitness-brief --morning`.
2. The skill owns the full pipeline (connectivity check → gather → compose → deliver →
   archive) and delivers via the configured channel.
3. Close session idle when the brief is delivered.
