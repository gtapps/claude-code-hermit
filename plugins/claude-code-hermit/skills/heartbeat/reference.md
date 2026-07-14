# Heartbeat — Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md `run` step 4.
The subagent reads only files (no inherited session context) and returns **judgment only** — which items
are currently firing, and a human-readable label for each. All bookkeeping (dedup, suppression,
resolution, the daily digest, monitoring lines, operator notifications, `last_clean_eval_at`, and
`heartbeat_result`) is derived deterministically by `update-alert-state.ts` from the returned firing set —
the subagent never authors any of it. This split exists because a small model (`heartbeat.model`,
haiku by default) intermittently fabricated that bookkeeping when it was asked to author it directly
(issue #594): inventing schema fields, garbling keys, and marking a still-pending micro-proposal
`suppressed:true` (which would have silently hidden a genuine pending operator decision).

This file is read only on the EVALUATE path, once the precheck determines a full LLM tick is warranted.

## Evaluation Steps

**1. Read inputs fresh** — do not reuse values cached from prior reads in this session.
- `.claude-code-hermit/HEARTBEAT.md` — the checklist items
- `.claude-code-hermit/sessions/SHELL.md` — for session `**ID:**`

**2. Per-item evaluation.** For each item in HEARTBEAT.md:
- **Default proposals item** (text references `proposals/` and `status: proposed`): skip it entirely.
  `update-alert-state.ts` derives its live state directly from `proposals/` frontmatter every tick,
  independent of anything returned here — there is nothing for you to evaluate or report.
- **Custom items** (disk thresholds, SQL checks, file patterns, etc.): apply LLM judgment using
  available project files and context needed to evaluate the condition. Produce a semantic key per
  the taxonomy table below.
- Collect all firing items with their keys and a short human-readable `text` label for each — see
  § Firing Item Text below for the required style. Items with no matching condition produce nothing.

**3. Self-evaluation:** follow § Self-Evaluation below (only on the every-20-ticks trigger).

**4. Return JSON** — see § Return Schema below for the required fields and exact format.

## Semantic Key Taxonomy

Produce one semantic key per firing item:

| Situation | Key format |
|-----------|-----------|
| Checklist item | `checklist:<first-8-chars-of-item-normalized>` |
| Waiting timeout | `waiting-timeout` |
| Custom / freeform | `custom:<first-100-chars-normalized>` — fallback only |

Normalise: lowercase, remove non-alphanumeric characters, truncate at the listed limit.

**Never** emit a `micro-proposal-pending:*` or `proposal-pending:*` key, or the `stale-session` key.
Those are derived and owned entirely by `update-alert-state.ts` — the two prefixes from
`state/micro-proposals.json` and `proposals/*.md` frontmatter, `stale-session` from `runtime.json` +
the bottom-most SHELL.md Progress Log timestamp — an entry you emit under any of them is dropped as
a phantom and has no effect.

## Firing Item Text

Each firing item's `text` is a channel-voice one-liner: plain language, the concrete condition first, no
internal IDs (no `PROP-NNN`, no session IDs, no file paths unless the item itself is about a file). It is
used verbatim in the SHELL.md monitoring line and, for a brand-new or newly-suppressed alert, in the
operator notification — write it for that audience, not as a debug note to yourself.

## Return Schema

Return exactly this JSON object — no prose, no markdown fences:

`{"firing": [{"key": "<semantic key>", "text": "<channel-voice one-liner>"}, ...], "self_eval_updates": {...}}`

Both keys are required. `firing` is `[]` when nothing is currently true — this is the normal "clean tick"
case; do not omit the key or return anything else in its place. `self_eval_updates` is `{}` outside the
every-20-ticks trigger (see below) — never omit it.

**Do NOT implement fixes — only report.**

**Exception:** Auto-close (`AUTO_CLOSE` precheck verdict, SKILL.md step 2) is the one fix heartbeat is authorized to apply. It runs as a terminal branch in the MAIN SESSION before the subagent is dispatched: the session has gone idle past the actionable threshold and archiving it is the correct response, not an alert. The subagent never handles AUTO_CLOSE.

## Self-Evaluation (every 20 ticks)

Triggered when `total_ticks % 20 === 0` (read from `state/alert-state.json` after the precheck has already incremented the counter).

1. Read `state/alert-state.json` for `self_eval{}` and `total_ticks`.
2. For each HEARTBEAT.md item: count alert lines for that item in the last 20 ticks (SHELL.md `## Monitoring`). If zero → increment `clean_ticks` and update `sessions_seen` / `last_session_id`. If alert fired → reset `clean_ticks` to 0.

   **`sessions_seen`:** number of distinct session IDs (from SHELL.md `**ID:**`) during which this item was evaluated. Incremented only when the current session ID differs from `last_session_id`.

   **Self-eval entry fields:** `text`, `clean_ticks`, `noise_ticks`, `sessions_seen`, `last_session_id`, `first_observed`, `proposed`.

2b. **Proposals scan (dismissal cleanup + noise tracking):** Scan `proposals/` for PROP-NNN files with `self_eval_key` in frontmatter. Apply in a single pass:
   - **Dismissal cleanup** (all items, every pass): if `source: auto-detected`, `status: dismissed`, and `proposed: true` → reset `proposed: false` and `clean_ticks` to 0.
   - **Noise tracking** (items that fired alerts in last 20 ticks only): if `status: accepted|resolved` → reset `noise_ticks` to 0; if `status: dismissed` → increment `noise_ticks` by 1.

3. **Checklist weight:** If HEARTBEAT.md has > 10 items: track in `self_eval` with text `"Checklist weight: {N} items"`.

4. **Proposal threshold check:** For each `self_eval` entry where `proposed: false`:
   - `clean_ticks >= 20` AND `sessions_seen >= 3` → include a proposal request in `self_eval_updates` with `proposed: true` and a `proposal_args` block (category: `capability`, `source: auto-detected`, `self_eval_key: <key>`, evidence: clean-for-N-ticks pattern). The calling main session invokes `/claude-code-hermit:proposal-create` with those args.
   - `noise_ticks >= 20` AND `sessions_seen >= 3` → same, noisy-alert pattern.
   - Checklist weight violation: same threshold.

5. **No channel message. No SHELL.md append.** Output flows through `self_eval_updates` in the return JSON only.
6. Include updated `self_eval{}` entries in `self_eval_updates` in the return JSON.
