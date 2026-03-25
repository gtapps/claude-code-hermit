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
   - List all `.claude/.claude-code-hermit/proposals/PROP-*.md` files
   - Extract the highest NNN number, increment by 1
   - If none exist, use `PROP-001`
   - Format: `PROP-NNN` with zero-padded 3-digit number

2. Create `.claude/.claude-code-hermit/proposals/PROP-NNN.md` using `.claude/.claude-code-hermit/templates/PROPOSAL.md.template`:
   - Fill in the title, date, and session ID
   - Set status to `proposed`
   - Set `Source:` to `manual` (default) or `auto-detected` (when invoked by `pattern-detect`)
   - Set `Related Sessions:` to the relevant session IDs (optional — used by auto-detected proposals to link evidence across multiple sessions)
   - Write a clear Context, Problem, Proposed Solution, and Impact
   - Leave "Operator Decision" blank — the operator fills that in

3. Add a reference to the proposal in `.claude/.claude-code-hermit/sessions/SHELL.md` under the Findings section

## Do NOT Create Proposals For

- Trivial fixes — just fix them directly
- Style preferences — put those in `OPERATOR.md`
- Things that auto-memory already handles
- Hypothetical future needs — only real problems observed during work
