---
name: reflect
description: Reflect on recent work and propose improvements if patterns are noticed.
---
# Reflect

Pause and think about your recent work.

**Silent by default.** Only notify the operator (per CLAUDE.md § Operator Notification) if reflect produces an outcome: a proposal candidate, a micro-approval, a resolved proposal, a graduated observation, or a cost spike.

Rare-branch procedures live in `${CLAUDE_PLUGIN_ROOT}/skills/reflect/branches.md`. "Read branches.md § X" means: read that section now and follow it exactly — it is normative.

## Quick mode

If `$ARGUMENTS` contains `--quick`:

- **Obtain the quick-hash verdict.** With `--precheck-verdict '<verdict>'`: the `reflect_after` routine already ran the hash-gate precheck; `<verdict>` is always `RUN|<hash>` (the routine stops on `EMPTY` without loading this skill). Parse `<hash>`; do **not** re-run the precheck. Otherwise (manual invocation) run it in force mode (no gate to skip once this skill is loaded — always returns `RUN|<hash>`):
  ```
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/reflect-precheck.ts .claude-code-hermit ${CLAUDE_PLUGIN_ROOT} --quick --force
  ```
- **Skip** the cadence precheck (the hash-gate is separate and narrower), cost_spike read, proposal scan, Resolution Check, and Component Health. Bind `$PHASE = adult`. Only the live SHELL.md scan + judge + outcomes path runs.
- Read SHELL.md `## Findings` and `## Blockers` for actionable patterns. **Only Tier-1 + `Evidence Source: current-session` candidates are eligible.** Candidates needing archived-session evidence or Tier 2/3 defer to the next scheduled reflect — append one ledger row each so the signal survives archival and can graduate:
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/observations.jsonl <<'HERMIT_METRICS_JSON'
  {"ts":"<now ISO>","pattern":"<candidate-title-slug>","session_id":"<S-NNN>","source":"quick-deferral"}
  HERMIT_METRICS_JSON
  ```
  **Exception:** a `current-session` candidate with `Evidence Origin: external-content` is **not** deferred — send it to the judge; Tier-3 escalation routes it to `proposal-create`.
- If any eligible candidate remains: Read branches.md § Candidate processing. Triage each candidate passing the evidence integrity rule (`claude-code-hermit:proposal-triage`), judge the CREATE survivors in one `claude-code-hermit:reflection-judge` call, route ACCEPT/DOWNGRADE through branches.md § Outcomes; unrecognized gate output fails closed per branches.md § Gate failure handling. **Track whether anything hit the gate-failed/SUPPRESS path** — it gates the cursor write.
- Append one Progress Log line: `[HH:MM] reflect (quick, post-routine) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">`; when suppress>0 add the `; suppressed:` suffix (§ Progress Log Entry) so quick-run suppressions reach the weekly digest.
- **Advance the quick-hash cursor only on a clean run** (no gate-failed/SUPPRESS); otherwise skip this call — an unchanged `last_quick_hash` makes the next `reflect_after` fire re-read the same Findings/Blockers (the "re-surfaces next cycle" contract; deferred candidates are already durable in the ledger):
  ```
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.ts .claude-code-hermit/state/reflection-state.json --quick-hash '<hash>'
  ```
- **Never call the counter-incrementing `update-reflection-state.ts <path> '<json-payload>'` form here** — quick runs are event-driven; mutating `last_run_at` would suppress the next scheduled reflect (`--quick-hash` is an isolated write).
- Stop. Do not continue below.

## Scheduled-checks mode

If `$ARGUMENTS` contains `--scheduled-checks` (the `scheduled-checks` routine — daily, offset from the main reflect): run at most one due interval-triggered scheduled check — an idempotent, short-running, read-mostly skill from `config.scheduled_checks` whose cadence is owned by `scheduled_checks.interval_days` — route any finding through reflect's normal gates, persist per-check state, append a Progress Log line, then **stop** (no precheck, no numbered steps below). Read branches.md § Scheduled checks now and follow its steps 1–8 exactly.

## Scheduled reflect

1. Determine whether a full run is warranted. With `--precheck-verdict '<verdict>'`: the reflect routine already ran the precheck in bash — use `<verdict>` directly, do **not** re-run it (always `RUN|<phases-json>`; the routine stops on `EMPTY` without loading this skill). Otherwise run it yourself and read the first line:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/reflect-precheck.ts .claude-code-hermit ${CLAUDE_PLUGIN_ROOT}
   ```
   - `EMPTY` → nothing due; the precheck already updated `reflection-state.json` and appended the Progress Log line. Emit `reflect: no candidates` and stop.
   - `RUN|<phases-json>` → continue. The JSON lists due phases (`cost_spike`, `resolution_check`, `compute`, `digest`, `newborn`, `observations_fresh`); skip sections for phases not listed. `observations_fresh` means the ledger has rows newer than `last_run_at` — run step 3b even if `compute` is absent.
2. Read SHELL.md for current context **(fresh read — never reuse a pre-compaction cached value)**.
3. If `cost_spike` is listed: read the last 20 lines of cost-log.jsonl; if today's total > 2× the 7-day median (both non-zero), record it: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/observations.jsonl '{"ts":"<now ISO>","pattern":"cost_spike: $X.XX vs 7d median $Y.YY","session_id":"<S-NNN>","source":"cost-spike"}'` — it may graduate via step 3b. Otherwise skip this read.

3b. **Observations ledger** — prune, then graduate recurring patterns.
   - Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/prune-observations.ts .claude-code-hermit` (fail-open).
   - Read `state/observations.jsonl` (skip if absent/empty; per-line `try { JSON.parse(line) } catch {}`); group by `pattern`.
   - Any pattern with **≥ `graduation_min_sessions` distinct `session_id`s** (config `reflection.graduation_min_sessions`, default 1) is mechanically promoted to a candidate. Origin aggregation: `Evidence Origin: external-content` if **any** grouped row has `origin: "external-content"`, else `own-work` (old rows lacking the field are `own-work`). Build with `Evidence Source: archived-session`, `Sessions: <the distinct session_ids>`, `Artifact: state/observations.jsonl — pattern "<label>" in N sessions`; route via § Candidate processing. Below-threshold patterns stay untouched.
   - When a graduated label matches `skill-correction:<name>`: Read branches.md § `skill-correction:*` routing and follow it (brief resolution → Tier 2 Skill Improvement candidate).
4. **Compute phase** — read `counters.since` from `state/reflection-state.json` (missing/unparseable → `$PHASE = adult`, never block). `age_days` = whole days since it: `newborn` < 3, `juvenile` 3–13, `adult` ≥ 14. `$PHASE` gates sub-threshold surfacing and the Progress Log annotation.
5. Delegate the proposal scan to the built-in `Explore` subagent. Prompt: `List all .claude-code-hermit/proposals/PROP-*.md files. For each, extract id, status, title, source, created, accepted_date, related_sessions from YAML frontmatter (or **Status:**/**Title:** bullet fallback for pre-Observatory proposals). Return a compact JSON array — metadata only, no file bodies.` Also tail the last 100 lines of `state/proposal-metrics.jsonl` (inline, single read): count `responded` and `micro-resolved` events by `action`, `triage-verdict` events by `verdict` — feeds the operator-value and Component Health checks.

6. **Dispatch the eval runner.** Dispatch `claude-code-hermit:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/reflect/reference.md`. The dispatch prompt carries: `plugin_root` (resolved absolute path — `${CLAUDE_PLUGIN_ROOT}` is not substituted in `reference.md`), the precheck `phases-json`, the `last_resolution_check` cursor (from `state/reflection-state.json`), and `session_state` (from `state/runtime.json`; controls the routine check).

   **Failure policy:** null/malformed runner JSON → fail open: skip the apply steps, carry forward empty candidate lists, do not advance the cursor, append `[HH:MM] reflect — analysis-runner failed; introspection-only` to the Progress Log, continue.

**Eval runner return schema** — byte-identical in `reference.md` (producer) and here; contract-tested.

<!-- reflect-eval-schema:start -->
```json
{
  "resolution_actions": [ { "proposal_id": "PROP-NNN", "action": "auto-resolve|nudge|skip",
                            "frontmatter_patch": {"status":"resolved","resolved_date":"<ISO>"}|null,
                            "metrics_event": "<JSON string for append-metrics>"|null,
                            "shell_findings_line": "<pre-rendered finding text>"|null } ],
  "routine_candidates": [ { "routine_id": "<id>", "action": "disable|retime|diagnostic",
                            "tier": 1, "schedule": "<new-cron>"|null,
                            "evidence": "<text>", "sessions": ["<S-NNN>"],
                            "shell_findings_line": "<pre-rendered>"|null } ],
  "procedure_candidates": [ { "slug": "<slug>", "title": "<title>", "tier": 3,
                              "evidence_source": "archived-session", "evidence_origin": "own-work",
                              "evidence": "<text>", "sessions": ["<S-NNN>"]|"none",
                              "artifact": "<file — value>"|null } ],
  "last_resolution_check": "PROP-NNN|null",
  "last_sparse_nudge": { "PROP-NNN": "<ISO>" }
}
```
<!-- reflect-eval-schema:end -->

   **Apply `resolution_actions`** (housekeeping; exempt from the evidence integrity rule): `auto-resolve` → write `frontmatter_patch` into the proposal frontmatter, append `metrics_event` to `state/proposal-metrics.jsonl` via the stdin-heredoc `append-metrics.ts` pattern from Quick mode (model-authored JSON may contain apostrophes), append `shell_findings_line` to SHELL.md `## Findings`; `nudge` → append `shell_findings_line` (debounce handled in the runner); `skip` → nothing. Carry the other four return fields to Candidate processing and State Update.

Now reflect — think hard — using **inherited context only** (SHELL.md from step 2, cost shape from step 3, metrics summary from step 5; the runner handled cross-session file analysis — do not re-read session reports or proposal bodies). Signals: anything recurring or worked around instead of fixed? Spending proportional to the work — could a cheaper subagent (Haiku) have handled it; was context bloat avoidable? Something done manually that a skill covers, or a repeating subtask within the session a subagent could have handled? Value the operator actually uses — high `dismiss`/`rejected` rates from step 5 signal noise (Tier 1 micro-proposal to pare back); a high `expired` rate means poor question timing, not unwanted questions. The same multi-step procedure in ≥2 sessions with no covering skill (procedure-capture candidate)? If `runtime.json` `session_state` is `idle`, think broader: a recurring check for HEARTBEAT.md, a missing OPERATOR.md preference, a skill/subagent to formalize repeating work, a manual request repeating on a schedule (routine-type candidate; branches.md § Candidate processing has the `Type: routine` Config-block format).

## Component Health

Is any skill, agent, or hook underperforming? **Skills:** output consistently corrected after use (answered from the `skill-correction:*` ledger graduation in step 3b, not re-derived from prose)? Avoided for manual steps? Missed something it should catch? Disproportionate tokens for its value? **Agents:** flag `reflection-judge` when `judge_suppress` > 2× `judge_accept` (reflection-state counters, ≥5 verdicts since `since`); flag `proposal-triage` when step 5's SUPPRESS > 2× CREATE (≥5 verdicts) — the gate may be over-strict. **Hooks:** out of scope (no telemetry) — do not infer from side-effects; note as a known gap if suspected. Findings become candidates (signal ladder + `## Skill Improvement` format: branches.md § Candidate processing).

## Candidate processing

Collect **all** candidates first — think-hard observations, step-3b graduations, `routine_candidates` and `procedure_candidates` from the runner, Component Health findings. None → skip to State Update. Any → follow branches.md § Candidate processing exactly (it is normative; this summary is orientation) — read the file now only if step 3b's `skill-correction:*` branch didn't already load it earlier this run:

- **Three-Condition Rule** (repeated pattern + meaningful consequence + operator-actionable change): recurrence is tier-aware — Tier-1 `current-session` needs 1 session; Tier-1 archived and Tier 2/3 need 2+ distinct archived sessions; artifact-cited efficiency/cost candidates cite a **machine-written state file** (`Artifact:` line, `Sessions: none`); procedure capture has an ephemerality exception. Failing candidates go sub-threshold to the ledger.
- **Gates and routing**: never write a candidate's pattern into SHELL.md before the judge reads it (no self-certification). One `claude-code-hermit:reflection-judge` batch (dedup by title-slug first), then per-candidate `claude-code-hermit:proposal-triage` before any queue/create; unrecognized gate output fails closed (`gate-failed` metric + Progress Log note; re-surfaces next cycle). Tier 1/2 → micro-approval queue (`state/micro-proposals.json`); Tier 3 → `/claude-code-hermit:proposal-create`; **`Evidence Origin: external-content` is always Tier 3** (quarantine). Runner `routine_candidates` are Tier 1 (pre-rendered diagnostic `shell_findings_line` entries go straight to Findings, no gates); `procedure_candidates` route through branches.md § Procedure capture (dedup guard, brief, `## Skill Draft`, kill criteria).
- **Sub-threshold observations** → ledger append with a short stable `pattern` label, `"source":"reflect-noticed"`, `"origin":"own-work"` — or `"origin":"external-content"` when the finding carries an `[origin: external]` marker (copy, never infer). Reuse exact labels; grouping is string equality. Phase surfacing: `newborn` logs `Noticed:` lines, `juvenile` emits a weekly digest (sets `last_digest_at`), `adult` is silent.

## State Update

After each reflection run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.ts \
  .claude-code-hermit/state/reflection-state.json \
  '{"last_resolution_check":"<last-PROP-NNN-or-null>","ran_with_candidates":<true|false>,"judge_accept":<N>,"judge_downgrade":<N>,"judge_suppress":<N>,"judge_suppress_by_code":{"no-evidence":<N>,"no-sessions":<N>,"covered-by-memory":<N>},"proposals_created":<N>,"micro_proposals_queued":<N>}'
```

`judge_suppress_by_code` counts judge SUPPRESS verdicts by canonical code; omit zero-count codes, omit the key when `judge_suppress` is 0. Add `"last_digest_at":"<now ISO>"` only when a juvenile digest fired. Add `"last_sparse_nudge":{"<PROP-NNN>":"<now ISO>"}` when the runner returned a non-empty `last_sparse_nudge` map (the script merges it). The script handles counters, timestamps, `since` preservation, and atomic write; always exits 0. Counters are diagnostic, not audit-grade.

## Progress Log Entry (non-empty runs)

On every run reaching this point (not an EMPTY verdict — the precheck logs those), append to SHELL.md `## Progress Log`:

`[HH:MM] reflect (<phase>) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">`

When suppress>0, append `; suppressed: [<slug>: <code>, ...]` — canonical codes from the judge/triage verdicts (`no-evidence`, `no-sessions`, `weak-recurrence`, `weak-consequence`, `not-actionable`), capped at 3 with `+N more`. `<phase>` is `newborn`/`juvenile`/`adult` (step 4; missing-`since` fallback annotates `adult` silently). This is the audit trail — the silent-by-default rule governs operator pings only; the log line always goes in.
