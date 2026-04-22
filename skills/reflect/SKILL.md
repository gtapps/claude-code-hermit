---
name: reflect
description: Reflect on recent work and propose improvements if patterns are noticed.
---
# Reflect

Pause and think about your recent work.

This skill is **silent by default**. Only notify the operator (per the channel policy in CLAUDE.md § Operator Notification) if reflect produces an outcome: a proposal candidate, a micro-approval, a resolved proposal, a graduated sub-threshold observation, or a cost spike.

1. Read SHELL.md for current context
2. Read last 20 lines of cost-log.jsonl. Compute today's total and the 7-day median. If today's total > 2× the 7-day median (and both are non-zero), record the spike to project memory as a sub-threshold observation with pattern `cost_spike: $X.XX vs 7d median $Y.YY` and today's session_id — it becomes input to later reflects and may graduate via the recurrence rule.
2b. **Compute phase** — gates adapt to hermit age so cold-start installs produce visible output without eroding mature-hermit rigor.
   - Read `counters.since` from `state/reflection-state.json` (set once at hatch, never rewritten). If missing or unparseable → default `$PHASE = adult` and continue. Never block.
   - `age_days` = whole days between `counters.since` and now.
   - `$PHASE` table (age is monotonic → no hysteresis):
     - `newborn` — `age_days < 3`
     - `juvenile` — `3 ≤ age_days < 14`
     - `adult` — `age_days ≥ 14`
   - Bind `$PHASE` for the rest of this run; it gates recurrence (Three-Condition Rule #1), sub-threshold surfacing (Outcomes), and the Progress Log annotation.

3. Scan proposals/ for existing proposals (dedup, stale check, feedback loop). Parse metadata from YAML frontmatter if present (file starts with `---`). Fall back to parsing bullet-point metadata (`**Status:**`, `**Source:**`, etc.) for pre-Observatory proposals. Also tail the last 100 lines of `state/proposal-metrics.jsonl` and count `responded` events by `action` (accept / defer / dismiss) — the dismissal ratio feeds the operator-value self-check below.

4. **Resolution Check** — check whether any accepted proposals can be marked resolved. **Cap: check up to 5 per reflect cycle, round-robin.**

   a. Read `state/reflection-state.json` → `last_resolution_check` (last PROP-NNN checked, or null if first run).
   b. Read all proposals with `status: accepted`. Sort by `accepted_date` ascending. Resume from the proposal after `last_resolution_check`, wrapping around. Take up to 5.
   c. If the accepted list from step b is empty, skip to step f.
   d. For each proposal: read its `title` and Evidence section to understand the original pattern.
      Glob `.claude-code-hermit/sessions/S-*-REPORT.md`, sort descending, take the 3 most recent.
   e. If the pattern is **absent** from all 3 checked sessions — apply the cadence-aware resolution rule:

      **Compute original cadence:**
      - Read the proposal's `related_sessions` list from frontmatter.
      - For each `S-NNN`, read `date:` from `sessions/S-NNN-REPORT.md` frontmatter.
      - `original_cadence_days = max(date) - min(date)` in whole days. Single session → 0.
      - If any session report is unreadable or `related_sessions` is empty → treat as **sparse** (conservative fallback).

      **Frequent pattern** (`original_cadence_days ≤ 14`) — auto-resolve if ≥ 14 days have elapsed since `accepted_date`:
      - Update frontmatter: `status: resolved`, `resolved_date: <now ISO>`.
      - Append a `resolved` event:
        ```
        node ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.js .claude-code-hermit/state/proposal-metrics.jsonl '{"ts":"<now ISO>","type":"resolved","proposal_id":"PROP-NNN"}'
        ```
      - Note in SHELL.md Findings: "PROP-NNN resolved — pattern absent from last 3 sessions."

      **Sparse pattern** (`original_cadence_days > 14`) — never auto-resolve. Surface for operator confirmation if elapsed ≥ `2 × original_cadence_days` since `accepted_date`:
      - Check `state/reflection-state.json → last_sparse_nudge.<PROP-NNN>`. If present and fewer than 7 days have elapsed since that date, skip (prevents daily re-nudge noise).
      - Otherwise, add to SHELL.md Findings:
        ```
        PROP-NNN appears resolved (pattern absent 3/3 recent sessions, original cadence Nd, Xd since accept). Run /claude-code-hermit:proposal-act resolve PROP-NNN to confirm.
        ```
      - Record nudge: include `"last_sparse_nudge": {"<PROP-NNN>": "<now ISO>"}` in the State Update payload below. The update script merges under the top-level `last_sparse_nudge` key.

      If the pattern is absent but the elapsed guard is not yet met (frequent: < 14d, sparse: < 2×cadence), skip and revisit next cycle.
   f. Note the last PROP-NNN checked (or null if batch was empty). Include as `last_resolution_check` in the final state write in the State Update section below — do NOT write `reflection-state.json` here.

Now reflect — using your memory and the context above:
- Is anything recurring that shouldn't be?
- Have you been working around something that deserves a real fix?
- Is spending proportional to the work being done?
- Did I use tokens on work a cheaper subagent (Haiku) could have handled?
- Did I do something manually that a skill already covers?
- Could a subagent have handled a repeating subtask within this session?
- Was context bloat avoidable — did I load files I didn't need, or keep large content in context longer than necessary?
- Am I producing value the operator actually uses? Cross-reference the `responded` event counts from step 3: a high `dismiss` ratio, proposals stacking in `deferred`, or compiled/brief outputs that go uncited in subsequent sessions are signals that some output is noise. If the signal is strong, treat it like the routine-silence check below and consider a Tier 1 micro-proposal to pare back the offending output.

## Three-Condition Rule

Only create a proposal if all three are true:
1. **Repeated pattern** — phase-aware recurrence:
   - `newborn`: 1+ session acceptable for **Tier 1 only** — use `Evidence Source: current-session` and cite `Sessions: current` when the pattern is present only in the live SHELL.md (judge returns `ACCEPT (current-session)`). Tier 2/3 still require 2+ sessions.
   - `juvenile` / `adult`: 2+ sessions (baseline — observed more than once, across sessions).
2. **Meaningful consequence** — something goes wrong without fixing it
3. **Operator-actionable change** — something the operator can concretely approve

If any of the three cannot be stated concretely, do not create the proposal.
Sub-threshold observations (interesting but failing the rule) are recorded to project memory so they can graduate on later recurrence — see the Outcomes section.

If SHELL.md status is `idle` — think broader:
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

- Is a routine firing repeatedly with no visible downstream effect? Read the tail of `state/routine-metrics.jsonl` (last 200 lines), group `fired` events by `routine_id`, and cross-reference with the last 3 session reports (`sessions/S-*-REPORT.md`). If a routine has ≥5 fires in the last 14 days and no session report cites its `routine_id` or skill output as producing findings, decisions, or follow-ups — apply the Three-Condition Rule. If all three conditions hold:
  - Propose `enabled: false` (disable) via a `Type: routine` proposal reusing the existing `id`. `proposal-act` upserts by `id`, so no delete path is needed.
  - Or propose a changed `schedule` if the routine is valuable but mis-timed.
  - Include the fire count + window in the proposal's Evidence section.
  - Tier: `disable` → Tier 1 (micro-approval). Re-time → Tier 1. Both are fully reversible. Operators can clean up disabled entries any time via `/hermit-settings routines`.
  ```markdown
  ## Config
  {"id":"weekly-deps","schedule":"0 9 * * 1","skill":"claude-code-hermit:session-start --task 'dependency audit'","enabled":false}
  ```

## Component Health

Check whether any skill, agent, or hook is underperforming.

**Skills:**
- Is a skill's output consistently corrected or reworked after use?
- Is a skill being avoided in favor of manual steps?
- Did a skill fail to catch something it should have?
- Is a skill burning disproportionate tokens for the value it delivers?

**Agents:** read `state/reflection-state.json` cumulative counters (they accumulate since the `since` timestamp). Flag if `reflection-judge` shows `judge_suppress` dominating `judge_accept` (rough threshold: suppress count > 2× accept count, with at least 5 total verdicts since `since`) — the gate may be too strict and killing legitimate candidates. `proposal-triage` has no verdict counters today; treat it as a known gap and skip unless qualitative evidence (e.g., a recent DUPLICATE verdict that was actually novel) is visible in SHELL.md Findings.

**Hooks:** out of scope here — there is no hook execution telemetry. Document as a known gap if hook misbehavior is suspected; do not try to infer from side-effects.

Signal ladder (same for all three):
- **Weak signal** (one-off or ambiguous): no action — not worth surfacing.
- **Moderate signal** (pattern across 2-3 sessions): create a proposal via `/claude-code-hermit:proposal-create` with the evidence (subject to Three-Condition Rule).
- **Strong signal** (clear, repeated pattern): create a proposal via `/claude-code-hermit:proposal-create` with the evidence and include a `## Skill Improvement` section (or `## Agent Improvement`) listing the component name, observed failures, and suggested eval criteria. When the proposal is accepted via `proposal-act`, use `/skill-creator eval` and `/skill-creator improve` to implement the changes. If `/skill-creator` is not available, apply the changes to the component's definition file directly.

## Scheduled Checks

If `scheduled_checks` exists in config.json and has entries with `trigger: "interval"`, delegate to `/claude-code-hermit:reflect-scheduled-checks`. Otherwise skip this section entirely.

Pass the relevant config entries and current `state/reflection-state.json → scheduled_checks` state to the helper. The helper runs at most one due check and returns a `SCHEDULED-CHECK-RESULT` block.

**Consuming the result block:**
- `actionable` / `contextual`: treat findings as a proposal candidate tagged `Evidence Source: scheduled-check/<id>`. Pass through `reflection-judge` + `proposal-triage` gates. Context improvements may be applied directly if trivial.
- `empty`: no candidate. Check `state_delta_consecutive_empty` for interval-adjustment proposals (see below) — these use the **normal Three-Condition Rule** and are **not** tagged `Evidence Source: scheduled-check`.
- `unavailable` / `error`: note in SHELL.md Findings once (e.g., "Scheduled check skipped: {id} — skill unavailable"). No candidate.
- `skipped`: nothing due; no action.

**Apply state_delta** to `state/reflection-state.json → scheduled_checks.<id>` as part of the consolidated State Update step at the end. Update the fields returned by the helper (omit any with `null` value — don't overwrite existing data with null).

### Interval adjustment proposals

Using `state_delta_consecutive_empty` from the result block (or the existing state value if outcome was `skipped`):

**Reset rules (per check):**
- `empty` outcome → `consecutive_empty += 1`
- `actionable` / `contextual` outcome → reset `consecutive_empty = 0`
- Interval increase proposal accepted → reset to 0
- Interval increase proposal dismissed → also reset to 0 (prevents immediate re-proposal)

**Proposals:**
- **3+ consecutive empty runs** → create a proposal to increase `interval_days` (e.g., 7 → 14).
- **3+ actionable findings in a single run** → create a proposal to decrease `interval_days` (e.g., 7 → 3).
- Adjustments always go through PROP-NNN — hermit never auto-adjusts.
- These proposals use the standard Three-Condition Rule (repeated pattern + meaningful consequence + operator-actionable). They are **not** tagged `Evidence Source: scheduled-check` — they are recurrence observations over run history and must follow the normal evidence-verification path (`current-session` or `archived-session`).

## Evidence integrity rule (applies before calling reflection-judge)

For any candidate with `Evidence Source: current-session`, reflect must **not** add or rewrite evidence-bearing lines in `## Findings` or `## Blockers` of SHELL.md before `reflection-judge` runs. The judge validates against pre-existing session content; injecting the pattern text immediately before the judge reads it would make the system self-certifying.

**Exempt** (always allowed, any time): the mandatory `## Progress Log` append (see § Progress Log Entry) and housekeeping notes that do not describe the candidate's pattern (e.g. skipped-scheduled-check lines, resolved-proposal notes).

If the pattern is only visible to reflect via inference (cost log, token counters, timing), the candidate is not eligible for `Evidence Source: current-session` in that run. Keep it sub-threshold until it recurs and can be cited from independent historical evidence (`Evidence Source: archived-session`).

## Evidence Validation

Before acting on any proposal candidate, delegate to `claude-code-hermit:reflection-judge`.

Pass each candidate as:
```
Candidate: <title>
Tier: <1|2|3>
Evidence Source: archived-session | current-session | scheduled-check/<id> | operator-request
Evidence: <summary>
Sessions: <S-001, S-002, ...> (or "none")
```

`Evidence Source:` defaults to `archived-session` if omitted. Plugin-check candidates use `Evidence Source: scheduled-check/<id>` with `Sessions: none`. Newborn Tier-1 candidates from live SHELL.md evidence use `Evidence Source: current-session` with `Sessions: current`.

`scheduled-check/<id>` and `operator-request` share the same bypass policy at every gate (skip recurrence, enforce consequence + actionability). They are **kept distinct on purpose**: `scheduled-check/<id>` carries the check identifier for telemetry and debugging; `operator-request` marks human-initiated flows (e.g. baseline audits in `session-start`). Future routing (e.g. KAIROS) will read them as different provenance classes. Do not collapse them into one value.

- **ACCEPT** or **ACCEPT (<source>)** — proceed with the candidate at its original tier
- **DOWNGRADE:<new-tier>** or **DOWNGRADE:<new-tier> (<source>)** — proceed at the revised tier
- **SUPPRESS** — if suppressed with code `no-sessions`, note the candidate in SHELL.md Findings for future revisit. Otherwise drop silently.

Only act on ACCEPT and DOWNGRADE verdicts.

## Outcomes

After reflecting and validating with `claude-code-hermit:reflection-judge`, choose exactly one outcome per observation:

1. **No action** — pattern not strong enough, already handled, or already addressed by the Resolution Check above.
2. **Memory update** — fact worth recording → update project memory directly
3. **Proposal candidate** — repeated pattern + clear consequence + operator-actionable
   → classify tier (see Proposal Tier Classification below):
   - Tier 1/2: gate with `claude-code-hermit:proposal-triage` first (see below), then queue micro-approval in `state/micro-proposals.json`
   - Tier 3: gate with `claude-code-hermit:proposal-triage` first (see below), then call `/claude-code-hermit:proposal-create`

Sub-threshold observations (interesting but failing the Three-Condition Rule — typically single-occurrence) do not surface to the operator in steady state. Record them to project memory with a short pattern label and today's session_id so they can graduate via recurrence on a later reflect. Do not generate observations for their own sake, and do not surface them before they graduate.

Reflect-generated inferences (cost spikes, token-count shapes, timing patterns) **never** use bypass Evidence Sources (`scheduled-check/*` or `operator-request`). They remain sub-threshold observations recorded to project memory and graduate only by genuine recurrence across sessions, at which point they can be cited as `Evidence Source: archived-session` or `current-session` like any other session-grounded observation.

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

### Proposal triage gate

Before queuing a micro-approval or calling `proposal-create`, call `claude-code-hermit:proposal-triage`. Pass `Evidence Source:` when known:
```
Title: <title>
Evidence Source: <value from the candidate, or omit to default to archived-session>
Evidence: <one-paragraph evidence summary>
```

- `CREATE` — proceed
- `DUPLICATE:<PROP-ID>` — link to existing proposal in SHELL.md Findings instead, do not create
- `SUPPRESS` — drop silently

### Micro-approval queuing

Before queuing, check `state/micro-proposals.json`. If `active` is not null and `status` is `pending`: do NOT create a new one. Note the candidate in SHELL.md Findings and re-evaluate next reflect cycle.

### Question format (required)

Every micro-proposal question must include: **[observed pattern + duration] + [consequence] + [exact proposed change] + "Yes / No"**

Example: "For 3 weeks I've added the same 5 hashtags manually every post. Want me to make that automatic? Yes / No"

Do not queue vague questions like "Found a pattern. Want me to improve it?" — all three components must be present.

### Queuing procedure

1. Generate ID: `MP-YYYYMMDD-N` where N increments within the same day (0, 1, 2). Check existing `micro-queued` events in `proposal-metrics.jsonl` for today to determine N.
2. Write to `state/micro-proposals.json`: set `active` to the new entry with `status: "pending"`, `follow_up_count: 0`, `question: "<full question text>"`. Append `micro-queued` event to `proposal-metrics.jsonl` via `append-metrics.js`: `{"ts":"<now ISO>","type":"micro-queued","micro_id":"MP-YYYYMMDD-N","tier":1,"question":"<full question text>"}`
3. Notify the operator with the question.

## State Update

After each reflection run, call `update-reflection-state.js` with the run's verdict counts:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.js \
  .claude-code-hermit/state/reflection-state.json \
  '{"last_resolution_check":"<last-PROP-NNN-or-null>","ran_with_candidates":<true|false>,"judge_accept":<N>,"judge_downgrade":<N>,"judge_suppress":<N>,"proposals_created":<N>,"micro_proposals_queued":<N>}'
```

Include `"last_digest_at":"<now ISO>"` in the payload only when a juvenile digest fired in this run (see Outcomes → phase-aware surfacing). Omit otherwise — the script preserves the prior value.

Include `"last_sparse_nudge":{"<PROP-NNN>":"<now ISO>"}` when a sparse-pattern nudge was emitted this run (step 4e). The script merges the provided map into the existing `last_sparse_nudge` top-level key. Omit if no sparse nudge was emitted — the script preserves the prior map.

The script handles: counter increments, `last_reflection`/`last_run_at` timestamps, missing-counters fallback, `since` preservation, `last_digest_at` passthrough, `last_sparse_nudge` merge, and atomic write. It always exits 0 — if the write fails it logs one line to stderr and continues. Counters are diagnostic, not audit-grade — a missed increment is acceptable.

## Progress Log Entry (always)

On every reflect run, including empty ones, append one line to SHELL.md `## Progress Log`:

`[HH:MM] reflect (<phase>) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">`

When any suppressions occurred, append a compact suffix:

`[HH:MM] reflect (<phase>) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">; suppressed: [<slug>: <code>, ...]`

Format per suppression: `<candidate-title-slug>: <code>` where `<code>` is the canonical code from the judge or triage verdict (`no-evidence`, `no-sessions`, `weak-recurrence`, `weak-consequence`, `not-actionable`). Cap at 3 entries with `+N more` overflow. Omit the `suppressed:` suffix entirely when suppress=0.

`<phase>` is one of `newborn` / `juvenile` / `adult` (from step 2b). If phase detection fell back to `adult` due to missing `counters.since`, annotate as `adult` silently — no operator-facing distinction.

This is the audit trail. The silent-by-default rule at the top governs operator pings only — the log line always goes in.
