---
name: reflect
description: Reflect on recent work and propose improvements if patterns are noticed.
---
# Reflect

Pause and think about your recent work.

This skill is **silent by default**. Only notify the operator (per the channel policy in CLAUDE.md § Operator Notification) if reflect produces an outcome: a proposal candidate, a micro-approval, a resolved proposal, a graduated sub-threshold observation, or a cost spike.

## Quick mode

If `$ARGUMENTS` contains `--quick` (invoked as `/claude-code-hermit:reflect --quick`):

- **Obtain the quick-hash verdict:**
  - **If `$ARGUMENTS` contains `--precheck-verdict '<verdict>'`**: the `reflect_after` routine's CronCreate prompt already ran the hash-gate precheck in bash and passed its verdict here. `<verdict>` is always a `RUN|<hash>` line — the routine stops on `EMPTY` without invoking this skill, so a no-op fire never loads this file. Parse `<hash>` from the verdict and do **not** re-run the precheck.
  - **Otherwise** (manual `/reflect --quick`, or any invocation without the flag): run the precheck yourself in force mode — there is no gate to skip once this skill is already loaded, only a hash to obtain:
    ```
    bun ${CLAUDE_PLUGIN_ROOT}/scripts/reflect-precheck.ts .claude-code-hermit ${CLAUDE_PLUGIN_ROOT} --quick --force
    ```
    This always returns `RUN|<hash>`. Parse `<hash>` from it.
- **Skip the cadence precheck** entirely — the scheduled-reflect cadence gate (`RUN|<phases-json>`) does not apply to quick mode; the hash-gate above is a separate, narrower mechanism.
- **Bind `$PHASE = adult`** — skip the compute phase eval.
- **Skip the cost_spike read, proposal scan, Resolution Check, and Component Health section.** Only the live SHELL.md scan + judge + outcomes path runs.
- Read SHELL.md `## Findings` and `## Blockers` for actionable patterns. **Only Tier-1 + `Evidence Source: current-session` candidates are eligible** — see § Three-Condition Rule, condition 1. Candidates that would need archived-session evidence or belong to Tier 2/3 are deferred to the next scheduled reflect — append one ledger entry per deferred candidate via stdin heredoc:
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/observations.jsonl <<'HERMIT_METRICS_JSON'
  {"ts":"<now ISO>","pattern":"<candidate-title-slug>","session_id":"<S-NNN>","source":"quick-deferral"}
  HERMIT_METRICS_JSON
  ```
  so the signal survives session archival and can graduate by recurrence (§ Outcomes). **Exception:** a `current-session` candidate with `Evidence Origin: external-content` (see § Proposal Tier Classification) is **not** deferred — send it to the judge and let the Tier-3 escalation route it to `proposal-create`.
- For each candidate that passes the evidence integrity rule, run `claude-code-hermit:proposal-triage`. Collect candidates where triage returned CREATE, then make a single `claude-code-hermit:reflection-judge` call for those candidates (see § Evidence Validation for input/output format). Route each ACCEPT/DOWNGRADE verdict through the standard Outcomes path (micro-approval queue for Tier 1/2, `/claude-code-hermit:proposal-create` for Tier 3). An unrecognized triage or judge verdict (empty/malformed output) is treated as a SUPPRESS — drop the candidate and apply the gate-failed metric and Progress Log note (see § Proposal triage gate and § Evidence Validation for the append commands). **Track whether any candidate hit this gate-failed/SUPPRESS path this run** — it gates the cursor write below.
- Append one Progress Log line: `[HH:MM] reflect (quick, post-routine) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">`. When suppress>0, append the same `; suppressed: [<slug>: <code>, ...]` suffix the scheduled path uses (see § Progress Log Entry) so quick-run suppressions reach the weekly digest.
- **Advance the quick-hash cursor, but only on a clean run.** If no candidate hit the gate-failed/SUPPRESS path this run, commit the hash obtained above so the next `reflect_after` fire can skip an unchanged scan:
  ```
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.ts .claude-code-hermit/state/reflection-state.json --quick-hash '<hash>'
  ```
  **If any candidate hit gate-failed/SUPPRESS this run, skip this call** — leave `last_quick_hash` at its previous value so the next `reflect_after` fire re-reads the same Findings/Blockers, matching the "the candidate re-surfaces on the next reflect cycle" contract used elsewhere in this skill (§ Evidence Validation, § Proposal triage gate). Deferred candidates (the quick-deferral bullet above) do not need this protection — they are already durable in `observations.jsonl` independent of this cursor.
- **Do not call the counter-incrementing `update-reflection-state.ts <path> '<json-payload>'` form** — quick runs are event-driven, not cadence ticks. Mutating `last_run_at` would suppress the next scheduled reflect. Consequence: judge verdicts from quick runs do not accumulate into the Component Health counters (`judge_accept` / `judge_suppress`); on daemons with frequent `reflect_after` use, those counters will under-represent total judge activity. This is intentional — cadence preservation wins. (The `--quick-hash` form above is a distinct, isolated write and does not touch `last_run_at`/counters.)
- Then stop. Do not continue to the scheduled-reflect steps below.

## Scheduled-checks mode

If `$ARGUMENTS` contains `--scheduled-checks` (invoked as `/claude-code-hermit:reflect --scheduled-checks` by the `scheduled-checks` routine — daily, offset from the main reflect): run at most one due interval-triggered scheduled check, route any finding through reflect's normal gates, persist per-check state, append a Progress Log line, then **stop** — do not run the precheck or the numbered steps below.

**Scheduled-check contract.** A scheduled check is any skill registered in `config.scheduled_checks` that is idempotent (safe to run twice), returns findings or nothing, does not self-schedule (cadence is owned by `scheduled_checks.interval_days`), and is short-running/read-mostly (no blocking, no side effects on success).

1. **Load.** Read `config.json → scheduled_checks` (filter to `enabled: true`, `trigger: "interval"`). Read `state/reflection-state.json → scheduled_checks` (per-check `last_run`, `last_unavailable_at`, `last_error_at`, `consecutive_empty`).
2. **Filter due.** Keep enabled interval entries where: `last_run` is null or older than `interval_days` days, AND `last_unavailable_at` is null or older than **4 hours** (transient cooldown), AND `last_error_at` is null or older than `interval_days` days (persistent back-off for true errors).
3. **Pick one.** Select the entry with the oldest `last_run` (null sorts first). If none are due → skip to the Progress Log (step 8) with outcome `skipped`.
4. **Invoke.** Invoke the `skill` command string as-is via the `Skill` tool. Do not "verify installation" first — the harness's loaded-skills list (system-reminders) is authoritative. **Never grep `~/.claude/plugins/cache/` or any plugin directory** — the cache layout is `cache/<marketplace>/<plugin>/`, not `cache/<plugin>/`, and assumption-based path checks produce false-negative `unavailable` outcomes. Classify: skill absent from the available-skills list or rejected as unknown → `unavailable`; runs but errors/times out → `error`; runs to completion → evaluate (step 5).
5. **Evaluate.** Actionable improvement found → `actionable` (summarize finding); context improvement (e.g. a CLAUDE.md fix) → `contextual` (summarize; apply directly if trivial); nothing found → `empty`.
6. **Act on outcome.**
   - **`actionable` / `contextual`:** build one candidate and route it through reflect's standard gates:
     ```
     Candidate: <title derived from finding>
     Tier: 1
     Evidence Source: scheduled-check/<id>
     Evidence: <one-paragraph summary>
     Sessions: none
     ```
     Pass it to § Evidence Validation (`claude-code-hermit:reflection-judge`). On ACCEPT/DOWNGRADE, gate with § Proposal triage gate (`claude-code-hermit:proposal-triage`) — when appending the `triage-verdict` metric there, set `"caller":"scheduled-checks"`. On triage `CREATE`: Tier 1/2 → § Micro-approval queuing; Tier 3 → `/claude-code-hermit:proposal-create`. SUPPRESS/DUPLICATE from triage, or SUPPRESS from the judge → drop silently (note in the Progress Log). An unrecognized judge or triage verdict → fail closed exactly as those sections specify (gate-failed metric + Progress Log note); the candidate re-surfaces on the next scheduled-checks run.
   - **`empty`:** no candidate. `consecutive_empty += 1` (persisted in step 7). Check the interval-adjustment rule below.
   - **`unavailable`:** note in SHELL.md `## Findings`: `Scheduled check skipped: <id> — skill unavailable (cooldown 4h)`. No candidate.
   - **`error`:** note in SHELL.md `## Findings`: `Scheduled check error: <id> — retrying after interval_days`. No candidate.
   - **`skipped`:** no action beyond the Progress Log.

   **Interval adjustment.** `empty` → `consecutive_empty += 1`; `actionable`/`contextual` → reset to 0; an interval-increase proposal accepted or dismissed → reset to 0. On **3+ consecutive empty runs**, create a standard Three-Condition proposal (not tagged `scheduled-check`) to increase `interval_days` (e.g. 7 → 14), gated through `claude-code-hermit:proposal-triage` first. This mode never auto-adjusts — adjustments always go through PROP-NNN.
7. **Persist per-check state.** Write the delta directly to `state/reflection-state.json → scheduled_checks.<id>` (fail-open — a failed write logs to stderr only, never aborts). Set only the fields the current outcome changes: `unavailable` → `last_unavailable_at` (leave `last_run`); `error` → `last_error_at` (leave `last_run`); `empty` → `last_run` + `consecutive_empty = prior+1`; `actionable`/`contextual` → `last_run` + `consecutive_empty = 0`.
   ```bash
   bun -e "
   const fs=require('fs');
   const f='.claude-code-hermit/state/reflection-state.json';
   try {
     const s=JSON.parse(fs.readFileSync(f,'utf-8'));
     if(!s.scheduled_checks) s.scheduled_checks={};
     const id='<check-id>';
     if(!s.scheduled_checks[id]) s.scheduled_checks[id]={};
     const c=s.scheduled_checks[id];
     // Set fields per outcome (see above); substitute id, ISO timestamp, assignments before running.
     fs.writeFileSync(f, JSON.stringify(s,null,2)+'\n','utf-8');
   } catch(e){ process.stderr.write('scheduled-checks state: '+e.message+'\n'); }
   "
   ```
8. **Progress Log (always).** Append one line to SHELL.md `## Progress Log`: `[HH:MM] scheduled-checks — <id>: <outcome>; verdicts: accept=A downgrade=D suppress=S; outcome: <none|micro-queued|proposal-created|interval-proposal>`. Use `skipped` for both the id and outcome fields when no check was due.

Then stop. Do not run the precheck or the scheduled-reflect steps below.

1. Determine whether a full reflect run is warranted:
   - **If `$ARGUMENTS` contains `--precheck-verdict '<verdict>'`**: the reflect routine's CronCreate prompt already ran the precheck in bash and passed its verdict here. Use `<verdict>` directly and do **not** re-run the precheck. It is always a `RUN|<phases-json>` line — the routine stops on `EMPTY` without invoking this skill, so an EMPTY day never loads this file. Skip to reading the verdict below.
   - **Otherwise** (manual `/reflect`, or any invocation without the flag), run the precheck yourself:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/reflect-precheck.ts .claude-code-hermit ${CLAUDE_PLUGIN_ROOT}
     ```
   Read the verdict (the passed `<verdict>` or the first line of precheck output):
   - `EMPTY` → the precheck found no due phases and no compute activity. It has already updated `reflection-state.json` and appended the mandatory Progress Log line to SHELL.md. Emit `reflect: no candidates` and stop.
   - `RUN|<phases-json>` → continue to step 2. The JSON object lists which phases are due (`cost_spike`, `resolution_check`, `compute`, `digest`, `newborn`, `observations_fresh`). Skip evaluation sections for phases not listed — they are not due this run. `observations_fresh` means the ledger has rows newer than `last_run_at` and step 3b should run even if `compute` is absent.
2. Read SHELL.md for current context. **(fresh read — re-read the file(s) now; do not reuse a value cached in context from before compaction)**
3. Read last 20 lines of cost-log.jsonl. If `cost_spike` is listed in the phases JSON: compute today's total and the 7-day median. If today's total > 2× the 7-day median (and both are non-zero), record the spike as a sub-threshold observation in the ledger: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/observations.jsonl '{"ts":"<now ISO>","pattern":"cost_spike: $X.XX vs 7d median $Y.YY","session_id":"<S-NNN>","source":"cost-spike"}'` — it becomes input to later reflects and may graduate via the step 3b recurrence promotion. If `cost_spike` is not listed, skip this read.

3b. **Observations ledger** — prune, then graduate recurring patterns.
   - Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/prune-observations.ts .claude-code-hermit` (fail-open; prints `pruned N, kept M`).
   - Read `state/observations.jsonl` (skip silently if absent or empty). Parse per-line with `try { JSON.parse(line) } catch {}`; group entries by `pattern`.
   - Any pattern with **≥ `graduation_min_sessions` distinct `session_id`s** (read from `config.json` at `reflection.graduation_min_sessions`; default 1 if absent) is mechanically promoted to a proposal candidate. The "at least one not the current session" guard is dropped — the operator micro-approval gate and judge verification provide sufficient quality control. Origin aggregation: set `Evidence Origin: external-content` if **any** grouped row has `origin: "external-content"`, else `Evidence Origin: own-work`. Unknown `origin` (old rows lacking the field) is treated as `own-work`.
     - `Evidence Source: archived-session`
     - `Evidence Origin: own-work` or `external-content` (per aggregation above)
     - `Sessions: <the distinct session_ids>`
     - `Artifact: state/observations.jsonl — pattern "<label>" in N sessions`
     Route it through triage + judge like any other candidate (§ Evidence Validation, § Outcomes). Patterns below the threshold stay in the ledger untouched.
   - **`skill-correction:*` routing.** When a graduated pattern's label matches `skill-correction:<name>`, classify it as a skill-improvement candidate and resolve the procedure brief deterministically: glob `.claude-code-hermit/compiled/procedure-brief-*.md` first, then `.claude-code-hermit/compiled/.archive/procedure-brief-*.md`; match `proposed_skill_name:` frontmatter against `<name>`; prefer a live `compiled/` match over an archived one; among same-location matches pick the one with the newest `created:` frontmatter date. Then branch:
     - **Brief found (self-authored, strong signal):** read the `## Lessons` section from each session listed in the graduated ledger rows' `session_id` fields to recover the correction what/why (the ledger row is a bare counter; the Lessons line carries the reason). If a cited session report is missing or unreadable, proceed with the behaviors recovered from the sessions that are available — the candidate still stands on its component name plus whatever Lessons survive. Build a candidate with a `## Skill Improvement` section listing the component name, those corrected behaviors, and `source_artifact: <brief path>` as a body line. The candidate carries `Artifact: state/observations.jsonl` (judge §1.4 validates recurrence) and is Tier 2 (Component Health finding, meaningful but non-critical). Proceed via § Evidence Validation and § Outcomes — Tier 2 routes through triage then micro-approval queue, not directly to proposal-create.
     - **No brief found (human/plugin or brief fully gone, moderate signal):** proceed via § Evidence Validation and § Outcomes as a plain Tier 2 improvement proposal (no `## Skill Improvement`, no skill-creator). The candidate carries `Artifact: state/observations.jsonl`.
4. **Compute phase** — gates adapt to hermit age so cold-start installs produce visible output without eroding mature-hermit rigor.
   - Read `counters.since` from `state/reflection-state.json` (set once at hatch, never rewritten). If missing or unparseable → default `$PHASE = adult` and continue. Never block.
   - `age_days` = whole days between `counters.since` and now.
   - `$PHASE` table (age is monotonic → no hysteresis):
     - `newborn` — `age_days < 3`
     - `juvenile` — `3 ≤ age_days < 14`
     - `adult` — `age_days ≥ 14`
   - Bind `$PHASE` for the rest of this run; it gates sub-threshold surfacing (Outcomes) and the Progress Log annotation. Tier 1 recurrence is no longer phase-gated (see § Three-Condition Rule, condition 1).

5. Delegate the proposal scan to the built-in `Explore` subagent. Prompt: `List all .claude-code-hermit/proposals/PROP-*.md files. For each, extract id, status, title, source, created, accepted_date, related_sessions from YAML frontmatter (or **Status:**/**Title:** bullet fallback for pre-Observatory proposals). Return a compact JSON array — metadata only, no file bodies.` Also tail the last 100 lines of `state/proposal-metrics.jsonl` (inline, single read): count `responded` events by `action` (accept / defer / dismiss) and `micro-resolved` events by `action` (approved / rejected / expired) — both feed the operator-value self-check below. Also count `triage-verdict` events by `verdict` (CREATE / SUPPRESS / DUPLICATE) — feeds the Component Health triage check below.

6. **Dispatch the eval runner.** Dispatch `claude-code-hermit:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/reflect/reference.md`. Include in the dispatch prompt:
   - `plugin_root`: `${CLAUDE_PLUGIN_ROOT}` (resolved absolute path — the runner needs it to run `eval-success-signal.ts`, since `${CLAUDE_PLUGIN_ROOT}` is not substituted in `reference.md` content).
   - The precheck `phases-json` (from step 1).
   - `last_resolution_check` cursor (read from `state/reflection-state.json`).
   - `session_state` (read from `state/runtime.json`; controls whether the runner executes the routine check).

   **Failure policy:** if the runner returns null or malformed JSON, fail-open — skip all apply steps in this step, carry forward empty `routine_candidates` and `procedure_candidates`, do not advance the cursor. Append `[HH:MM] reflect — analysis-runner failed; introspection-only` to the Progress Log and continue.

**Eval runner return schema** — the runner's return value is a JSON object conforming to this block. The schema is byte-identical in `reference.md` (producer) and here (consumer); a contract test asserts this.

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

   **Apply `resolution_actions`** (housekeeping writes; exempt from the evidence integrity rule):
   - `action == "auto-resolve"`: write `frontmatter_patch` fields to the proposal's YAML frontmatter; run `append-metrics.ts` via stdin heredoc (metrics_event is model-authored JSON and may contain apostrophes):
     ```bash
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/proposal-metrics.jsonl <<'HERMIT_METRICS_JSON'
     <metrics_event>
     HERMIT_METRICS_JSON
     ```
     append `shell_findings_line` to SHELL.md `## Findings`.
   - `action == "nudge"`: append `shell_findings_line` to SHELL.md `## Findings`. (Nudge debounce is handled inside the runner — `action: "nudge"` already passed the 7-day guard.)
   - `action == "skip"`: no action.

   Carry `routine_candidates`, `procedure_candidates`, `last_resolution_check`, and `last_sparse_nudge` forward to Evidence Validation and State Update below.

Now reflect — think hard — using **inherited context only** (this session's SHELL.md body from step 2, cost/token shape from step 3, proposal-metrics summary from step 5). The eval runner handled cross-session file analysis; do not re-read session reports or proposal bodies here. Signals available to think-hard:
- Is anything recurring that shouldn't be?
- Have you been working around something that deserves a real fix?
- Is spending proportional to the work being done?
- Did I use tokens on work a cheaper subagent (Haiku) could have handled?
- Did I do something manually that a skill already covers?
- Could a subagent have handled a repeating subtask within this session?
- Was context bloat avoidable — did I load files I didn't need, or keep large content in context longer than necessary?
- Am I producing value the operator actually uses? Cross-reference the `responded` counts and `micro-resolved` counts from step 5: a high `dismiss` ratio on proposals, a high `rejected` rate on micro-proposals, or compiled/brief outputs that go uncited in subsequent sessions signal that some output is noise — consider a Tier 1 micro-proposal to pare it back. A high `expired` rate is a separate signal: questions are timed poorly rather than unwanted — consider a Tier 1 micro-proposal to adjust question scheduling rather than cutting volume.
- Have I executed the same multi-step procedure in ≥2 sessions with no skill covering it? (procedure-capture candidate — see § Procedure capture below)

## Three-Condition Rule

Only create a proposal if all three are true:
1. **Repeated pattern** — tier-aware recurrence:
   - **Tier 1 + `Evidence Source: current-session`**: 1+ session acceptable. Cite `Sessions: current` when the pattern is present in the live SHELL.md `## Findings` / `## Blockers` (judge returns `ACCEPT (current-session)`). Phase is irrelevant for this path.
   - **Tier 1 + `Evidence Source: archived-session`**: requires 2+ archived sessions, identical to Tier 2/3. The loosening above is specific to the `current-session` path, not to Tier 1 generally.
   - **Tier 2 / Tier 3**: 2+ archived sessions required at every phase (baseline: observed more than once, across archived sessions).
   - **Artifact-cited efficiency/cost candidates**: recurrence is satisfied by the cited measurements themselves — the same waste measured ≥2 times in a machine-written state file (`Sessions: none` + `Artifact:` line; the judge verifies the file contains the cited values).
   - **Procedure-capture ephemerality exception**: a procedure-capture candidate with ephemeral artifacts and quantified cost satisfies recurrence at 1 current session — see § Procedure capture.
2. **Meaningful consequence** — something goes wrong without fixing it
3. **Operator-actionable change** — something the operator can concretely approve

If any of the three cannot be stated concretely, do not create the proposal.
Sub-threshold observations (interesting but failing the rule) are appended to the observations ledger (`state/observations.jsonl`) so they can graduate on later recurrence — see the Outcomes section.

If `runtime.json` `session_state` is `idle` — think broader:
- Should any recurring check be added to HEARTBEAT.md?
- Is there a preference or constraint missing from OPERATOR.md?
- Would a sub-agent improve a type of work that keeps coming up?
- Would a skill formalize a workflow you keep repeating?
- Is a manual request repeating on a schedule? (e.g., "operator asked for dependency check 3 of last 4 Mondays")
  If so: create a proposal with `Type: routine` and a `## Config` block containing the routine JSON:
  ```markdown
  ## Config
  {"id":"weekly-deps","schedule":"0 9 * * 1","skill":"claude-code-hermit:session-start --task 'dependency audit'","enabled":true}
  ```
  When accepted via `proposal-act`, this JSON is parsed and added to `config.json` routines automatically.

- Routine health and channel-engagement analysis run in the eval runner (step 6) and return as `routine_candidates`. Each entry is a disable/retime/diagnostic candidate; apply in Evidence Validation below alongside procedure and think-hard candidates.

## Component Health

Check whether any skill, agent, or hook is underperforming.

**Skills:**
- Is a skill's output consistently corrected or reworked after use? (Backed by the `skill-correction:*` ledger graduation in step 3b — patterns with ≥`graduation_min_sessions` distinct sessions graduate into Skill Improvement proposals; Component Health's role here is to ensure the question is answered from accumulated data, not re-derived from session prose.)
- Is a skill being avoided in favor of manual steps?
- Did a skill fail to catch something it should have?
- Is a skill burning disproportionate tokens for the value it delivers?

**Agents:** read `state/reflection-state.json` cumulative counters (they accumulate since the `since` timestamp). Flag if `reflection-judge` shows `judge_suppress` dominating `judge_accept` (rough threshold: suppress count > 2× accept count, with at least 5 total verdicts since `since`) — the gate may be too strict and killing legitimate candidates. For `proposal-triage`: use the `triage-verdict` counts from the `state/proposal-metrics.jsonl` tail already read in step 5. Flag if `SUPPRESS` count > 2× `CREATE` count with at least 5 total triage verdicts in the tail window — the gate may be over-strict and rejecting legitimate candidates.

**Hooks:** out of scope here — there is no hook execution telemetry. Document as a known gap if hook misbehavior is suspected; do not try to infer from side-effects.

Signal ladder (same for all three):
- **Weak signal** (one-off or ambiguous): no action — not worth surfacing.
- **Moderate signal** (pattern across 2-3 sessions): create a proposal via `/claude-code-hermit:proposal-create` with the evidence (subject to Three-Condition Rule).
- **Strong signal** (clear, repeated pattern): create a proposal via `/claude-code-hermit:proposal-create` with the evidence and include a `## Skill Improvement` section (or `## Agent Improvement`) listing the component name, observed failures, and suggested eval criteria. When the proposal is accepted via `proposal-act`, use `/skill-creator:skill-creator eval` and `/skill-creator:skill-creator improve` to implement the changes. If `/skill-creator:skill-creator` is not available, apply the changes to the component's definition file directly.

### Procedure capture (new-skill creation)

Component Health above improves existing components. This subsection is the symmetric path: creating a brand-new skill from a recurring procedure the hermit keeps executing manually.

**Kill criteria (evaluate per candidate surfaced, not per reflect run — recurrence-gating means this fires rarely).**

After ≥8 procedure-capture candidates surfaced, run:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal-metrics-report.ts .claude-code-hermit --source=procedure-capture
```

Triage-survival < 25% or acceptance < 30% → disable procedure capture rather than tune it. `INSUFFICIENT` output means the ≥8-verdict sample hasn't been reached yet; do not read thresholds until it does.

**Detection — when to trigger:**

The eval runner (step 6) reads MEMORY.md and archived `## Lessons` sections and returns recurring procedures as `procedure_candidates`. Each entry already carries `slug`, `title`, `evidence`, `sessions`, `evidence_source`, and `evidence_origin`. Process each entry through the dedup guard and write-brief steps below.

Recurrence signal (as evaluated by the runner): the same multi-step procedure appears as a Lesson or memory workflow-pattern in **≥ `graduation_min_sessions` distinct archived sessions** (read from `config.json` at `reflection.graduation_min_sessions`; default 1 if absent) and no existing skill covers it.

**Ephemerality exception:** a procedure observed only in the current session is eligible when (a) its artifacts are ephemeral — they live outside the repo and the hermit state dir (e.g. `/tmp` scripts) and will not survive the session — and (b) its cost is quantified in session content that already exists (wall-clock, rerun count, or script count in SHELL.md Progress Log / Findings; reflect must not write it there itself — § Evidence integrity rule). Such candidates use `Evidence Source: current-session` with `Sessions: current`, stay Tier 3, write the procedure brief as usual (the brief preserves the evidence before it vanishes), and route through `proposal-create` like any procedure-capture candidate. They count toward the kill-criteria sample above — the safety valve if this exception turns noisy.

**Evidence fields** (standard path — set by construction; ephemerality-exception candidates use `Evidence Source: current-session` instead, as stated above):
- `Evidence Source: archived-session` (reads MEMORY.md + archived Lessons, never live SHELL.md)
- `Evidence Origin: own-work` unless the procedure was originally learned from external content (web fetches, `raw/` captures, channel messages) — then `external-content`, which forces Tier 3 anyway

**Dedup guard (both checks required before writing a brief):**
1. Glob `.claude/skills/*/SKILL.md`; for each, read `name:` and `description:` frontmatter. If an installed skill already covers the procedure (name or trigger-phrase match) → suppress; note as a housekeeping line in SHELL.md Findings (exempt from evidence-integrity per the rule below).
2. Consult the harness available-skills list (authoritative — never disk checks or `claude plugin list`). If any `/claude-code-hermit:*` or sibling-plugin skill already covers the procedure → suppress.
3. The standard `proposal-triage` gate still runs and catches an already-open PROP (DUPLICATE verdict).

**Write the procedure brief (audit artifact):**

Write `.claude-code-hermit/compiled/procedure-brief-<slug>-YYYY-MM-DD.md` before queuing the candidate. This is a housekeeping artifact (not evidence injected into the judged session content), so writing it before the judge call is permitted.

Frontmatter:
```yaml
---
title: "Procedure brief — <name>"
type: procedure-brief
created: <ISO with tz>
tags: [procedure-capture]
source: session
session: S-NNN
related_sessions: [S-AAA, S-BBB]
proposed_skill_name: <name>
---
```

Body (concise — fits the `compiled/` char-budget/lint contract; do NOT write a full SKILL.md here):
- The recurring steps in order
- Evidence sessions (which sessions and what Lessons/memory entries show the recurrence)
- Proposed skill name and trigger phrases

**Routing:** classify **Tier 3** (a new skill auto-loads into every future session, its triggers can fire autonomously, and writing under `.claude/` is operator-space — effectively irreversible/cross-cutting). This matches the Tier-3 definition and the convention that all `category: capability` writers go straight to `proposal-create`.

Queue as a Tier-3 candidate by calling `/claude-code-hermit:proposal-create` — it runs `proposal-triage` internally and emits the `tags`-carrying triage-verdict. Do **not** pre-gate with `proposal-triage` separately: a separate pre-gate emits an untagged `caller: reflect` verdict, so its SUPPRESSes escape the triage-survival count above and inflate the rate. Call with:
- `category: capability`
- `tags: [procedure-capture]`
- `source: auto-detected`
- The `## Skill Draft` body block (see `proposal-create` for format):
  ```
  ## Skill Draft
  - name: <skill-name>
  - source_artifact: .claude-code-hermit/compiled/procedure-brief-<slug>-YYYY-MM-DD.md
  - install_target: .claude/skills/<name>/SKILL.md
  - triggers: <comma-separated proposed trigger phrases>
  ```

Never queue procedure-capture candidates to the micro-approval queue. External-origin procedures (where the procedure was derived from external content) should carry `Evidence Origin: external-content` through to proposal-create, which will write the operator-visible provenance line.

## Evidence integrity rule (applies before calling reflection-judge)

For any candidate with `Evidence Source: current-session`, reflect must **not** add or rewrite evidence-bearing lines in `## Findings` or `## Blockers` of SHELL.md before `reflection-judge` runs. The judge validates against pre-existing session content; injecting the pattern text immediately before the judge reads it would make the system self-certifying.

**Exempt** (always allowed, any time): the mandatory `## Progress Log` append (see § Progress Log Entry) and housekeeping notes that do not describe the candidate's pattern (e.g. skipped-scheduled-check lines, resolved-proposal notes).

If the pattern is only visible to reflect via inference (cost log, token counters, timing), the candidate is not eligible for `Evidence Source: current-session` prose evidence in that run — reflect must never write the pattern into SHELL.md to certify itself. Two paths exist instead:

- **Artifact-cited (efficiency/cost-class only):** when a machine-written state file already contains the measurement, raise the candidate immediately with `Sessions: none` plus an `Artifact:` line citing the file and the value — the judge verifies the artifact directly (judge §0.5/§1.4) instead of suppressing `no-sessions`.
- **No qualifying artifact:** keep it sub-threshold — append it to the observations ledger and let it graduate by recurrence (step 3b).

## Evidence Validation

Before acting on any proposal candidate, delegate to `claude-code-hermit:reflection-judge`. Collect **all** candidates first — including `routine_candidates` and `procedure_candidates` from step 6 alongside candidates from the think-hard block and procedure capture — then make a **single** invocation. Dedup by title-slug before passing to the judge (reflection-judge matches verdicts by title; duplicates would produce ambiguous routing). The judge returns one verdict line per candidate. A single candidate is still passed as a batch of one.

Pass candidates as a sequence of blocks separated by a blank line:
```
Candidate: <title>
Tier: <1|2|3>
Evidence Source: archived-session | current-session | scheduled-check/<id> | operator-request
Evidence Origin: own-work | external-content
Evidence: <summary>
Sessions: <S-001, S-002, ...> (or "none")
Artifact: <machine-written state file> — <cited value/pattern>   (optional)

Candidate: <next title>
Tier: <1|2|3>
Evidence Source: ...
Evidence Origin: ...
Evidence: ...
Sessions: ...
```

`Artifact:` is optional. A valid artifact is a **machine-written state file** only (`.claude/cost-log.jsonl`, `state/proposal-metrics.jsonl`, `state/observations.jsonl`) — SHELL.md, session reports, and `compiled/` prose are never artifacts. Ledger-graduated candidates from step 3b always carry it.

The judge returns one verdict line per candidate, matched by `<title>`. Apply the routing below to each line independently.

`Evidence Source:` defaults to `archived-session` if omitted. Plugin-check candidates use `Evidence Source: scheduled-check/<id>` with `Sessions: none`. Tier-1 candidates with live SHELL.md evidence use `Evidence Source: current-session` with `Sessions: current` (see § Three-Condition Rule, condition 1). Efficiency/cost artifact candidates use the default `Evidence Source: archived-session` with `Sessions: none` plus an `Artifact:` line — judge §0.5 routes them to §1.4 artifact verification instead of suppressing `no-sessions`.

`Evidence Origin:` defaults to `own-work` if omitted. Set to `external-content` when the evidence derives from web fetches, `raw/` third-party captures, or a channel finding with an `[origin: external]` marker (see § Proposal Tier Classification and § channel-responder §4). The two fields are orthogonal: a candidate can be `archived-session` + `external-content`.

`scheduled-check/<id>` and `operator-request` share the same bypass policy at every gate (skip recurrence, enforce consequence + actionability). They are **kept distinct on purpose**: `scheduled-check/<id>` carries the check identifier for telemetry and debugging; `operator-request` marks human-initiated flows (e.g. baseline audits in `session-start`). Future routing (e.g. KAIROS) will read them as different provenance classes. Do not collapse them into one value.

- **ACCEPT** or **ACCEPT (<source>)** — proceed with the candidate at its original tier
- **DOWNGRADE:<new-tier>** or **DOWNGRADE:<new-tier> (<source>)** — proceed at the revised tier. When the reason contains `quarantine: external origin`, the revised tier is 3 regardless of apparent reversibility — route to `proposal-create` and pass `Evidence Origin: external-content` through so proposal-create can write the operator-visible provenance line in the PROP body. reflect does not write the PROP body itself.
- **SUPPRESS** — if suppressed with code `no-sessions`, note the candidate in SHELL.md Findings for future revisit. Otherwise drop silently.
- **Unrecognized line** for a candidate (agent errored, returned malformed/empty output, or was terminated mid-batch): fail closed — treat as SUPPRESS. Append:
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts \
    .claude-code-hermit/state/proposal-metrics.jsonl \
    '{"ts":"<now ISO>","type":"gate-failed","agent":"reflection-judge","title":"<title>"}'
  ```
  Note `gate-failed: reflection-judge — <title>` in the SHELL.md Progress Log. The candidate re-surfaces on the next reflect cycle.

Only act on ACCEPT and DOWNGRADE verdicts. `proposal-triage` (the gate in § Proposal Tier Classification) is single-candidate — invoke it per-candidate, not as a batch.

## Outcomes

After reflecting and validating with `claude-code-hermit:reflection-judge`, choose exactly one outcome per observation:

1. **No action** — pattern not strong enough, already handled, or already addressed by the Resolution Check above.
2. **Memory update** — for **durable lessons** worth remembering for future sessions: operator-stated rules, preferences that recurred, decision rationales that may apply later, workflow patterns that worked. For any such observation, issue the standard "remember it" reflection — Claude's trained auto-memory flow handles the write. Use auto-memory's discipline (concise, MEMORY.md ≤ 200 lines / 25KB, topic files for detail, respect WHAT_NOT_TO_SAVE — no file paths, debugging recipes, or facts derivable from grep). Save nothing if nothing rises above noise. Sub-threshold *patterns* do NOT go to memory — they go to the observations ledger (see below); keeping the recurrence store separate from operator memory is what prevents the judge's `covered-by-memory` check from suppressing a pattern at the moment it graduates.
3. **Proposal candidate** — repeated pattern + clear consequence + operator-actionable
   → classify tier (see Proposal Tier Classification below):
   - Tier 1/2: gate with `claude-code-hermit:proposal-triage` first (see below), then queue micro-approval in `state/micro-proposals.json`
   - Tier 3: gate with `claude-code-hermit:proposal-triage` first (see below), then call `/claude-code-hermit:proposal-create`

   `routine_candidates` from the eval runner are Tier 1; any pre-rendered `shell_findings_line` (diagnostic entries) goes to SHELL.md `## Findings` directly — no judge/triage needed for diagnostics, only for disable/retime action candidates.

Sub-threshold observations (interesting but failing the Three-Condition Rule — typically single-occurrence) do not surface to the operator in steady state. Append them to the observations ledger with a short stable pattern label via stdin heredoc (pattern labels are free text and may contain apostrophes):
```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/observations.jsonl <<'HERMIT_METRICS_JSON'
{"ts":"<now ISO>","pattern":"<short pattern label>","session_id":"<S-NNN>","source":"reflect-noticed","origin":"own-work"}
HERMIT_METRICS_JSON
```
they graduate via the step 3b recurrence promotion. Include `"origin":"external-content"` instead of `"own-work"` when the observation derives from a SHELL.md finding carrying an `[origin: external]` marker (copy the marker deterministically, don't infer from content). Reuse the exact label when re-observing a known pattern; grouping is by string equality. Do not generate observations for their own sake; only append when a genuine pattern is noticed.

Reflect-generated inferences (cost spikes, token-count shapes, timing patterns) **never** use bypass Evidence Sources (`scheduled-check/*` or `operator-request`). They either (a) carry a verifiable `Artifact:` citation to a machine-written state file and take the artifact-cited path now (see § Evidence integrity rule), or (b) land in the observations ledger and graduate by recurrence, at which point step 3b promotes them with `Evidence Source: archived-session` and the ledger `Artifact:` citation.

**Phase-aware surfacing exception:**
- `newborn`: also log each sub-threshold observation inline to SHELL.md Findings as `Noticed: <pattern>` (single line, no ceremony). Gives the operator early signal that reflect is watching while recurrence data accumulates.
- `juvenile`: emit a weekly digest instead of per-observation lines. Read `last_digest_at` from `state/reflection-state.json` (top-level, may be absent). If absent or older than 7 days, write a single `Noticed (digest): <N> observations — <top 3 pattern labels>` line to SHELL.md Findings, and include `"last_digest_at": "<now ISO>"` in the State Update payload below so the update script persists it.
- `adult`: silent (baseline).

Review past dismissed and deferred proposals.
Avoid re-suggesting recently dismissed ideas.
If significantly more evidence has accumulated since
a dismissal, it may be worth revisiting.

## Proposal Tier Classification

Before creating a proposal or acting silently, classify every proposal candidate into a tier:

**Tier 1 — reversible, routine, low-scope:** queue micro-approval, do NOT create PROP-NNN.
Example: "For 3 weeks I've added the same 5 hashtags manually. Proposing to automate that step."

**Tier 2 — meaningful but non-critical:** queue micro-approval, create PROP-NNN only after operator says yes.
Example: "Morning brief is consistently ignored on weekdays before 9am. Proposing to shift it to 9:30am."

**Tier 3 — safety-critical, irreversible, or cross-hermit scope:** create PROP-NNN immediately via `/claude-code-hermit:proposal-create`, skip micro-approval entirely.
Example: "Operator's gate automation script has an error that could trigger physical actuators unexpectedly. Requires explicit review before any change."

**External-origin override:** any candidate with `Evidence Origin: external-content` is **Tier 3 regardless of apparent reversibility** — route to `proposal-create` and never to the micro-approval queue. External content (web fetches, `raw/` third-party captures, channel messages with `[origin: external]`) can carry crafted patterns aimed at injecting learned habits into the agent; forcing full operator review closes that path. Set `Evidence Origin: external-content` when evidence derives from any of those sources; default is `own-work`.

### Proposal triage gate

Before queuing a micro-approval or calling `proposal-create`, call `claude-code-hermit:proposal-triage`. Pass `Evidence Source:` and `Evidence Origin:` when known:
```
Title: <title>
Evidence Source: <value from the candidate, or omit to default to archived-session>
Evidence Origin: <own-work | external-content, or omit to default to own-work>
Evidence: <one-paragraph evidence summary>
```

- `CREATE` — proceed
- `DUPLICATE:<PROP-ID>` — link to existing proposal in SHELL.md Findings instead, do not create
- `SUPPRESS` — drop silently
- **Unrecognized line 1** (agent errored, returned malformed/empty output, or was terminated before emitting a verdict): fail closed — do not create or queue the candidate; skip the triage-verdict append. Append:
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts \
    .claude-code-hermit/state/proposal-metrics.jsonl \
    '{"ts":"<now ISO>","type":"gate-failed","agent":"proposal-triage","title":"<title>"}'
  ```
  Note `gate-failed: proposal-triage — <title>` in the SHELL.md Progress Log. The candidate re-surfaces on the next reflect cycle.

Parse line 1 as the verdict. Lines 2+ are additive metadata (`closest_prop`, `aligned`, `operator_excerpt`, `overlap_compiled`, `prior_discussion`, `failed_condition`) — read for context if useful, but do not treat as part of the verdict for branching.

After receiving the verdict, append one event to `state/proposal-metrics.jsonl`. Use `"caller":"reflect"` on a normal reflect run, or `"caller":"scheduled-checks"` when invoked via § Scheduled-checks mode:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts \
  .claude-code-hermit/state/proposal-metrics.jsonl \
  '{"ts":"<now ISO>","type":"triage-verdict","verdict":"<CREATE|SUPPRESS|DUPLICATE>","caller":"reflect"}'
```

### Micro-approval queuing

Every micro-proposal question must include: **[observed pattern + duration] + [consequence] + [exact proposed change] + "Yes / No"** (or the exact option labels, for an `options` entry)

Do not queue vague questions like "Found a pattern. Want me to improve it?" — all three components must be present.

Dedup: do not re-append the same candidate if an entry with the same title/id already exists in `pending`.

### Queuing procedure

1. Generate ID: `MP-YYYYMMDD-N` where N increments within the same day (0, 1, 2). Check existing `micro-queued` events in `proposal-metrics.jsonl` for today to determine N.
2. Read `state/micro-proposals.json`. Append a new entry to `pending` with `id: "MP-YYYYMMDD-N"`, `tier: <1|2>`, `status: "pending"`, `follow_up_count: 0`, `ts: "<now ISO>"`, `question: "<full question text>"`. Write the file.

   Entries MAY also carry two optional fields, used by channel-bridged asks from other skills (see `channel-responder` § Channel-safe ask bridge) as well as reflect's own future N-way candidates:
   - `options: ["<label>", ...]` — 2-4 short labels. Absent means a plain yes/no entry (fully backward compatible).
   - `on_resolve: "<full skill invocation with an {answer} placeholder>"` — when present, resolving the entry substitutes the chosen label into `{answer}` (the resolver quotes it, so multi-word labels stay one argument) and invokes the resulting command, superseding the tier-based yes/no handling below. Bridge entries always set `tier: 1` regardless of the asking skill's own tiering, so tier-1 readers (e.g. heartbeat) keep working unchanged.
3. Append `micro-queued` event to `proposal-metrics.jsonl` via stdin heredoc (question is free text and may contain apostrophes):
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/proposal-metrics.jsonl <<'HERMIT_METRICS_JSON'
   {"ts":"<now ISO>","type":"micro-queued","micro_id":"MP-YYYYMMDD-N","tier":1,"question":"<full question text>"}
   HERMIT_METRICS_JSON
   ```
   For a channel-bridged ask (the entry carries `on_resolve`), add `"kind":"ask"` to this event. It still fires — so step 1's per-day `N` counter stays correct — but the marker tells the approval-rate readers (`generate-summary.ts`, `weekly-review.ts`) to exclude it: a bounded ask is not a yes/no approval. Its eventual `micro-resolved`/`answered` event is audit-only and, being neither `approved` nor `rejected`, is already outside those rates.
4. Notify the operator with the question. Entries without `options`: `MP-YYYYMMDD-N (tier <N>): <question>` — Reply `"MP-YYYYMMDD-N yes"` or `"MP-YYYYMMDD-N no"` (bare `yes`/`no` accepted when only one entry is pending). Entries with `options`: render them numbered (`1. <label>`, `2. <label>`, ...) under the question and hint `Reply "MP-YYYYMMDD-N <number or label>"` (bare number/label accepted when only one entry is pending).

## State Update

After each reflection run, call `update-reflection-state.ts` with the run's verdict counts:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.ts \
  .claude-code-hermit/state/reflection-state.json \
  '{"last_resolution_check":"<last-PROP-NNN-or-null>","ran_with_candidates":<true|false>,"judge_accept":<N>,"judge_downgrade":<N>,"judge_suppress":<N>,"judge_suppress_by_code":{"no-evidence":<N>,"no-sessions":<N>,"covered-by-memory":<N>},"proposals_created":<N>,"micro_proposals_queued":<N>}'
```

For `judge_suppress_by_code`: count SUPPRESS verdicts from the judge grouped by canonical code (`no-evidence`, `no-sessions`, `covered-by-memory`). Omit codes with a zero count; omit the key entirely when `judge_suppress` is 0.

Include `"last_digest_at":"<now ISO>"` in the payload only when a juvenile digest fired in this run (see Outcomes → phase-aware surfacing). Omit otherwise — the script preserves the prior value.

Include `"last_sparse_nudge":{"<PROP-NNN>":"<now ISO>"}` when a sparse-pattern nudge was emitted this run. Use the `last_sparse_nudge` map returned by the eval runner (step 6) if non-empty; otherwise omit. The script merges the provided map into the existing `last_sparse_nudge` top-level key.

The script handles: counter increments, `last_reflection`/`last_run_at` timestamps, missing-counters fallback, `since` preservation, `last_digest_at` passthrough, `last_sparse_nudge` merge, `judge_suppress_by_code` accumulation, and atomic write. It always exits 0 — if the write fails it logs one line to stderr and continues. Counters are diagnostic, not audit-grade — a missed increment is acceptable.

## Progress Log Entry (non-empty runs)

On every reflect run that reaches this point (i.e., not an EMPTY verdict from the precheck — the precheck appends the Progress Log line for empty runs), append one line to SHELL.md `## Progress Log`:

`[HH:MM] reflect (<phase>) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">`

When any suppressions occurred, append a compact suffix:

`[HH:MM] reflect (<phase>) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">; suppressed: [<slug>: <code>, ...]`

Format per suppression: `<candidate-title-slug>: <code>` where `<code>` is the canonical code from the judge or triage verdict (`no-evidence`, `no-sessions`, `weak-recurrence`, `weak-consequence`, `not-actionable`). Cap at 3 entries with `+N more` overflow. Omit the `suppressed:` suffix entirely when suppress=0.

`<phase>` is one of `newborn` / `juvenile` / `adult` (from step 2b). If phase detection fell back to `adult` due to missing `counters.since`, annotate as `adult` silently — no operator-facing distinction.

This is the audit trail. The silent-by-default rule at the top governs operator pings only — the log line always goes in.
