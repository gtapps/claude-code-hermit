# Routine Authoring

How to convert a costly, broad-context routine into a purpose-built scoped skill — the pattern
that separates a cheap always-on routine from an expensive one.

---

For the config schema and registration mechanics (linked again under **Where this fits**
below), see [Config Reference § Idle & Routines](config-reference.md#idle--routines) and
`skills/hermit-routines/SKILL.md`. This doc covers the authoring decision those references
don't: *when* a routine needs a scoped skill instead of a broad one, and how to build it.

## When a routine needs this pattern

A routine has a cost signature worth fixing when it:

- Runs frequently (daily or more) and shows up as a high-\$/run line when you scan
  `.claude/cost-log.jsonl` or run `/claude-code-hermit:cost-reflect` (no dedicated per-routine
  doctor check exists yet — compare its \$/run against other routines by hand).
- Invokes a broad, `/session-start`-style skill that loads a lot of context (recovery matrices,
  full state reads, conversational framing) to answer one narrow question ("is there anything to
  do?", "did this threshold cross?", "is this file stale?").
- Runs at the session model (no `model` override) even though its decision doesn't need the
  live conversation — it's stateless and self-contained.

None of this means every routine should be scoped. Routines whose value *is* the chat output —
a morning brief, an evening summary — need the live session and full prose; converting those
loses the thing they're for. Scope the routines that make a small decision, not the ones that
produce a report.

## The conversion checklist

1. **Author a purpose-built scoped skill** that reads only the state its decision needs, instead
   of reusing a broad skill built for interactive `/session-start` entry. A scoped skill is small
   on purpose — it exists to answer one question, not to onboard a session.

2. **Pin it to haiku** via the routine's optional `model` field
   (`skills/hermit-routines/SKILL.md:44-50`). Setting `model` dispatches the skill to an isolated
   subagent (via the Agent tool) instead of running it in the live session — no session
   conversation is inherited, only filesystem access. Two shipped defaults already do this:
   `daily-auto-close` and `doctor` are both `"model": "haiku"` in
   `state-templates/config.json.template`. Never set `model` on `heartbeat-restart` — its re-arm
   append must run in-session, and `load` ignores the override there regardless.

3. **Return a verdict line, not transcript prose.** A dispatched routine's subagent "returns only
   a one-line status to the session" (`skills/hermit-routines/SKILL.md:47,50,156`) — design the
   scoped skill's output around that from the start, rather than writing a skill that produces
   rich output and then truncating it.

4. **Add a deterministic precheck script when the gate doesn't need the model at all.** If the
   decision "is there anything to do here?" can be answered in bash — a file's mtime, a threshold
   comparison, a hash — write a precheck script that prints one token and exits 0, and only load
   the skill body on the branch that needs it. The shipped archetypes:
   - `scripts/heartbeat-precheck.ts` — emits `SKIP|<reason>`, `OK`, `AUTO_CLOSE`, or `EVALUATE`.
     Only `EVALUATE` loads the heartbeat skill body.
   - `scripts/reflect-precheck.ts` — emits `EMPTY` or `RUN|<phases-json>`. On `EMPTY` the precheck itself
     owns the audit trail (updates `reflection-state.json`, appends the Progress Log line) so
     reflect's skill body never loads on a no-op day.

   Wire the precheck into the routine's cron prompt the same way `hermit-routines` already does
   for its `reflect` special case (`skills/hermit-routines/SKILL.md:94-98`): run the script, branch
   on its single stdout line, only invoke the skill on the "do something" branch.

Applying all four steps turns a routine that always pays for a full skill load and a session-model
turn into one that usually costs a single cheap bash check, and only pays for the skill (at
haiku, in an isolated subagent) on the ticks where there's actually something to decide.

## Worked example

A content/marketing hermit ran a revenue-tracking routine daily through a broad skill that
re-derived its answer from a wide state read every time — no session-model override, no precheck.
Its \$/run was a clear outlier against the hermit's other "light" routines (illustrative figures:
roughly \$15/run against a fleet median near \$0.40/run for comparable routines).

Applying the checklist:

- Replaced the broad skill with a scoped one that reads only the specific state slice the
  decision needs.
- Pinned `model: "haiku"` on the routine, moving the run into an isolated subagent.
- Changed the skill's return to a single verdict line instead of a narrative summary.
- Added a precheck script ahead of it for the common "nothing changed since last run" case, so
  most ticks never load the skill body at all.

The routine kept its behavior and schedule; the \$/run dropped by roughly two orders of magnitude
because most fires now resolve in a bash precheck, and the ticks that do need a decision run a
narrow haiku subagent instead of a broad session-model skill.

## Where this fits

- [Config Reference § Idle & Routines](config-reference.md#idle--routines) — the `routines` array
  schema, cron rules, and the `model` field this pattern relies on.
- `skills/hermit-routines/SKILL.md` — the registration mechanism (`load`/`list`/`status`/`stop`)
  and the model-override dispatch behavior cited above.
- `scripts/heartbeat-precheck.ts`, `scripts/reflect-precheck.ts` — the shipped precheck
  archetypes to copy the shape of, not reinvent.
