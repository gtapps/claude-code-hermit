---
name: reflect
description: Reflect on recent work and propose improvements if patterns are noticed.
---
# Reflect

Pause and think about your recent work.

1. Read SHELL.md for current context
2. Read last 20 lines of cost-log.jsonl for cost data
3. Scan proposals/ for existing proposals (dedup, stale check, feedback loop)

Now reflect — using your memory and the context above:
- Is anything recurring that shouldn't be?
- Have you been working around something that deserves a real fix?
- Is spending proportional to the work being done?
- Are there accepted proposals that the problem hasn't come back for?
  If so, mark them resolved.

If SHELL.md status is `idle` — think broader:
- Should any recurring check be added to HEARTBEAT.md?
- Is there a preference or constraint missing from OPERATOR.md?
- Would a sub-agent improve a type of work that keeps coming up?
- Would a skill formalize a workflow you keep repeating?

Review past dismissed and deferred proposals.
Avoid re-suggesting recently dismissed ideas.
If significantly more evidence has accumulated since
a dismissal, it may be worth revisiting.

If you notice something worth proposing: create a proposal via
/claude-code-hermit:proposal-create with conversational evidence from what you remember.

If you're not sure: mention it — "I think X keeps happening.
Want me to keep an eye on it?"

If nothing stands out: say nothing.
