---
title: "Routine: Evening Brief"
type: routine-prompt
created: 2026-07-24T00:00:00+00:00
tags: [routine, brief]
---

# Routine: Evening Brief
# Fires: per config.json routines[] schedule
# Purpose: Backward-looking daily brief — today's training (or earned rest) + tomorrow

## Steps

1. Invoke `/claude-code-fitness-hermit:fitness-brief --evening`.
2. The skill owns the full pipeline (sync + RPE/deep-dive mechanics → gather → compose →
   deliver → archive) and delivers via the configured channel.
3. Close session idle when the brief is delivered.
