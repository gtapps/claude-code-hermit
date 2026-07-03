# Heartbeat — Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md `run` step 4.
The subagent reads only files (no inherited session context); writes and notifications are handled by the
calling main session after it receives the subagent's structured JSON return value. Where an instruction
below says "append to Monitoring", "notify the operator", or "write alert-state.json", populate the
corresponding field in the return JSON instead — the main session applies those actions.

This file is read only on the EVALUATE path, once the precheck determines a full LLM tick is warranted.

## Evaluation Steps

**1. Read inputs fresh** — do not reuse values cached from prior reads in this session.
- `.claude-code-hermit/HEARTBEAT.md` — the checklist items
- `.claude-code-hermit/config.json` — for `heartbeat.stale_threshold` (default `"2h"`)
- `.claude-code-hermit/state/runtime.json` — for `session_state`, `session_id`
- `.claude-code-hermit/state/alert-state.json` — for `alerts{}`, `self_eval{}`, `total_ticks`, `last_digest_date`
- `.claude-code-hermit/state/micro-proposals.json` — for pending micro-proposals
- `.claude-code-hermit/sessions/SHELL.md` — for last Progress Log entry timestamp and session `**ID:**`

**2. Stale-session check.** If `session_state === 'in_progress'` in `runtime.json`:
- Find the most recent `[HH:MM]` timestamp in SHELL.md `## Progress Log`.
- Parse `heartbeat.stale_threshold` from config (default `"2h"`). Compute elapsed since that timestamp (current wall-clock time minus parsed timestamp).
- If elapsed > stale_threshold: add `stale-session` to the firing-alert set (key: `stale-session`).

**3. Per-item evaluation.** For each item in HEARTBEAT.md:
- Determine whether the described condition is currently true.
- Default proposals item (text references `proposals/` and `status: proposed`): normally resolved by `heartbeat-precheck.ts` filesystem-side, so a clean queue never reaches this EVALUATE. When it does: scan `proposals/` for any `PROP-NNN-*.md` file whose frontmatter contains `status: proposed`; alert if any found, keyed `proposal-pending:<PROP-NNN>` per proposal. Also run resolution detection — for any existing `proposal-pending:<PROP-NNN>` alert whose proposal is no longer `status: proposed` (accepted/resolved/deferred/dismissed, or the file is gone), advance its `consecutive_clean` toward resolution. (The precheck never writes `alerts{}`; this suppression/resolution bookkeeping is skill-owned.)
- Custom items (disk thresholds, SQL checks, file patterns, etc.): apply LLM judgment using available project files and context needed to evaluate the condition. Produce a semantic key per the taxonomy table below.
- Collect all firing items with their keys. Items with no matching condition produce no alert.

**4–7. Dedup, micro-proposals, self-eval, return JSON:** follow §Alert Deduplication, §Self-Evaluation, and §If nothing actionable / §If something found below.

## Semantic Key Taxonomy

Produce one semantic key per alert:

| Situation | Key format |
|-----------|-----------|
| Stale session | `stale-session` |
| Checklist item | `checklist:<first-8-chars-of-item-normalized>` |
| Proposal pending | `proposal-pending:<PROP-NNN>` |
| Waiting timeout | `waiting-timeout` |
| Micro-proposal pending | `micro-proposal-pending:<id>` |
| Custom / freeform | `custom:<first-100-chars-normalized>` — fallback only |

Normalise: lowercase, remove non-alphanumeric characters, truncate at the listed limit.

## Alert Deduplication

Before appending any alert to SHELL.md Monitoring:

1. Read `.claude-code-hermit/state/alert-state.json`.
2. Look up the alert's semantic key in `alerts{}`:
   - **Not found:** Add entry `{count:1, consecutive_clean:0, suppressed:false, first_seen:<today>, last_seen:<today>, text:<text>}`. Append to Monitoring normally.
   - **count < 5:** Increment `count`, reset `consecutive_clean` to 0, update `last_seen`. Append to Monitoring normally.
   - **count === 5:** Increment `count`, set `suppressed:true`, reset `consecutive_clean` to 0. Append once: `[HH:MM] Heartbeat: above alert suppressed after 5 fires (first: {first_seen}). Daily digest only.` Notify the operator.
   - **count > 5:** Increment `count`, reset `consecutive_clean` to 0, update `last_seen`. Do NOT append to Monitoring.
3. **Resolution detection:** After evaluating all items, for each entry in `alerts{}` that did NOT fire this tick: increment `consecutive_clean`. If `consecutive_clean >= 2`:
   - **Not suppressed:** Append `[HH:MM] Heartbeat: resolved — {text}`. Remove entry.
   - **Suppressed:** Resolve silently — remove entry, omit from next daily digest.
4. **Daily digest:** If `last_digest_date` is not today and suppressed alerts exist: notify the operator `Suppressed alert digest: {list with counts and ages}`. Set `last_digest_date` to today.
   - **Proposal entries:** For any suppressed key matching `proposal-pending:<PROP-NNN>`, render it as `PROP-NNN "<title>"` rather than the raw key. Find the title by reading frontmatter `title` from `proposals/PROP-NNN-*.md` (also check legacy `proposals/PROP-NNN.md`). If exactly one file matches, render its title; on zero or multiple matches, fall back to the bare key — never block the digest.
5. **Micro-proposal check:** Read `state/micro-proposals.json → pending`. For each entry where `status === "pending"` and `tier === 1`: include a monitoring line `[HH:MM] Heartbeat: micro-proposal '{id}' awaiting operator input — {question}` in `shell_monitoring_lines`. Use key `micro-proposal-pending:<id>` for dedup.
6. **Return JSON** (do NOT write files or send notifications directly): include `new_entries`, `updated_entries`, `resolved_keys`, `last_clean_eval_at`, `self_eval_updates`, `shell_monitoring_lines`, `operator_message`, `heartbeat_result`. The calling main session applies all writes.

## If nothing actionable

- `shell_monitoring_lines`: empty.
- `last_clean_eval_at`: current ISO timestamp. This seeds the clean-recheck damper so the precheck can return `OK` directly for subsequent ticks within the cooldown.
- `operator_message`: null.
- `heartbeat_result`: `"OK"`.

## If something found

- `shell_monitoring_lines`: dedup-filtered monitoring lines (subject to dedup above).
- `operator_message`: summary under 5 lines.
- `last_clean_eval_at`: null — belt-and-suspenders hygiene so the damper clock always reflects the last *fully clean* eval. The precheck's active-follow-up guard is the primary defense; this clear covers the narrow window between an alert resolving and `alerts{}` emptying.
- `heartbeat_result`: `"ALERT"`.

**Do NOT implement fixes — only report.**

**Exception:** Auto-close (`AUTO_CLOSE` precheck verdict, SKILL.md step 2) is the one fix heartbeat is authorized to apply. It runs as a terminal branch in the MAIN SESSION before the subagent is dispatched: the session has gone idle past the actionable threshold and archiving it is the correct response, not an alert. The subagent never handles AUTO_CLOSE.

## Self-Evaluation (every 20 ticks)

Triggered when `total_ticks % 20 === 0` (read from `state/alert-state.json` after the precheck has already incremented the counter).

1. Read `state/alert-state.json`.
2. For each HEARTBEAT.md item: count alert lines for that item in the last 20 ticks. If zero → increment `clean_ticks` and update `sessions_seen` / `last_session_id`. If alert fired → reset `clean_ticks` to 0.

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
6. Include updated `self_eval{}` entries in `self_eval_updates` in the return JSON (`alerts{}` and `last_clean_eval_at` are handled by the main eval path, not here).
