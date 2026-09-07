---
name: proposal-act
description: 'Accept, defer, dismiss, or resolve a proposal. For accepted proposals, asks how to proceed: start implementing now, create a session task, or note for manual implementation. Activates on messages like "accept PROP-", "dismiss PROP-", "defer PROP-", "resolve PROP-".'
---
# Proposal Act

Take action on a proposal: accept, defer, dismiss, or resolve.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation. On a channel-tagged turn, step 4's bounded ask (below) also queues a durable micro-proposal entry via `proposal.ts queue-micro` — see `channel-responder` § Channel-safe ask bridge — so it survives compaction or a session restart.

## Usage

```
/claude-code-hermit:proposal-act accept PROP-019
/claude-code-hermit:proposal-act defer PROP-015
/claude-code-hermit:proposal-act dismiss PROP-012
/claude-code-hermit:proposal-act resolve PROP-008
/claude-code-hermit:proposal-act accept PROP-019 --answer "session task"
```

The `--answer` form is not typed by an operator — it's how a channel-safe resolution re-enters step 4 after an out-of-band reply (see § Channel re-entry below).

If no action or ID is provided, ask the operator which proposal and action.

## Resolving a Proposal ID

Before reading any proposal file, resolve the operator's input to a filename:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts resolve-id .claude-code-hermit "<operator input>"
```
- `MATCH|<filename>` — proceed with that file.
- `NONE|not-a-prop-id` — error "Not a PROP id."
- `NONE|no-match` — error "No proposal matches [input]. Use /proposal-list to see available proposals."
- `AMBIGUOUS|<json array of {file, title}>` — show a disambiguation prompt:
  ```
  Multiple proposals match PROP-NNN:
    PROP-NNN-capability-brainstorm-103612 — [title of first match]
    PROP-NNN-session-cost-tracking-104207 — [title of second match]
  Reply with the full ID to continue.
  ```
  Re-resolve with the operator's reply.

## Timestamp Convention

All timestamps in frontmatter and Operator Decision text use ISO 8601 with timezone offset (e.g., `2026-04-06T14:30:00+01:00`). Use the timezone from `config.json` if set, otherwise UTC. `@now` in a `proposal.ts patch` `--set` value or in a stdin `Decision:`/`Set:` line expands to this stamp — prefer it over composing the timestamp yourself.

## Dashboard Refresh

Every flow below (accept, defer, dismiss, resolve) changes a proposal's status. After its final "Respond" step, refresh the dashboard and the proposals page (`config.artifacts.proposals`) per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md` — both silently, no URL re-post (unlike `proposal-create`'s initial announcement, these status-change confirmations don't append the proposals-page URL).

## Accept Flow

When the operator accepts a proposal:

1. Resolve the proposal file using the resolution algorithm above, then read it.

2. **Determine what to set.** Read `state/runtime.json` for `session_id` and `session_state` (both used below — `session_state` drives step 4's branch). From the file already read in step 1:
   - `responded`: if currently `false`, plan `--set responded=true` for the patch call below and fire the first-response event now, **before** that patch call, so its summary regen already reflects it:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts event .claude-code-hermit responded --id=PROP-NNN --action=accept
     ```
     If `responded` is already `true`, skip both (prevents double-counting).
   - `accepted_in_session`: if `session_id` is non-null, plan `--set accepted_in_session=<session_id>`. If no session is active (`session_id` is null), leave it unset (frontmatter default `null` stays).
   - `success_signal` (optional): check whether the body has a `## Success Signal` section with a non-empty predicate line (ignore comment lines starting with `<!--`). If found, validate it:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts success-signal --validate "<predicate line>"
     ```
     Exit 0 → plan a stdin `Set: success_signal=<predicate line>` line for the patch call (free text — never argv `--set`). Exit non-zero → plan a `proposal.ts shell-append` warning: `PROP-NNN success_signal ignored: <reason printed by the script>`. No section, or empty/comment-only → leave `success_signal` unset. Never block accept regardless of outcome.

3. **Patch.** One call applies the frontmatter flip, session tracking, success signal, and the Operator Decision timestamp — assembled from what step 2 determined:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts patch .claude-code-hermit <filename> \
       --set status=accepted --set accepted_date=@now \
       [--set responded=true] [--set accepted_in_session=<session_id>] --stdin <<'HERMIT_PATCH'
   Decision: Accepted on @now.
   [Set: success_signal=<predicate line>]
   HERMIT_PATCH
   ```
   Do NOT set `resolved_date` — resolution happens when reflect confirms the pattern is gone. `OK|<id>` confirms the write; `ERROR|<reason>` means nothing was patched — report it to the caller/operator and stop.

3a. **Routine proposals.** If the proposal's frontmatter `category: routine` (or a `Type: routine` line) **and** a `## Config` section with a JSON block: upsert into `config.json` after any skill/agent install below.

   **When the body also carries `## Skill Draft` and/or `## Agent Draft`:** run the install flow first (Procedure-capture install flow and the `## Agent Draft` install branch), then e.5 and e.6, then the upsert below; do not enter step 4's implementation ask. Before authoring, confirm each draft's `source_artifact` exists and is readable (search `compiled/`, then `compiled/.archive/`) — a missing or unreadable brief is the `stale-paths` rejection the step-4 gate would have raised: stop, leave `status: accepted`, write no routine, and tell the operator to re-run reflect for a fresh brief. Skip step 4's second full-artifact confirmation for this routine-bound branch only: intent was already approved through the bridged accept/dismiss ask; the skill is routine-bound, not chat-fired; the operator reverts by disabling the routine. Keep the collision guard, e.5 quality gate, and e.6 verification. A collision guard answered **Cancel** installs nothing — stop before the upsert too, so no routine is left scheduled against a skill that was never written. A standalone `## Skill Draft` with no `## Config` (Lane A) is not this branch — it keeps step 4's second confirmation.

   Then upsert:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts routine .claude-code-hermit <<'HERMIT_ROUTINE'
   <the ## Config JSON block, verbatim>
   HERMIT_ROUTINE
   ```
   The script validates `id`/`schedule`/`skill`/`enabled` are present and upserts by `id` — `OK|added` / `OK|updated`, or `ERROR|<reason>` (nothing written; report it and stop).
   - Notify the operator with one plain notice: saved (skill, and agent if any), first run time from the cron, how to stop (disable the routine).
   - Do not enter step 4 — the routine branch is complete.

4. Ask: **"How should this be implemented?"**

   **Channel-tagged turn:** do not wait interactively for a reply in this turn. Send the question via the channel reply tool in plain voice with the three options numbered — "Suggestion #N — start now, queue it as a task, or leave it to you?" (derive `#N` per `proposal-list` §4a). AND queue a pending micro-proposal entry:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts queue-micro .claude-code-hermit <<'HERMIT_MP'
   {"tier":1,"question":"Suggestion #N accepted — how should it be implemented?","options":["implement now","session task","manual"],"on_resolve":"/claude-code-hermit:proposal-act accept PROP-NNN --answer {answer}","proposal_id":"PROP-NNN"}
   HERMIT_MP
   ```
   (the `on_resolve` and `proposal_id` ids stay `PROP-NNN` — internal, never shown; `proposal_id` is what retires this ask automatically if the proposal is resolved, dismissed, or deferred before the operator answers). Then stop — steps 1-3a already ran, so `status: accepted` is a safe resting state until the operator answers (immediately in this same conversational turn, or later via the § Channel re-entry path below). The interactive terminal path below is unchanged.

   - **"Start implementing now"** (default, typical answer): run the falsification gate, then handle session lifecycle, then execute in this turn.
     **Falsification gate (runs first, before any session transition).** Verify the proposal is actionable as written with a read-only pass. Skip when the body contains `## Skill Improvement` or `## Skill Draft` — both are skill-authoring, handled in-main (step (e) / the procedure-capture install flow), not a code-edit plan. For `## Skill Draft`, first check that the `source_artifact` path exists and is readable (if the file is missing or unreadable, REJECT with code `stale-paths` — the procedure brief was removed or archived; the operator should re-run reflect to generate a fresh brief). For `## Skill Improvement`, first resolve the component name to `.claude/skills/<name>/SKILL.md`. `stale-paths` fires only when the target is provably gone: that file is missing **and** `<name>` is not an installed plugin skill (a namespaced `<plugin>:<name>` entry in the available-skills list; a bare `<name>` entry is operator-space or bundled, not a plugin one). A missing file for a name that is still an installed plugin skill is a plugin-shipped-skill improvement, not a stale path: let it through, step (e) routes it to operator space. If the available-skills list is not in context, proceed; step (e)'s operator confirmation guards the override path.

       For any other body, use the native `Plan` agent as the read-only subagent. Read only the returned text; ignore any file it writes under `~/.claude/plans/`. If the agent errors → log a one-line warning to SHELL.md Findings and continue to the session-lifecycle branch. Never block.

       Invoke with the proposal's `## Context`, `## Proposed Solution`, and `## References` sections plus this fixed instruction:
       > "You are a read-only falsification gate. Verify every cited path and symbol against the current code. `## References` also carries non-code citations (session reports `S-NNN`, `PROP-NNN`, memory names, URLs, or `n/a — <reason>`) — read those as background context only; never REJECT because one of them is not a file. Return line 1 as exactly: `REJECT: <already-done | partially-done | stale-paths | nonexistent-symbols | too-vague> — <one-line evidence>` or `PROCEED` (+ complete file list to modify). If REJECT, give file:line evidence. Do not produce a build plan for a rejected proposal. Do not write any files."

       Append the returned line-1 verdict to the proposal's `## Operator Decision` section as provenance, then branch:
       - `PROCEED` → continue to the session-lifecycle branch below (step (a)). Use the agent's complete file list over any files mentioned in the proposal body.
       - `REJECT` (stop before any session transition — `session_state` and SHELL.md `Task:` stay untouched):
         - **Interactive mode** → surface to the operator: *"Falsification gate: [verdict] — [evidence]. Proceed anyway? Y to override / N to re-scope the proposal first."* Y → continue to the session-lifecycle branch below (step (a)). N → stop; status stays `accepted`. Operator re-scopes and re-runs `/proposal-act accept PROP-NNN`.
         - **Autonomous mode** → do not implement; notify via channel: *"PROP-NNN: falsification check — [evidence]. Reply 'override PROP-NNN' to implement anyway."*
     a. Use the `session_state` already read from `state/runtime.json` in step 2 to branch.
     b. **Idle:** pipe `Task: Implement PROP-NNN: <title>` on stdin to `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts open --state-dir=.claude-code-hermit` to transition to `in_progress` and fill SHELL.md Task. Proceed to (e).
     c. **In progress:** confirm before switching: "Currently working on: <current task>. Switch to PROP-NNN? Y/N".
        - Yes: append `[HH:MM] switched to PROP-NNN: <title> (prior task: <prior task>)` to SHELL.md `## Progress Log`; overwrite SHELL.md `Task:` field with "Implement PROP-NNN: <title>"; `runtime.json session_state` stays `in_progress`. Proceed to (e).
        - No: fall back to "Create a session task" below.
     d. **Waiting:** fall back to "Create a session task" without asking, then notify: "PROP-NNN queued. Session is currently waiting."
     e. Implement the proposal. Hermit-only native settings go in operator-owned `.claude-code-hermit/claude-settings.json`; generated launch settings remain config-derived. Hooks and project-wide permissions go in the hatch-resolved settings file — read `target` from `.claude-code-hermit/state/hatch-options.json` (`local` → `.claude/settings.local.json`, `committed` → `.claude/settings.json`); when it is absent, ask `.claude-code-hermit/bin/hermit-run domain-hatch preflight claude-code-hermit` for `target`, or `target_default` when that is null, and map it the same way rather than re-deriving it — its `target_file` is the CLAUDE-APPEND destination, not a settings file. Write those entries there with `Edit`/`Write`, never a shell redirect, or the seeded ask never fires. That native ask is the operator's approval and relays to chat, so the bundled `update-config` skill is not needed for it; a hardened install has the same globs as denies, so report the block instead of routing around it. If the body contains `## Skill Improvement`, resolve the component name to `.claude/skills/<name>/SKILL.md` and author in-main (continues to e.5), branching on whether that file exists. **It exists:** read it before writing, compare each corrected behavior in the body against its current content, and author only behaviors not already present. If every listed behavior is already present, skip e.5 (nothing was written, so there is no diff to clean) but still run e.6 — a defined verification step is the only check on the already-present judgement, and a failure there means the behaviors are not actually present, so do not resolve — then run `/proposal-act resolve PROP-NNN` and tell the operator or channel that the skill was already fixed, writing nothing. **It does not exist** (the gate let it through): never write into the plugin cache and never resurrect a deleted skill — author the improvement as an operator-space override at that path and require the operator's explicit confirmation on the authored file before installing it, exactly as the `## Skill Draft` flow's step 4 does. That confirmation is what authorizes creating a file at a name the operator may have deliberately deleted — declined, or unanswered, means nothing is written. An override is a standalone skill that sits alongside the plugin one rather than merging into it, so author a complete SKILL.md (frontmatter plus the whole behavior it has to carry), not just the corrected fragment. Parse the `source_artifact:` line from the `## Skill Improvement` body; if it is present and the path is readable (search `compiled/` then `compiled/.archive/`), read the brief and use its content as input context for the revision — this anchors the improvement to the skill's original spec. Missing or unreadable anchor: proceed without it (no REJECT — an improve proposal is still actionable without the brief, unlike `## Skill Draft` which hard-rejects stale paths). If the body contains `## Skill Draft`, follow the procedure-capture install flow below (in-main; continues to e.5). Otherwise, dispatch the full implementation tail to the native `general-purpose` agent:

        **Dispatch (falsification gate returned PROCEED, no in-main skill handler):**
        Invoke `general-purpose` via the Agent tool with this prompt (fill in the bracketed value). The subagent inherits `CLAUDE.md`/`CLAUDE.local.md`, can invoke skills, and can spawn nested subagents — so it runs the whole tail (implement → quality gate → verification) in its own isolated context and returns one report.

        > Implement the accepted proposal at `<absolute path to PROP-NNN-*.md>`, then run its quality gate and verification. Work entirely in this context; your final message is the only thing returned to the caller.
        >
        > 1. Read the proposal file. The `## Operator Decision` section contains a `PROCEED` line from the falsification gate with the authoritative file list — use that list as your scope (over any files mentioned in the proposal body).
        > 2. Do the edits and any test/fix loops yourself. You may spawn a nested Explore subagent if the proposal warrants a search. Hermit-only native settings go in operator-owned `.claude-code-hermit/claude-settings.json`; generated launch settings remain config-derived. Hooks and project-wide permissions go in the hatch-resolved settings file — read `target` from `.claude-code-hermit/state/hatch-options.json` (`local` → `.claude/settings.local.json`, `committed` → `.claude/settings.json`); when it is absent, ask `.claude-code-hermit/bin/hermit-run domain-hatch preflight claude-code-hermit` for `target`, or `target_default` when that is null, and map it the same way rather than re-deriving it — its `target_file` is the CLAUDE-APPEND destination, not a settings file. Write those entries there with `Edit`/`Write`, never a shell redirect, or the seeded ask never fires. That native ask is the operator's approval and relays to chat, so the bundled `update-config` skill is not needed for it; a hardened install has the same globs as denies, so report the block instead of routing around it.
        > 3. **Quality gate.** Ask the gate; do not judge the tier or the files yourself:
        >    ```bash
        >    bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts quality-gate .claude-code-hermit <absolute path to the PROP file> --files-json '<JSON array of the files you touched, repo-root-relative>'
        >    ```
        >    One JSON line back: `{"tier","action","reason","focus_files"}`. `SKIP` → no cleanup. `RUN` → invoke `/simplify` with `focus_files` as the target, and briefly summarize the cleanup result. Best-effort: if the gate or `/simplify` errors, note it and continue — never block on this step.
        > 4. **Verification.** Read the proposal's `## Verification` section. If it has real steps (more than the HTML-comment placeholder), perform them. If a step fails, attempt **one** fix and re-verify; if it still fails, set `Verification: failed` with the output and stop (do not loop further). If the section is empty or placeholder-only, set `Verification: none defined`.
        > 5. You cannot prompt the operator — if you hit an ambiguous spec or an undecidable/destructive choice at any step, **stop and return an escalation block** rather than guessing.
        >
        > Before filling in `Status`, `Tests run` and `Verification`, audit each claim against a tool result from this run; report only what you can point to, and say plainly what is unverified.
        >
        > Return exactly this structure as your final message (nothing else):
        > ```
        > Status: implemented | escalated | blocked: <reason>
        > Touched files: <relative paths, space-separated | none>
        > Tests run: <commands + pass/fail summary | none>
        > Quality gate: <tier> — simplify <cleanup outcome> | skipped: <reason> | n/a
        > Verification: passed | failed: <output> | none defined
        > Deferred for operator: <none | what was ambiguous and the safe no-op you took>
        > ```

        **After the subagent returns** (the dispatched path ran its own quality gate + verification, so it skips main's e.5/e.6 and is handled here):
        - `Status: implemented` **and** `Verification:` is `passed` or `none defined` → run `/proposal-act resolve PROP-NNN`, then notify the operator (interactive) or channel (autonomous), building the message from the `Quality gate` field: if cleanup ran, append its brief outcome; if it is `skipped:` or `n/a`, report "PROP-NNN implemented and resolved."
        - `Verification: failed: <output>` → do **not** resolve. Surface the failure output to the operator (interactive) or channel (autonomous). Proposal status stays `accepted`.
        - `Status: escalated` or `Status: blocked: <reason>` → do **not** resolve. Surface the `Deferred for operator` block to the operator (interactive) or channel (autonomous). Proposal status stays `accepted`.


     **Procedure-capture install flow (when body contains `## Skill Draft`):**
     1. Parse `name`, `source_artifact`, `install_target`, and `triggers` from the `## Skill Draft` block.
     2. **Collision guard:** if `install_target` (`.claude/skills/<name>/SKILL.md`) already exists, do **not** overwrite. Ask the operator: "Skill `<name>` already exists at `<install_target>`. Overwrite / Rename / Cancel?" Default = **Cancel**.
     3. Read `source_artifact` (the procedure brief in `compiled/`) and author the SKILL.md: frontmatter (`name`, a `description` carrying the trigger phrases from `triggers`) plus a body distilled from the brief's procedure.
     4. **Second confirmation gate:** present the full authored SKILL.md to the operator and require an explicit yes/no before installing. An installed skill auto-loads into every future session, so the operator approves the artifact, not just the intent. Record the operator's verdict (confirmed / declined) in the PROP's `## Operator Decision` section.
        - Confirmed: proceed to install.
        - Declined: stop. Notify the operator that they can re-run `/proposal-act accept PROP-NNN` after revising the procedure brief.
     5. Create `.claude/skills/<name>/` and write the authored SKILL.md there. The procedure brief in `compiled/` stays as the permanent audit trail — do not move or delete it.
     6. **Do not auto-stage or commit** the new skill file. Notify the operator: "Skill `<name>` installed at `<install_target>`. Commit it if you want it tracked in version control."

     **`## Agent Draft` install branch (when body contains `## Agent Draft`):**
     1. Parse `name`, `source_artifact`, `install_target`, `model`, and `tools` from the `## Agent Draft` block.
     2. **Collision guard:** if `.claude/agents/<name>.md` already exists, do **not** overwrite. Ask the operator: "Agent `<name>` already exists at `<install_target>`. Overwrite / Rename / Cancel?" Default = **Cancel**.
     3. Read `source_artifact` (the procedure brief) and author the agent file: frontmatter (`name`, `description`, `model`, `tools`) plus a body distilled from the brief's worker sub-step. Same privacy handling as a new skill (`component-privacy` already covers `.claude/agents/<name>.md`).
     4. Outside step 3a's routine-bound branch, present the authored agent file in the same confirmation as the skill and require the same explicit yes/no — an installed agent is dispatchable from every future session, so the operator approves the artifact, not just the intent. Declined: write nothing.
     5. Write `.claude/agents/<name>.md`. The procedure brief in `compiled/` stays as the permanent audit trail — do not move or delete it.
     6. **Do not auto-stage or commit** the new agent file.

     **Verification for procedure-capture proposals (e.6 note):** the `## Verification` section of a procedure-capture PROP should instruct reading the installed file's frontmatter (`name`/`description` parse) rather than checking the live available-skills list — a skill written in this turn is unknown to the `Skill` tool and absent from the live list until the next user turn, so the live list is unreliable in the turn that installed it. A missing or malformed installed file blocks resolution per the normal e.6 contract.
     e.5. **Quality gate.** Applies to **in-main** implementations only (the `## Skill Improvement` and `## Skill Draft` in-main authoring branches). Dispatched implementations ran the same gate inside the subagent (step (e)) and are resolved there.

         Build a touched-files list from the writes made during the in-main implementation, written repo-root-relative (the frame `git diff --name-only` uses). If you can't reliably enumerate it (multi-turn work), omit `--files-json` and the gate falls back to the working-tree diff.

         ```bash
         bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts quality-gate .claude-code-hermit <path to the PROP file> [--files-json '["path/a","path/b"]']
         ```

         One JSON line back: `{"tier","action","reason","focus_files"}`. The script owns tier resolution, the session-bookkeeping filter, and the RUN/SKIP call — the same code the dispatched path runs, so the two cannot disagree. Act on `action`:

         - **`SKIP`** → no cleanup. Proceed to (f). Notification: "PROP-NNN implemented and resolved." (add `Skipped cleanup: <reason>` when the reason is more specific than the budget tier).
         - **`RUN`** → invoke `/simplify` with `focus_files` as the target:
           ```
           /simplify path/a path/b
           ```
           Wait for completion and briefly summarize the cleanup result in the resolution notification.

         **The quality gate is cleanup, not correctness** — `/simplify` does not check that the proposal works. Correctness is the `## Verification` gate in step (e.6); proposals with no defined verification still resolve, but the skip is recorded.

         Best-effort throughout: if the gate or `/simplify` errors, log a one-line warning to SHELL.md Findings and fall back to skip.
     e.6. **Verification gate** (in-main implementations only — dispatched implementations verify inside the subagent). Read the proposal's `## Verification` section.
         - If it contains real steps (more than the HTML-comment placeholder), perform them now — after the quality gate has applied any `/simplify` edits — before resolving. If a defined step fails, **do not resolve**: report the failure to the operator (or channel in autonomous mode) and stop.
         - If the section is empty, missing, or contains only its placeholder comment, append `Verification: none defined for PROP-NNN — skipped.` to SHELL.md `## Findings` and proceed. The omission is recorded, not blocked.

     f. **(in-main path)** When verifiably done: run `/proposal-act resolve PROP-NNN`, then notify the operator (or channel in autonomous mode) with the tier-appropriate message from (e.5). (Dispatched implementations resolve + notify in the step (e) post-return handling.)

   - **"Create a session task"** → assemble the full NEXT-TASK.md content (Task/Context/Suggested Plan derived from the proposal). The `(always, first step)` bullet below is step `1.` of the Suggested Plan, ahead of the steps derived from the proposal (it gates them, so it is worthless after them) — the derived steps are numbered from `2.`. The remaining bullets append to the end of the Suggested Plan, in order, numbered sequentially after the derived steps (quality-gate bullet is last so `/simplify` reviews any authored skill output):
       - **(always, first step)** `Read the proposal file at .claude-code-hermit/proposals/PROP-NNN-*.md and re-verify its ## References and ## Proposed Solution against the current tree with bounded reads of the cited file:line ranges, before any edit; delegate only when the citations span more than a handful of files. If the work is already done, run /claude-code-hermit:proposal-act resolve PROP-NNN and implement nothing. If the cited paths or symbols no longer exist, report the mismatch to the operator or channel and implement nothing. Either way the session did no implementation work, so close it out through the normal work-done flow instead of leaving it in progress.`
       - **(if the proposal contains `## Skill Improvement`)** `Resolve the component name to .claude/skills/<name>/SKILL.md. If it exists, read it before writing and author only the behaviors from the ## Skill Improvement body that are not already present; if all of them are already present, change nothing and say so. If it does not exist, never write into the plugin cache, and create a file at that name only after the operator explicitly confirms the authored SKILL.md, which must be complete rather than the corrected fragment alone. Use the source_artifact brief only when present, and validate the result.`
         The guards travel in the bullet because a later `/session-start` consumes the task as ordinary work, so step (e) never runs again.
       - **(if the proposal contains `## Skill Draft`)** `Author the SKILL.md from the source_artifact (see ## Skill Draft), present the final SKILL.md to the operator for confirmation, then install it to the install_target only on confirmation.`
       - **(if `quality_gate.tier` in `.claude-code-hermit/config.json` is not `"budget"` — i.e. `"balanced"` or `"quality"`)** `Before committing, run: bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts quality-gate .claude-code-hermit <this PROP file>. On "action":"RUN", run /simplify with its focus_files as the target, then commit.`
         The bullet defers the call rather than making it here: at queue time the implementation hasn't happened, so there is no diff to classify. The future session runs the same verb the other two paths run, with no `--files-json` — the working-tree diff is the evidence by then.

     Then create it — the script's exclusive create makes the "already pending" check atomic (no separate existence pre-check needed):
     ```bash
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts next-task .claude-code-hermit <<'HERMIT_NEXT_TASK'
     # Next Task (from PROP-NNN)

     ## Task
     [One-line task derived from the proposal's Proposed Solution]

     ## Context
     [Summary of the pattern/problem from the proposal, including Related Sessions]

     ## Suggested Plan
     1. [the (always, first step) re-verify bullet from above]
     2. [Step derived from Proposed Solution]
     3. [Step derived from Proposed Solution]
     4. Verify the fix resolves the pattern
     [any remaining appended bullets from above, numbered from 5.]
     HERMIT_NEXT_TASK
     ```
     - `OK` — confirm: "Task prepared. The next `/session-start` will offer this as the default task."
     - `ERROR|next-task-exists` — another proposal's task is already pending; nothing was written. Status still flips to `accepted` (operator intent is recorded, via the step 3 patch above). Notify: "PROP-NNN accepted. NEXT-TASK is already pending another proposal. Run `/session-start` to consume it first, then re-run `/proposal-act accept PROP-NNN` and pick 'Start implementing now' or manual."

   - **"I'll handle it manually"** → Just mark accepted. Respond: "Marked as accepted. No further action taken."

5. Notify the operator: "PROP-NNN accepted: [title]". On a channel-tagged turn (Step 0), use plain voice instead, matching the step-4 branch actually taken: **start now** → "Got it — starting on Suggestion #N."; **session task** → "Queued Suggestion #N as a task for the next session."; **manual** → "Marked Suggestion #N as accepted — leaving it to you." (`#N` per `proposal-list` §4a.)

## Channel re-entry (`--answer`)

When invoked as `accept PROP-NNN --answer "<label>"` (channel-responder resolving the micro-proposal entry queued by step 4's channel branch, either later in the same turn or in a fresh session): the proposal's frontmatter `status` is already `accepted` from the original turn, so skip steps 1-3a entirely — do not re-append a duplicate "Accepted on …" timestamp or re-fire the `responded` event. Match `<label>` case-insensitively by prefix against the three step-4 options and jump straight into the matching branch:

- `implement now` → **"Start implementing now"** (falsification gate onward; the autonomous-mode channel notifies specified in that branch apply as usual).
- `session task` → **"Create a session task"**.
- `manual` → **"I'll handle it manually"**.

## Defer Flow

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. **First-response tracking:** check the `responded` field. If `false`, fire the event now — before the patch call below, so its summary regen reflects it:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts event .claude-code-hermit responded --id=PROP-NNN --action=defer
   ```
   Skip if already `true`.
3. Ask: "Any note on why it's deferred or when to revisit?" (optional — operator can skip)
4. Patch:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts patch .claude-code-hermit <filename> \
       --set status=deferred --set deferred_date=@now [--set responded=true] --stdin <<'HERMIT_PATCH'
   Decision: Deferred on @now. Reason: [operator's note]
   HERMIT_PATCH
   ```
   Do NOT set `resolved_date` — deferral is not a terminal state. Omit the `Decision:` line entirely if no note was given. `OK|<id>` confirms; `ERROR|<reason>` means nothing was patched — report it and stop.
5. Respond: "PROP-NNN deferred." On a channel-tagged turn (Step 0), use plain voice instead: "Held Suggestion #N for later."

Deferred proposals still appear in `/proposal-list` but are sorted below open proposals.

## Dismiss Flow

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. **First-response tracking:** check the `responded` field. If `false`, fire the event now — before the patch call below, so its summary regen reflects it:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts event .claude-code-hermit responded --id=PROP-NNN --action=dismiss
   ```
   Skip if already `true`.
3. Ask: "Reason for dismissal?" (optional — operator can skip)
4. Patch:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts patch .claude-code-hermit <filename> \
       --set status=dismissed --set dismissed_date=@now --set resolved_date=@now [--set responded=true] --stdin <<'HERMIT_PATCH'
   Decision: Dismissed on @now. Reason: [operator's reason]
   HERMIT_PATCH
   ```
   Omit the `Decision:` line entirely if no reason was given. `OK|<id>` confirms; `ERROR|<reason>` means nothing was patched — report it and stop.
4b. **Dismissal learning** — only when a reason was provided in step 3. Judge whether the reason states a durable preference, rule, or taste that applies to a *family* of future proposals (e.g. "don't propose process changes for things I do twice a year", "stop suggesting test-coverage proposals on docs-only changes") versus a one-off or proposal-specific response ("not now", "already did this manually", "the analysis is wrong", "duplicate of last week"). If generalizable, save it through the normal auto-memory flow as a `feedback` entry: the rule, a brief `Why:`, and `How to apply:` so proposal-triage and reflection-judge can match it in their memory cross-check. One-off or sub-threshold: save nothing.
5. Respond: "PROP-NNN dismissed." If step 4b saved a preference, add: "Remembered that as a standing preference (future similar proposals may be filtered)." On a channel-tagged turn (Step 0), use plain voice instead: "Dropped Suggestion #N." (same preference-remembered addendum, in plain voice, if step 4b saved one).

Dismissed proposals are hidden from the default `/proposal-list` view. Use "show all" with `/proposal-list` to see them.

## Resolve Flow

Used when reflect has surfaced a sparse-cadence proposal as a resolution candidate (pattern absent from recent sessions but cadence too infrequent to auto-resolve). Also available directly: `/claude-code-hermit:proposal-act resolve PROP-NNN`.

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. Append a `resolved` event to proposal-metrics.jsonl — before the patch call below, so its summary regen reflects it:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts event .claude-code-hermit resolved --id=PROP-NNN
   ```
3. Patch — frontmatter flip, Operator Decision timestamp, and the compaction-boundary marker in one call:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts patch .claude-code-hermit <filename> \
       --set status=resolved --set resolved_date=@now --request-compact --stdin <<'HERMIT_PATCH'
   Decision: Resolved on @now.
   HERMIT_PATCH
   ```
   Do NOT set `dismissed_date`. When reflect's auto-resolve flow triggered this (pattern absent from recent sessions), the caller may append "Pattern confirmed absent." to the Decision line.

   `--request-compact` writes `state/compact-requested.json` (`{"requested_at": <now>, "reason": "proposal-resolve"}`, singleton — overwrite unconditionally). A resolved proposal's implementation is fully committed, so this is a safe moment for the watchdog's routine-hygiene compactor (`maybeContextCompact`) to waive its interval cooldown on the next tick. Both the dispatched-path post-return handling and the in-main path (f) route through this Resolve Flow, so one call here covers both; batched overwrites of the same singleton coalesce into a single compaction (existing operator-silence + quiescence guards).

   `OK|<id>` confirms; `ERROR|<reason>` means nothing was patched — report it and stop.
4. Respond: "PROP-NNN resolved."

No first-response tracking on resolve — the proposal was already accepted and that event was already logged.
