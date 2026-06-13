---
name: capability-brainstorm
description: On-demand hermit-voice brainstorm — synthesizes memory, available capabilities, recent compiled artifacts, and codebase shape into at most 2 capability ideas, each gated by proposal-triage before becoming a PROP. Invoke when the operator explicitly asks the hermit to brainstorm capabilities or ideate, e.g. "brainstorm capabilities", "what could you be doing for me?", "any capability ideas?". Never runs autonomously.
---

# Capability Brainstorm

## Kill criteria (read before running)

After ≥8 invocations, run:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal-metrics-report.ts .claude-code-hermit --source=capability-brainstorm
```

Triage-survival < 25% or acceptance < 30% → cut this skill rather than tune it — the signal-to-noise ratio isn't there. `INSUFFICIENT` output means the ≥8-verdict sample hasn't been reached yet; wait and re-check.

## 1. Gather inputs

Read all four sources in parallel — they are independent.

**Memory**
Read `MEMORY.md` (the index). For each entry whose title or description keyword-matches the current project domain or recent session topics, read that topic file. Aim for 3–5 relevant files; don't read the full corpus.

**Capabilities** (issue these three reads simultaneously)
- *Skills:* use the harness available-skills list loaded in your context — that is authoritative. Sibling-scan `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json` for plugin presence and version metadata only (not skill lists).
- *MCPs:* call `ListMcpResourcesTool` to enumerate currently online MCP tools.
- *Channels:* read `config.json` → `channels` keys.

**Compiled artifacts**
Glob `.claude-code-hermit/compiled/*.md`. For files modified within the last 30 days, read the first 15 lines only (covers frontmatter + opening paragraph). Skip files older than 30 days.

**Codebase shape**
Read repo `README.md`, `CLAUDE.md`, and `ls` of the repo root (one level deep, no recursion).

## 2. Generate ideas (max 2)

Think across all four inputs simultaneously. For each candidate idea, apply both constraints before including it:

1. **Concrete friction** — state the operator pain in one sentence: what happens today that this would fix or prevent. If you cannot name a specific pain (not "combines A and B usefully"), discard the idea.
2. **≥2 named grounding items** — cite at least two specific items by name (e.g., `memory:user_dev_workflow.md`, `mcp:Hassio.executar_bom_dia`, `skill:weekly-review`, `plugin:claude-code-fitness-hermit`). These are supporting evidence, not a checklist — the friction is the bar.

Cap at 2 ideas that pass both constraints. Emit-zero if none do. Record discarded ideas (one line each) for the artifact.

## 3. Create proposals (single-pass via `/claude-code-hermit:proposal-create`)

For each generated idea, invoke `/claude-code-hermit:proposal-create` once with:

```
Title: <short idea title>
Evidence Source: capability-brainstorm
Evidence: <one-paragraph summary: friction + grounding items>
```

Set the PROP frontmatter:
- `source: auto-detected`
- `category: capability`
- `tags: [capability-brainstorm, ideation]`

`/claude-code-hermit:proposal-create` invokes `proposal-triage` internally. Parse its outcome:
- `CREATE` — PROP file written, note the assigned PROP-NNN.
- `SUPPRESS — <code>` — record the suppression code. Don't retry.
- `DUPLICATE:<PROP-ID>` — record the existing PROP-ID. Don't create.

Do NOT invoke `proposal-triage` directly in this skill — `/claude-code-hermit:proposal-create` already does it.

## 4. Emit batch message

Send one message following the Operator Notification protocol in CLAUDE.md (empty channels → optional `PushNotification` + conversation; configured channel → resolve + reply, with `PushNotification` last-resort and `channel-send-unavailable` dedup on miss):

```
🧠 Capability brainstorm (<N> idea(s))

1. **<short title>** — <one-line description>
   _Grounding: <item 1>, <item 2>_
   _Friction: <one-sentence pain>_
   _Estimated effort: <hours|days>_
   PROP-NNN created  ·  (or: suppressed — <code>  ·  or: duplicate of PROP-NNN)

2. **<short title>** — ...
```

If zero ideas were generated or all were suppressed/duplicated, the message is:
```
🧠 Capability brainstorm — 0 ideas emitted (<reason: thin context | all suppressed | all duplicates>)
```

## 5. Write compiled artifact (non-empty runs only)

If ≥1 PROP was created (not suppressed/duplicate), write:

`.claude-code-hermit/compiled/capability-brainstorm-YYYY-MM-DD-HHMM.md`

Frontmatter:
```yaml
---
title: Capability brainstorm — <ISO timestamp>
type: capability-brainstorm
created: <ISO timestamp with timezone>
tags: [capability-brainstorm, ideation]
source: interactive
proposals_created: [PROP-NNN, ...]
---
```

Body (150-line cap):
- Ideas that passed generation and triage — one paragraph each.
- Discarded ideas — one line each (no grounding, no concrete friction).
- Triage verdicts for each emitted idea (CREATE / SUPPRESS — code / DUPLICATE:ID).
- Inputs scanned — titles/paths only, no content.

Do not tag `foundational` — this is a time-bounded ideation snapshot.

**Zero-emit runs:** skip the artifact entirely. Log one line to SHELL.md Findings:
`capability-brainstorm: 0 ideas emitted (<reason>)`
