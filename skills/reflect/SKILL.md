---
name: reflect
description: Reflect on recent work and propose improvements if patterns are noticed.
---
# Reflect

## Operator Notification
Notify the operator per the channel policy in CLAUDE.md (§ Operator Notification).

Pause and think about your recent work.

1. Read SHELL.md for current context
2. Read last 20 lines of cost-log.jsonl for cost data
3. Scan proposals/ for existing proposals (dedup, stale check, feedback loop). Parse metadata from YAML frontmatter if present (file starts with `---`). Fall back to parsing bullet-point metadata (`**Status:**`, `**Source:**`, etc.) for pre-Observatory proposals.

4. **Resolution Check** — check whether any accepted proposals can be marked resolved. **Cap: check up to 5 per reflect cycle, round-robin.**

   a. Read `state/reflection-state.json` → `last_resolution_check` (last PROP-NNN checked, or null if first run).
   b. Read all proposals with `status: accepted`. Sort by `accepted_date` ascending. Resume from the proposal after `last_resolution_check`, wrapping around. Take up to 5.
   c. If the accepted list from step b is empty, skip to step f.
   d. For each proposal: read its `title` and Evidence section to understand the original pattern.
      Glob `.claude-code-hermit/sessions/S-*-REPORT.md`, sort descending, take the 3 most recent.
   e. If the pattern is **absent** from all 3 checked sessions → mark resolved:
      - Update frontmatter: `status: resolved`, `resolved_date: <now ISO>`.
      - Append a `resolved` event:
        ```
        node ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.js .claude-code-hermit/state/proposal-metrics.jsonl '{"ts":"<now ISO>","type":"resolved","proposal_id":"PROP-NNN"}'
        ```
      - Note in SHELL.md Findings: "PROP-NNN resolved — pattern absent from last 3 sessions."
   f. Note the last PROP-NNN checked (or null if batch was empty). Include as `last_resolution_check` in the final state write in the State Update section below — do NOT write `reflection-state.json` here.

Now reflect — using your memory and the context above:
- Is anything recurring that shouldn't be?
- Have you been working around something that deserves a real fix?
- Is spending proportional to the work being done?
- Did I use tokens on work a cheaper subagent (Haiku) could have handled?
- Did I do something manually that a skill already covers?
- Could a subagent have handled a repeating subtask within this session?
- Was context bloat avoidable — did I load files I didn't need, or keep large content in context longer than necessary?

If SHELL.md status is `idle` — think broader:
- Should any recurring check be added to HEARTBEAT.md?
- Is there a preference or constraint missing from OPERATOR.md?
- Would a sub-agent improve a type of work that keeps coming up?
- Would a skill formalize a workflow you keep repeating?
- Is a manual request repeating on a schedule? (e.g., "operator asked for dependency check 3 of last 4 Mondays")
  If so: create a proposal with `Type: routine` and a `## Config` block containing the routine JSON:
  ```markdown
  ## Config
  {"id":"weekly-deps","time":"09:00","days":["mon"],"skill":"claude-code-hermit:session-start --task 'dependency audit'","enabled":true}
  ```
  When accepted via `proposal-act`, this JSON is parsed and added to `config.json` routines automatically.

## Skill Health

Check whether any skill is underperforming:
- Is a skill's output consistently corrected or reworked after use?
- Is a skill being avoided in favor of manual steps?
- Did a skill fail to catch something it should have?
- Is a skill burning disproportionate tokens for the value it delivers?

If you spot a pattern:
- **Weak signal** (one-off or ambiguous): no action — not worth surfacing.
- **Moderate signal** (pattern across 2-3 sessions): create a proposal via `/claude-code-hermit:proposal-create` with the evidence (subject to three-condition rule).
- **Strong signal** (clear, repeated pattern): create a proposal via `/claude-code-hermit:proposal-create` with the evidence and include a `## Skill Improvement` section listing the skill name, observed failures, and suggested eval criteria. When the proposal is accepted via `proposal-act`, use `/skill-creator eval` and `/skill-creator improve` to implement the changes. If `/skill-creator` is not available, apply the changes to the skill's SKILL.md directly.

## Plugin Checks

If `plugin_checks` exists in config.json and has entries with `trigger: "interval"`:

1. Read `state/reflection-state.json`. Plugin check state lives under the `plugin_checks` key (initialize `{}` if missing).
2. Filter to `enabled: true` and `trigger: "interval"` entries where the matching state entry in `plugin_checks` has:
   - `last_run` null or older than `interval_days`, AND
   - `last_unavailable_at` null or older than `interval_days` (don't retry unavailable checks every reflect)
3. **Cap: one plugin check per reflect invocation.** If multiple are due, pick the one with the oldest `last_run` (null sorts first). Remaining checks fire on subsequent reflects.
4. Invoke the `skill` command string as-is. If Claude reports the skill is unavailable or not installed:
   - Log to SHELL.md Findings once: "Plugin check skipped: {id} — skill unavailable"
   - Set `last_unavailable_at` to today's ISO date (suppresses retries for `interval_days`)
   - Do NOT update `last_run` — don't count as a successful run
   - Move on
5. On successful invocation: update `last_run` to today's ISO date in `state/reflection-state.json`
6. Evaluate the output through the normal reflect outcome flow:
   - Actionable improvement → proposal candidate (tier classification applies)
   - Context improvement (CLAUDE.md fix from md-improver) → apply directly if trivial, propose if significant
   - Nothing found → increment `consecutive_empty` for this check's entry in state, no action

### Interval adjustment proposals

Track signal density per check via `consecutive_empty` in each check's `state/reflection-state.json` entry:

**Reset rules (per check):**
- Empty run → `consecutive_empty += 1`
- Any non-empty run (actionable or contextual findings) → reset `consecutive_empty = 0`
- Interval increase proposal accepted → reset to 0
- Interval increase proposal dismissed → also reset to 0 (prevents immediate re-proposal)

**Proposals:**
- **3+ consecutive empty runs** → create a proposal to increase `interval_days` (e.g., 7 → 14).
- **3+ actionable findings in a single run** → create a proposal to decrease `interval_days` (e.g., 7 → 3).
- Adjustments always go through PROP-NNN — hermit never auto-adjusts.
- These proposals use the standard three-condition rule (repeated pattern + meaningful consequence + operator-actionable).

### Guard rails

- If a check errors or times out, log the error in SHELL.md Findings and skip — don't retry until next scheduled run

## Three-Condition Rule

Only create a proposal if all three are true:
1. **Repeated pattern** — observed more than once, across sessions
2. **Meaningful consequence** — something goes wrong without fixing it
3. **Operator-actionable change** — something the operator can concretely approve

If any of the three cannot be stated concretely, do not create the proposal.
Note it in SHELL.md Findings and revisit after more sessions.

## Evidence Validation

Before acting on any proposal candidate, delegate to `claude-code-hermit:reflection-judge`.

Pass each candidate as:
```
Candidate: <title>
Tier: <1|2|3>
Evidence: <summary>
Sessions: <S-001, S-002, ...> (or "none")
```

- **ACCEPT** — proceed with the candidate at its original tier
- **DOWNGRADE:<new-tier>** — proceed at the revised tier
- **SUPPRESS** — if suppressed due to `Sessions: none`, note the candidate in SHELL.md Findings for future revisit. Otherwise drop silently.

Only act on ACCEPT and DOWNGRADE verdicts.

## Outcomes

After reflecting and validating with `claude-code-hermit:reflection-judge`, choose exactly one outcome per observation:

1. **No action** — pattern not strong enough, already handled, or already addressed by the Resolution Check above.
2. **Memory update** — fact worth recording → update project memory directly
3. **Proposal candidate** — repeated pattern + clear consequence + operator-actionable
   → classify tier (see Proposal Tier Classification below):
   - Tier 1/2: gate with `claude-code-hermit:proposal-triage` first (see below), then queue micro-approval in `state/micro-proposals.json`
   - Tier 3: gate with `claude-code-hermit:proposal-triage` first (see below), then call `/claude-code-hermit:proposal-create`

Anything that doesn't map to one of these three is not worth surfacing.
Do not generate observations for their own sake.

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

Before queuing a micro-approval or calling `proposal-create`, call `claude-code-hermit:proposal-triage`:
```
Title: <title>
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

The script handles: counter increments, `last_reflection`/`last_run_at` timestamps, missing-counters fallback, `since` preservation, and atomic write. It always exits 0 — if the write fails it logs one line to stderr and continues. Counters are diagnostic, not audit-grade — a missed increment is acceptable.

If nothing stands out: say nothing.
