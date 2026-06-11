---
name: domain-brainstorm
description: On-demand fitness-voice brainstorm — reads Strava history and training-goal signals to surface at most 2 coverage-gap or imbalance ideas, each gated by proposal-triage before becoming a PROP. Invoke when the operator asks "what am I neglecting?", "anything off with my training?", or "brainstorm training gaps". Never runs autonomously.
---

# Domain Brainstorm

## Kill criteria (read before running)

After ≥8 invocations, read `.claude-code-hermit/state/proposal-metrics.jsonl` and filter events where `type:"brainstorm-emit"` and `skill:"domain-brainstorm"`. Count CREATE vs total emits with ideas (triage-survival) and read `status:` of the resulting PROP files (PROP-acceptance). If triage-survival < 25% or PROP-acceptance < 30%, cut this skill rather than tune it — signal-to-noise isn't there.

### Gate 0 — Gather inputs

Start with the connection check; then read the remaining sources in parallel. Do not run tests or install tools.

**Connection check**
Call `mcp__strava__check-strava-connection`. If disconnected, stop immediately:
```
Domain brainstorm aborted — Strava disconnected. Reconnect and retry.
```

**Stated goals**
Read `MEMORY.md` (the index). For each entry whose title or description suggests goals, training preferences, or athlete profile, read that topic file. Extract stated goals and named disciplines (e.g. "marathon training", "strength 2×/week", "sleep 8h target"). If no goals are parseable from MEMORY.md, derive implicit goals from the Strava activity mix gathered below — note in every grounding citation that the goal is inferred, not stated.

**What's been logged**
Delegate bulk aggregation to `@claude-code-fitness-hermit:strava-data-cruncher`:
```
Last 8 weeks of activities. Return: per-week count + total minutes by sport/activity type. Flag any sport with zero sessions in the last 4 weeks.
```
This keeps heavy multi-page fetching off the main context and respects rate limits.

**Logged subjective and coverage signals**
Glob `.claude-code-hermit/compiled/activity-*.md` and any `.claude-code-hermit/compiled/weekly-*.md` files modified within the last 30 days — read the first 15 lines of each (frontmatter + opening paragraph). Read `state/activity-notes.json` to check which signal dimensions (RPE, sleep, macros) actually have entries vs gaps.

### Gate 1 — Generate ideas (max 2)

Think across all inputs simultaneously. For each candidate, both constraints must pass before including it:

1. **Concrete gap** — state the coverage or imbalance in one sentence: what goal or discipline has no recent supporting data, or what mix is visibly wrong vs stated goals? If no specific gap can be named, discard.
2. **≥2 named grounding items** — cite at least two by name (e.g. `memory:athlete-profile`, `strava:8wk strength=0sessions`, `notes:sleep last=21d ago`, `compiled:activity-2026-05-12`). These support the gap; the gap is the bar.

Map each passing idea to the closest fitness prefix:
- `[goal-gap]` — a stated or inferred goal with no recent supporting data. Covers: a discipline not logged in N weeks, sleep or macro dimensions the operator tracks but hasn't entered recently, a race/event goal with no recent specificity work.
- `[imbalance]` — training mix wrong vs stated or inferred goals. Covers: cardio/strength ratio skew, the same workout type repeated across multiple weeks with no progression toward a stated goal.

**Scoping guard:** never emit ideas about cardiac-drift trends, HR/pace efficiency slope, recovery-score trends, or week-over-week load changes — those signals are owned by `weekly-coaching-patterns` and `activity-deep-dive`. This skill emits coverage and imbalance gaps only.

Cap at 2 ideas. Emit-zero if none pass. Record discarded candidates (one line each) for Gate 4.

### Gate 2 — Create proposals

For each idea, invoke `/claude-code-hermit:proposal-create` once:

```
Title: [<prefix>] <short idea title>
Evidence Source: capability-brainstorm
Evidence: <one paragraph: gap sentence + named grounding items>
```

`Evidence Source: capability-brainstorm` is intentional, not a copy-paste: it is the recurrence-bypass token recognized by `proposal-create`'s three-condition rule (a brainstorm pass establishes the candidate, so condition 1 is waived). There is no separate `domain-brainstorm` token. Real provenance is carried by the `tags` below and the `brainstorm-emit` metrics event.

Set frontmatter: `source: auto-detected`, `category: improvement`, `tags: [domain-brainstorm, ideation]`.

Parse the verdict:
- `CREATE` — note PROP-NNN.
- `SUPPRESS — <code>` — record suppression code; don't retry.
- `DUPLICATE:<PROP-ID>` — record existing ID; don't create.

After each verdict, append a metrics event (Node stdlib, no deps):

```bash
bun -e "const fs=require('fs'); fs.appendFileSync('.claude-code-hermit/state/proposal-metrics.jsonl', JSON.stringify({ts:'<now ISO>',type:'brainstorm-emit',skill:'domain-brainstorm',verdict:'<CREATE|SUPPRESS|DUPLICATE>',proposal_id:'<PROP-NNN or null>'})+'\n','utf-8');"
```

Use the `config.json` timezone for `<now ISO>` (matching `proposal-create`), so this file isn't a mix of UTC and local timestamps. This event is what the kill-criteria audit reads — `proposal-create`'s own `created` event does not carry per-skill provenance.

Do NOT invoke `proposal-triage` directly — `/claude-code-hermit:proposal-create` handles it.

### Gate 3 — Emit batch message

Send one message per the Operator Notification protocol in CLAUDE.md.

Zero-emit:
```
🏋️ Domain brainstorm — 0 ideas emitted (<reason: thin context | all suppressed | all duplicates>)
```

Non-zero:
```
🏋️ Domain brainstorm (<N> idea(s))

1. **[prefix] <title>** — <one-line description>
   _Grounding: <item 1>, <item 2>_
   _Gap: <one-sentence friction>_
   PROP-NNN created  ·  (or: suppressed — <code>  ·  or: duplicate of PROP-NNN)
```

### Gate 4 — Compiled artifact (non-empty runs only)

If ≥1 PROP was created (not suppressed or duplicate), write:

`.claude-code-hermit/compiled/domain-brainstorm-YYYY-MM-DD-HHMM.md`

```yaml
---
title: Domain brainstorm — <ISO timestamp>
type: domain-brainstorm
created: <ISO timestamp with timezone>
tags: [domain-brainstorm, ideation]
source: interactive
proposals_created: [PROP-NNN, ...]
---
```

Body (150-line cap): ideas that passed (one paragraph each), discarded candidates (one line each), triage verdicts, inputs scanned (paths only, no content).

Do not tag `foundational` — this is a time-bounded ideation snapshot.

**Zero-emit runs:** skip the artifact entirely. Log one line to SHELL.md Findings:
`domain-brainstorm: 0 ideas emitted (<reason>)`
