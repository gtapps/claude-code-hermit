---
name: hermit-evolution
description: "Show how this hermit has evolved: cost trend and source split, routines and watches, top things produced, and what grew since hatch. Activates on messages like 'how am I trending', 'cost trend', 'evolution report', 'am I improving', 'proposal velocity', 'monthly report', 'what did I produce last month'."
---
# Hermit Evolution

Synthesize a coherent evolution report: cost trend and source split, autonomy and proposal velocity, active routines and watches, top things produced last month, and what grew organically since hatch.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation.

## Step 1 — Dispatch the eval runner

Dispatch `claude-code-hermit:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/hermit-evolution/reference.md`. The runner reads the weekly review files, proposal metrics, config, session reports, and OPERATOR.md — and runs `proposal-metrics-report.ts` and `cost-reflect.ts` — in an isolated context, then returns the assembled evolution report. This keeps those heavy reads off this session's inherited context.

Pass `plugin_root: ${CLAUDE_PLUGIN_ROOT}` in the dispatch prompt — the runner reads `reference.md` as file content, where `${CLAUDE_PLUGIN_ROOT}` is never substituted, so it needs the resolved absolute path to run the scripts and read template/skill paths.

**Eval runner return schema** — the runner's return value is a JSON object conforming to this block. The schema is byte-identical in `reference.md` (producer) and here (consumer); a contract test asserts this.

<!-- hermit-evolution-eval-schema:start -->
```json
{
  "report": "<assembled ≤1500-char report, section structure above>"
}
```
<!-- hermit-evolution-eval-schema:end -->

**Failure policy:** if the runner returns null or malformed JSON, fail-open — deliver a one-line "hermit-evolution: snapshot unavailable (analysis-runner failed)" via the Step 0 target and stop.

## Step 2 — Deliver

Deliver the runner's `report` verbatim (≤1500 chars) via the Step 0 target. The runner already omits empty sections; do not re-synthesize. For reference, the report uses this section structure:

```
### Cost
- Trend (weekly): $A → $B → $C → $X (Δ +/-N%)
- Last 30d: $X.XX total — scheduled (routines/heartbeat): $Y (N%), interactive: $Z (N%)

### Autonomy
- Self-directed: N% this week (vs M% prior, Δ +/-N pp)

### Proposal velocity
- Median resolution: Nd (N proposals, last 30d)
[acceptance-by-source table, rows n>0 only; note triggered kill gates]

### Routines & watches
- heartbeat: every X
- <routine-id>: <cron> · fired N× in last 30d
- watch <monitor-id>: active

### Top-3 produced (inferred)
- <one-line description>
(inferred — no operator-used signal exists)

### Grown since hatch (approximated)
- OPERATOR.md: <sections added, or "no additions vs template">
- Skills: <project-local skill names, or "none">
(approximated — no hatch baseline stored)
```
