---
name: domain-brainstorm
description: On-demand dev-voice brainstorm — reads codebase friction signals (git churn, test signal, manifest drift, README coverage) and emits at most 2 improvement ideas, each gated by proposal-triage before becoming a PROP. Invoke when the operator asks "what should I be fixing?", "anything wrong with X?", or "brainstorm improvements". Never runs autonomously.
---

# Domain Brainstorm

## Kill criteria (read before running)

After ≥8 invocations, read `.claude-code-hermit/state/proposal-metrics.jsonl` and filter events where `type:"brainstorm-emit"` and `skill:"domain-brainstorm"`. Count CREATE vs total emits with ideas (triage-survival) and read `status:` of the resulting PROP files (PROP-acceptance). If triage-survival < 25% or PROP-acceptance < 30%, cut this skill rather than tune it — signal-to-noise isn't there.

### Gate 0 — Gather inputs

Read these in parallel — all are cheap working-tree reads. Do not run the test suite or install tools.

**Git activity**
```bash
git log --oneline -50
git log --format= --name-only -50 | sort | uniq -c | sort -rn | head -20
```
Note the 5 most-churned files and any subsystem clusters.

**Test signal**
Read `.claude-code-hermit/state/last-test.json` (written by `/dev-test`). Extract result, exit code, and duration. If absent or last-modified >24h ago, note "no recent test run" — do not run the suite.

**Manifest drift**
`ls` for `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`. For each found, check its lockfile (`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`, `go.sum`) exists alongside it. Flag any mismatch.

**README coverage**
Read `README.md` and a one-level `ls` of the repo root. Note features or modules claimed in the README with no corresponding directory or file visible.

### Gate 1 — Generate ideas (max 2)

Think across all four inputs. For each candidate, both constraints must pass before including it:

1. **Concrete friction** — state the operator pain in one sentence. What breaks, slows, or misleads today without this fix? If no specific pain, discard.
2. **≥2 named grounding items** — cite at least two by name (e.g. `git:cli/index.js`, `state:last-test.json duration=38s`, `file:package-lock.json missing`, `readme:§Feature X`). These support the friction; friction is the bar.

Map each passing idea to the closest dev prefix: `[missing-tests]`, `[tech-debt]`, `[dependency]`, `[tooling]`, or `[architecture]`.

Cap at 2 ideas. Emit-zero if none pass. Record discarded candidates (one line each) for Gate 4.

### Gate 2 — Create proposals

For each idea, invoke `/claude-code-hermit:proposal-create` once:

```
Title: [<prefix>] <short idea title>
Evidence Source: capability-brainstorm
Evidence: <one paragraph: friction sentence + named grounding items>
```

Set frontmatter: `source: auto-detected`, `category: improvement`.

> `Evidence Source: capability-brainstorm` is reused intentionally: it is the only source `proposal-triage` recognizes for the single-pass recurrence bypass, and adding a dedicated `domain-brainstorm` source is a core edit this skill deliberately avoids. The cost: domain-brainstorm proposals carry capability-brainstorm provenance to any consumer that buckets by evidence source. Per-skill kill metrics are unaffected (they read the `brainstorm-emit` events below, which are tagged `skill:"domain-brainstorm"`). If this skill graduates from pilot, promote it to a first-class triage bypass source.

Parse the verdict:
- `CREATE` — note PROP-NNN.
- `SUPPRESS — <code>` — record suppression code; don't retry.
- `DUPLICATE:<PROP-ID>` — record existing ID; don't create.

After each verdict, append a metrics event (Node stdlib, no deps):

```bash
node -e "const fs=require('fs'); fs.appendFileSync('.claude-code-hermit/state/proposal-metrics.jsonl', JSON.stringify({ts:new Date().toISOString(),type:'brainstorm-emit',skill:'domain-brainstorm',verdict:'<CREATE|SUPPRESS|DUPLICATE>',proposal_id:'<PROP-NNN or null>'})+'\n','utf-8');"
```

This event is what the kill-criteria audit reads — `proposal-create`'s own `created` event does not carry per-skill provenance.

Do NOT invoke `proposal-triage` directly — `/proposal-create` handles it.

### Gate 3 — Emit batch message

Send one message per the Operator Notification protocol in CLAUDE.md.

Zero-emit:
```
🔧 Domain brainstorm — 0 ideas emitted (<reason: thin context | all suppressed | all duplicates>)
```

Non-zero:
```
🔧 Domain brainstorm (<N> idea(s))

1. **[prefix] <title>** — <one-line description>
   _Grounding: <item 1>, <item 2>_
   _Friction: <one-sentence pain>_
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
