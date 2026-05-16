# Heartbeat — Evaluation Reference

This file is read only on the EVALUATE path, once the precheck determines a full LLM tick is warranted.

## Semantic Key Taxonomy

Produce one semantic key per alert:

| Situation | Key format |
|-----------|-----------|
| Stale focus | `stale-focus` |
| Checklist item | `checklist:<first-8-chars-of-item-normalized>` |
| Proposal pending | `proposal-pending:<PROP-NNN>` |
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
5. **Micro-proposal check:** Read `state/micro-proposals.json → pending`. For each entry where `status === "pending"` and `tier === 1`: append `[HH:MM] Heartbeat: micro-proposal '{id}' awaiting operator input — {question}`. Use key `micro-proposal-pending:<id>` for dedup.
6. Write `state/alert-state.json`. **Write `alerts{}` and `self_eval{}` only — do NOT write `total_ticks` (owned by the precheck script).**

## If nothing actionable

- Do NOT append to SHELL.md.
- Read config `heartbeat.show_ok`: if `true`, notify the operator "Heartbeat OK"; if `false` (default), no channel message.
- Respond "HEARTBEAT_OK".

## If something found

- Append findings to SHELL.md `## Monitoring` (subject to dedup above).
- Notify the operator (under 5 lines).
- Respond "HEARTBEAT_ALERT".

**Do NOT implement fixes — only report.**

## Self-Evaluation (every 20 ticks)

Triggered when `total_ticks % 20 === 0` (read from `state/alert-state.json` after the precheck has already incremented the counter).

1. Read `state/alert-state.json`.
2. For each HEARTBEAT.md item: count alert lines for that item in the last 20 ticks. If zero → increment `clean_ticks` and update `days_seen` / `last_day`. If alert fired → reset `clean_ticks` to 0.

   **`days_seen`:** number of distinct working days (UTC date stamps) during which this item was evaluated. Incremented only when today's date differs from `last_day`.

   **Self-eval entry fields:** `text`, `clean_ticks`, `noise_ticks`, `days_seen`, `last_day`, `first_observed`, `proposed`.

2b. **Proposals scan (dismissal cleanup + noise tracking):** Scan `proposals/` for PROP-NNN files with `self_eval_key` in frontmatter. Apply in a single pass:
   - **Dismissal cleanup** (all items, every pass): if `source: auto-detected`, `status: dismissed`, and `proposed: true` → reset `proposed: false` and `clean_ticks` to 0.
   - **Noise tracking** (items that fired alerts in last 20 ticks only): if `status: accepted|resolved` → reset `noise_ticks` to 0; if `status: dismissed` → increment `noise_ticks` by 1.

3. **Checklist weight:** If HEARTBEAT.md has > 10 items: track in `self_eval` with text `"Checklist weight: {N} items"`.

4. **Proposal threshold check:** For each `self_eval` entry where `proposed: false`:
   - `clean_ticks >= 20` AND `days_seen >= 3` → propose via `/claude-code-hermit:proposal-create` (category: `capability`, `source: auto-detected`, `self_eval_key: <key>`, evidence: clean-for-N-ticks pattern).
   - `noise_ticks >= 20` AND `days_seen >= 3` → propose (same path, noisy-alert pattern).
   - Checklist weight violation: same threshold.
   - Set `proposed: true` after creating either proposal type.

5. **No channel message. No SHELL.md append.** Output flows through proposal pipeline only.
6. Write `state/alert-state.json` (`alerts{}` and `self_eval{}` only — not `total_ticks`).
