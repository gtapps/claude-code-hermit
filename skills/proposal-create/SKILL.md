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

## How to Create

1. Determine the next proposal ID:
   - List all `.claude-code-hermit/proposals/PROP-*.md` files
   - Extract the highest NNN number, increment by 1
   - If none exist, use `PROP-001`
   - Format: `PROP-NNN` with zero-padded 3-digit number

2. Create `.claude-code-hermit/proposals/PROP-NNN.md` using `.claude-code-hermit/templates/PROPOSAL.md.template`:
   - Fill in the title, date, and session ID
   - Set status to `proposed`
   - Set `Source:` to `manual` (default) or `auto-detected` (when invoked by `reflect`)
   - Set `Related Sessions:` to the relevant session IDs (optional — used by auto-detected proposals to link evidence across multiple sessions)
   - Write a clear Context, Problem, Proposed Solution, and Impact
   - Leave "Operator Decision" blank — the operator fills that in

3. Add a reference to the proposal in `.claude-code-hermit/sessions/SHELL.md` under the Findings section

## Do NOT Create Proposals For

- Trivial fixes — just fix them directly
- Style preferences — put those in `OPERATOR.md`
- Things that auto-memory already handles
- Hypothetical future needs — only real problems observed during work

## Capability Proposals

If the proposal affects security boundaries — permissions, network access, credential handling — clearly note the security impact so the operator can make an informed decision.

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
