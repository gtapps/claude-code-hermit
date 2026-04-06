---
name: reflect
description: Reflect on recent work and propose improvements if patterns are noticed.
---
# Reflect

Pause and think about your recent work.

1. Read SHELL.md for current context
2. Read last 20 lines of cost-log.jsonl for cost data
3. Scan proposals/ for existing proposals (dedup, stale check, feedback loop). Parse metadata from YAML frontmatter if present (file starts with `---`). Fall back to parsing bullet-point metadata (`**Status:**`, `**Source:**`, etc.) for pre-Observatory proposals.

Now reflect — using your memory and the context above:
- Is anything recurring that shouldn't be?
- Have you been working around something that deserves a real fix?
- Is spending proportional to the work being done?
- Did I use tokens on work a cheaper subagent (Haiku) could have handled?
- Did I do something manually that a skill already covers?
- Could a subagent have handled a repeating subtask within this session?
- Was context bloat avoidable — did I load files I didn't need, or keep large content in context longer than necessary?
- Are there accepted proposals that the problem hasn't come back for?
  If so, mark them resolved.

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

## Three-Condition Rule

Only create a proposal if all three are true:
1. **Repeated pattern** — observed more than once, across sessions
2. **Meaningful consequence** — something goes wrong without fixing it
3. **Operator-actionable change** — something the operator can concretely approve

If any of the three cannot be stated concretely, do not create the proposal.
Note it in SHELL.md Findings and revisit after more sessions.

## Outcomes

After reflecting, choose exactly one outcome per observation:

1. **No action** — pattern not strong enough, already handled, OR previously
   accepted proposal's problem no longer appears → mark proposal resolved
2. **Memory update** — fact worth recording → update project memory directly
3. **Proposal candidate** — repeated pattern + clear consequence + operator-actionable
   → classify tier (see Proposal Tier Classification below):
   - Tier 1/2: queue micro-approval in `state/micro-proposals.json`
   - Tier 3: call `/claude-code-hermit:proposal-create`

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

### Micro-approval queuing

Before queuing, check `state/micro-proposals.json`. If `active` is not null and `status` is `pending`: do NOT create a new one. Note the candidate in SHELL.md Findings and re-evaluate next reflect cycle.

### Question format (required)

Every micro-proposal question must follow this formula exactly:

**[observed pattern + duration] + [consequence] + [exact proposed change] + "Yes / No"**

Example: "For 3 weeks I've added the same 5 hashtags manually every post. Want me to make that automatic? Yes / No"

Vague questions ("I found a pattern. Want me to improve it?") are NOT permitted. All three components must be derived from evidence before queuing.

### Queuing procedure

1. Generate ID: `MP-YYYYMMDD-N` where N increments within the same day (0, 1, 2). Check existing `micro-queued` events in `proposal-metrics.jsonl` for today to determine N.
2. Write to `state/micro-proposals.json`: set `active` to the new entry with `status: "pending"`, `follow_up_count: 0`.
3. Append `micro-queued` event to `proposal-metrics.jsonl` via `append-metrics.js`:
   `{"ts":"<now ISO>","type":"micro-queued","micro_id":"MP-YYYYMMDD-N","tier":1}`
4. If channels configured: send the question to the channel.
5. Call `generate-summary.js`.

## State Update

After each reflection run:
1. Write `state/reflection-state.json` with `{"last_reflection": "<now ISO with timezone offset from config>"}`.
2. Call `node ${CLAUDE_PLUGIN_ROOT}/scripts/generate-summary.js .claude-code-hermit/state/` to update state-summary.md immediately.

If nothing stands out: say nothing.
