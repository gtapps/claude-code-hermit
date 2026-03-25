---
name: session
description: Start or resume a work session with full context loading and mission tracking. Use at the beginning of work.
disable-model-invocation: true
---
# Session

Start or resume a session with full context loading. This is the generic session workflow — domain packs may provide specialized versions (e.g., `/claude-code-dev-hermit:dev-session` for software development with code review and testing).

## Workflow

### 1. Start or resume

Invoke `/claude-code-hermit:session-start` to check session state and load context.

### 2. If resuming an active session

- Show: mission, progress (completed/remaining steps), and blockers
- If the session status is `blocked`: suggest running `/debug` to diagnose tool/hook failures before re-attempting
- Ask: "Continue this mission, or start a new one?"

### 3. If starting a new session

- Ask: "What's the mission for this session?"
- The session-start skill handles tags and budget prompts

### 4. Plan the work

After the mission is established:
- Propose an ordered list of steps to accomplish the mission
- Confirm the plan with the operator before starting work

### 5. Execute

Work through steps using whatever tools, skills, and agents are available:
- Use the tools best suited to each step
- Update `.claude/.claude-code-hermit/sessions/ACTIVE.md` after each significant step (mark steps done, add progress log entries)
- If a step is blocked, document the blocker in ACTIVE.md and ask the operator how to proceed

### 6. Close

When the operator signals they're done, or the mission is complete:
- Invoke `/claude-code-hermit:session-close`

## Notes

- This skill does NOT prescribe a specific quality workflow (no tests, no code review, no /simplify). Those belong to domain-specific session skills.
- If you discover something worth operationalizing during work, use `/claude-code-hermit:proposal-create`.
- For monitoring recurring checks during a session, use `/claude-code-hermit:monitor`.
- Check session status anytime with `/claude-code-hermit:status`.
