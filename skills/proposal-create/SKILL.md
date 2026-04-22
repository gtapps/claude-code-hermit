---
name: proposal-create
description: Creates a proposal for a high-leverage improvement discovered during work. Only for ideas with real impact — not trivial fixes. Use when you discover something worth operationalizing.
---
# Create Proposal

Create a proposal only when you discover something with real leverage:
- A missing helper or utility that would save significant time across sessions
- A missing validation or guardrail that could prevent real errors
- A workflow improvement that would benefit multiple sessions
- A reusable pattern worth operationalizing

## Three-Condition Rule

Only create a proposal if all three are true:
1. **Repeated pattern** — observed more than once, across sessions. **Skip for `plugin-check/*`, `operator-request`, and `current-session` evidence sources** — recurrence is either established by the check's own analysis or was validated upstream by `reflection-judge`.
2. **Meaningful consequence** — something goes wrong without fixing it
3. **Operator-actionable change** — something the operator can concretely approve

If any applicable condition cannot be stated concretely, do not create the proposal.
Respond: "Not enough evidence yet. Note it in SHELL.md Findings and revisit after more sessions."

## Pre-Creation Gate

Before creating the proposal, call `claude-code-hermit:proposal-triage`. Pass `Evidence Source:` when known:
```
Title: <proposal title>
Evidence Source: <archived-session | current-session | plugin-check/<id> | operator-request>
Evidence: <one-paragraph evidence summary>
```

`Evidence Source:` is optional (default: `archived-session`).

- `CREATE` — proceed with the steps below
- `DUPLICATE:<PROP-ID> — <reason>`: stop, report to the caller: "Proposal already exists as <PROP-ID>"
- `SUPPRESS — <code>: <reason>`: stop, report the suppression reason to the caller

## How to Create

1. Determine the next proposal ID:
   - List all `.claude-code-hermit/proposals/PROP-*.md` files
   - Extract the highest NNN number, increment by 1
   - If none exist, use `PROP-001`
   - Format: `PROP-NNN` with zero-padded 3-digit number

2. Create `.claude-code-hermit/proposals/PROP-NNN.md` using `.claude-code-hermit/templates/PROPOSAL.md.template`:
   - Write YAML frontmatter with:
     - `id`: the assigned PROP-NNN
     - `status`: `proposed`
     - `source`: `manual` (default), `auto-detected` (when invoked by `reflect`), or `operator-request` (when triggered by a direct operator request)
     - `session`: the current session ID (S-NNN)
     - `created`: current ISO 8601 timestamp with timezone offset (e.g., `2026-04-06T14:30:00+01:00`). Use the timezone from `config.json` if set, otherwise UTC.
     - `related_sessions`: relevant session IDs as YAML array (optional — used by auto-detected proposals to link evidence across multiple sessions). Use `[]` if none.
     - `category`: classify as one of:
       - `improvement` — workflow or tooling fix
       - `routine` — repeating scheduled task
       - `capability` — new agent, skill, or heartbeat item
       - `constraint` — OPERATOR.md refinement
       - `bug` — incorrect or broken behavior
     - `title`: short proposal title (same text used in the H1 heading after the dash)
     - `resolved_date`: `null` (set later by reflect when pattern is confirmed gone)
   - Fill in the title in the H1 heading
   - Write a clear Context, Problem, Proposed Solution, and Impact
   - Leave "Operator Decision" blank — the operator fills that in
   - Do NOT write bullet-point metadata (`- **Created:**`, etc.) — all metadata lives in frontmatter only

3. Add a reference to the proposal in `.claude-code-hermit/sessions/SHELL.md` under the Findings section

4. Append a `created` event to proposal metrics (include `source` and `category` from the frontmatter):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.js .claude-code-hermit/state/proposal-metrics.jsonl '{"ts":"<now ISO>","type":"created","proposal_id":"PROP-NNN","source":"manual","category":"improvement"}'
   ```
5. Update state summary:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/generate-summary.js .claude-code-hermit/state/
   ```

## Do NOT Create Proposals For

- Trivial fixes — just fix them directly
- Style preferences — put those in `OPERATOR.md`
- Things that auto-memory already handles
- Hypothetical future needs — only real problems observed during work

## Capability Proposals

If the proposal affects security boundaries — permissions, network access, credential handling — clearly note the security impact so the operator can make an informed decision.

When your operational scope changes (new API, new local service, new publishing channel), create a PROP recommending deny pattern additions or networking changes. Never modify `deny-patterns.json` or Docker config directly. The operator implements security changes.

When the proposed solution involves creating a new agent, skill, heartbeat item, or OPERATOR.md change, make the Suggested Plan self-contained:

**For a new sub-agent:**
1. Create `.claude/agents/<name>.md` with:
   - Frontmatter: name, description, model (match to complexity — haiku for scanning, sonnet for reasoning), maxTurns, tools, disallowedTools, memory (project for shared team knowledge, user for personal cross-project knowledge)
   - System prompt: role, constraints from OPERATOR.md, output format
2. Test by delegating a representative task to the agent
3. Verify it produces correct output and respects constraints

**For a new skill:**
1. Create `.claude/skills/<name>/SKILL.md` with:
   - Frontmatter: name, description
   - Numbered steps covering the full workflow
2. Test by invoking the skill with a representative input
3. Verify it completes correctly

**For a heartbeat check:**
1. Add the check to `.claude-code-hermit/HEARTBEAT.md` under the appropriate group
2. Run `/claude-code-hermit:heartbeat run` to verify it evaluates correctly

**For an OPERATOR.md refinement:**
1. Present the suggested addition to the operator
2. The operator decides where and how to add it — the agent never modifies OPERATOR.md directly
