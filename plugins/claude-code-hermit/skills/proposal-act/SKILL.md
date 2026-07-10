---
name: proposal-act
description: 'Accept, defer, dismiss, or resolve a proposal. For accepted proposals, asks how to proceed: start implementing now, create a session task, or note for manual implementation. Activates on messages like "accept PROP-", "dismiss PROP-", "defer PROP-", "resolve PROP-".'
---
# Proposal Act

Take action on a proposal: accept, defer, dismiss, or resolve.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation. On a channel-tagged turn, step 4's bounded ask (below) also queues a durable micro-proposal entry via `queue-micro-proposal.ts` — see `channel-responder` § Channel-safe ask bridge — so it survives compaction or a session restart.

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
bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-prop.ts .claude-code-hermit "<operator input>"
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

All timestamps in frontmatter and Operator Decision text use ISO 8601 with timezone offset (e.g., `2026-04-06T14:30:00+01:00`). Use the timezone from `config.json` if set, otherwise UTC.

## Dashboard Refresh

Every flow below (accept, defer, dismiss, resolve) changes a proposal's status. After its final "Respond" step, refresh the dashboard and the proposals page (`config.artifacts.proposals`) per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md` — both silently, no URL re-post (unlike `proposal-create`'s initial announcement, these status-change confirmations don't carry a deep link).

## Accept Flow

When the operator accepts a proposal:

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. Update the YAML frontmatter: set `status` to `accepted`, add `accepted_date` as timestamp. Do NOT set `resolved_date` — resolution happens when reflect confirms the pattern is gone. If the file uses old bullet-point metadata (`- **Status:**`), update that instead.
2b. **First-response tracking:** Check if the proposal's `responded` field is already `true`. If `false`: set `responded: true` in frontmatter, then append a `responded` event:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/proposal-metrics.jsonl '{"ts":"<now ISO>","type":"responded","proposal_id":"PROP-NNN","action":"accept"}'
   ```
   Then call `bun ${CLAUDE_PLUGIN_ROOT}/scripts/generate-summary.ts .claude-code-hermit/state/`. If `responded` is already `true`, skip the append (prevents double-counting).
3. Append a timestamp to the Operator Decision section:
   ```
   Accepted on 2026-04-06T14:30:00+01:00.
   ```

3a. **Session tracking:** Read `state/runtime.json` for `session_id` and `session_state` (both are used below). If `session_id` is non-null, set `accepted_in_session` to that session ID in the proposal's YAML frontmatter. If no session is active (`session_id` is null), leave `accepted_in_session: null`.

3b. **Routine proposals.** If the proposal metadata contains `Type: routine` and a `## Config` section with a JSON block:
    - Parse the JSON block. Validate: must have `id`, `schedule`, `skill`, `enabled` fields.
    - Check for duplicate `id` in existing `config.json` routines array — if found, update the existing entry instead of appending.
    - If no duplicate found, append the routine entry to `config.json` routines array.
    - Respond: "Routine '{id}' added to config. Run `/claude-code-hermit:hermit-routines load` to register it immediately."
    - Notify the operator.
    - Skip step 4 — no further implementation needed.

3c. **Success signal (optional).** Check whether the proposal body has a `## Success Signal` section with a non-empty predicate line (ignore comment lines starting with `<!--`).
   - If a non-empty predicate line is found, validate it:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/eval-success-signal.ts --validate "<predicate line>"
     ```
   - Exit 0 → set `success_signal: <predicate line>` in the proposal's YAML frontmatter.
   - Exit non-zero → log a one-line warning to SHELL.md Findings: `PROP-NNN success_signal ignored: <reason printed by the script>`. Leave `success_signal: null`.
   - No `## Success Signal` section, or the section is empty / comment-only → leave `success_signal: null`.
   - Never block accept regardless of outcome.

4. Ask: **"How should this be implemented?"**

   **Channel-tagged turn:** do not wait interactively for a reply in this turn. Send the question via the channel reply tool in plain voice with the three options numbered — "Suggestion #N — start now, queue it as a task, or leave it to you?" (derive `#N` per `proposal-list` §4a; never surface `PROP-NNN` or the title's bracket prefix to the channel). AND queue a pending micro-proposal entry:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/queue-micro-proposal.ts .claude-code-hermit <<'HERMIT_MP'
   {"tier":1,"question":"Suggestion #N accepted — how should it be implemented?","options":["implement now","session task","manual"],"on_resolve":"/claude-code-hermit:proposal-act accept PROP-NNN --answer {answer}"}
   HERMIT_MP
   ```
   (the `on_resolve` id stays `PROP-NNN` — internal, never shown). Then stop — steps 1-3c already ran, so `status: accepted` is a safe resting state until the operator answers (immediately in this same conversational turn, or later via the § Channel re-entry path below). The interactive terminal path below is unchanged.

   - **"Start implementing now"** (default, typical answer): run the falsification gate, then handle session lifecycle, then execute in this turn.
     **Falsification gate (runs first, before any session transition).** Verify the proposal is actionable as written with a read-only pass. Skip only when the body contains `## Skill Improvement` **and** `/skill-creator:skill-creator` is in the available-skills list (step (e) routes that to `/skill-creator:skill-creator`) — if `## Skill Improvement` is present but skill-creator is absent, the proposal becomes a code-edit implementation, so the gate runs to produce a `PROCEED` file list for the dispatch. Also skip if the body contains `## Skill Draft` — authoring is delegated to `/skill-creator:skill-creator` on accept, not a code-edit plan — but first check that the `source_artifact` path listed in `## Skill Draft` exists and is readable (if the file is missing or unreadable, REJECT with code `stale-paths` — the procedure brief was removed or archived; the operator should re-run reflect to generate a fresh brief).

       Agent selection — check the harness's available-skills list (never `claude plugin list` or disk checks):
       - `feature-dev:feature-dev` in available-skills → use `feature-dev:code-explorer` as the subagent.
       - `feature-dev:feature-dev` absent → fall back to the native `Plan` agent. Read only the returned text; ignore any file it writes under `~/.claude/plans/`.
       - If the agent errors → log a one-line warning to SHELL.md Findings and continue to the session-lifecycle branch. Never block.

       Invoke with the proposal's `## Context` and `## Proposed Solution` sections plus this fixed instruction:
       > "You are a read-only falsification gate. Verify every cited path and symbol against the current code. Return line 1 as exactly: `REJECT: <already-done | partially-done | stale-paths | nonexistent-symbols | too-vague> — <one-line evidence>` or `PROCEED` (+ complete file list to modify). If REJECT, give file:line evidence. Do not produce a build plan for a rejected proposal. Do not write any files."

       Append the returned line-1 verdict to the proposal's `## Operator Decision` section as provenance, then branch:
       - `PROCEED` → continue to the session-lifecycle branch below (step (a)). Use the agent's complete file list over any files mentioned in the proposal body.
       - `REJECT` (stop before any session transition — `session_state` and SHELL.md `Task:` stay untouched):
         - **Interactive mode** → surface to the operator: *"Falsification gate: [verdict] — [evidence]. Proceed anyway? Y to override / N to re-scope the proposal first."* Y → continue to the session-lifecycle branch below (step (a)). N → stop; status stays `accepted`. Operator re-scopes and re-runs `/proposal-act accept PROP-NNN`.
         - **Autonomous mode** → do not implement; notify via channel: *"PROP-NNN: falsification check — [evidence]. Reply 'override PROP-NNN' to implement anyway."*
     a. Use the `session_state` already read from `state/runtime.json` in step 3a to branch.
     b. **Idle:** pipe `Task: Implement PROP-NNN: <title>` on stdin to `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts open --state-dir=.claude-code-hermit` to transition to `in_progress` and fill SHELL.md Task. Proceed to (e).
     c. **In progress:** confirm before switching: "Currently working on: <current task>. Switch to PROP-NNN? Y/N".
        - Yes: append `[HH:MM] switched to PROP-NNN: <title> (prior task: <prior task>)` to SHELL.md `## Progress Log`; overwrite SHELL.md `Task:` field with "Implement PROP-NNN: <title>"; `runtime.json session_state` stays `in_progress`. Proceed to (e).
        - No: fall back to "Create a session task" below.
     d. **Waiting:** fall back to "Create a session task" without asking, then notify: "PROP-NNN queued. Session is currently waiting."
     e. Implement the proposal. If the body contains `## Skill Improvement` and `skill-creator:skill-creator` is in the available-skills list, use `/skill-creator:skill-creator` for the implementation (in-main; continues to e.5). Before invoking skill-creator, parse the `source_artifact:` line from the `## Skill Improvement` body; if it is present and the path is readable (search `compiled/` then `compiled/.archive/`), read the brief and pass its content as input context to skill-creator improve — this anchors the improvement to the skill's original spec. Missing or unreadable anchor: proceed without it (no REJECT — an improve proposal is still actionable without the brief, unlike `## Skill Draft` which hard-rejects stale paths). If the body contains `## Skill Draft`, follow the procedure-capture install flow below (in-main; continues to e.5). Otherwise, dispatch the full implementation tail to the native `general-purpose` agent (this includes `## Skill Improvement` proposals when skill-creator is absent):

        **Dispatch (falsification gate returned PROCEED, no in-main skill handler):**
        Invoke `general-purpose` via the Agent tool with this prompt (fill in the bracketed value). The subagent inherits `CLAUDE.md`/`CLAUDE.local.md`, can invoke skills, and can spawn nested subagents — so it runs the whole tail (implement → quality gate → verification) in its own isolated context and returns one report.

        > Implement the accepted proposal at `<absolute path to PROP-NNN-*.md>`, then run its quality gate and verification. Work entirely in this context; your final message is the only thing returned to the caller.
        >
        > 1. Read the proposal file. The `## Operator Decision` section contains a `PROCEED` line from the falsification gate with the authoritative file list — use that list as your scope (over any files mentioned in the proposal body).
        > 2. Do the edits and any test/fix loops yourself. You may spawn a nested Explore subagent if the proposal warrants a search.
        > 3. **Quality gate.** Read `.claude-code-hermit/config.json` → `quality_gate.tier` (treat missing/invalid as `budget`). `budget` → skip cleanup. `quality` → invoke `/claude-code-hermit:simplify` focused on the files you touched. `balanced` → decide RUN vs SKIP yourself from the touched files and the proposal's `category`: lean SKIP for `constraint`/`routine`, lean RUN for `bug`/`capability`, judge `improvement` by scope; RUN if any code (`.ts/.js/.sh/.py/.go/.rs`), `SKILL.md`/`agents/*.md`, or structural `.json/.yml` changed with new logic; SKIP if only prose/docs/declarative config or OPERATOR.md; bias toward RUN when uncertain (cleanup is cheap). On RUN invoke `/claude-code-hermit:simplify` as for `quality`; on SKIP skip. Capture `/simplify`'s totals line (`applied N · deduped M · principle-rejected K · …`). Best-effort: if `/simplify` errors, note it and continue — never block on this step.
        > 4. **Verification.** Read the proposal's `## Verification` section. If it has real steps (more than the HTML-comment placeholder), perform them. If a step fails, attempt **one** fix and re-verify; if it still fails, set `Verification: failed` with the output and stop (do not loop further). If the section is empty or placeholder-only, set `Verification: none defined`.
        > 5. You cannot prompt the operator — if you hit an ambiguous spec or an undecidable/destructive choice at any step, **stop and return an escalation block** rather than guessing.
        >
        > Return exactly this structure as your final message (nothing else):
        > ```
        > Status: implemented | escalated | blocked: <reason>
        > Touched files: <relative paths, space-separated | none>
        > Tests run: <commands + pass/fail summary | none>
        > Quality gate: <tier> — simplify <totals line> | skipped: <reason> | n/a
        > Verification: passed | failed: <output> | none defined
        > Deferred for operator: <none | what was ambiguous and the safe no-op you took>
        > ```

        **After the subagent returns** (the dispatched path ran its own quality gate + verification, so it skips main's e.5/e.6 and is handled here):
        - `Status: implemented` **and** `Verification:` is `passed` or `none defined` → run `/proposal-act resolve PROP-NNN`, then notify the operator (interactive) or channel (autonomous), building the message from the `Quality gate` field: if it carries a simplify totals line → "PROP-NNN implemented and resolved. /simplify applied N edits (M deduped, K rejected on principle)." (use "… /simplify made no changes." when N == 0, and "… /simplify completed (totals unavailable)." if the line is unparseable); if it is `skipped:` or `n/a` → "PROP-NNN implemented and resolved."
        - `Verification: failed: <output>` → do **not** resolve. Surface the failure output to the operator (interactive) or channel (autonomous). Proposal status stays `accepted`.
        - `Status: escalated` or `Status: blocked: <reason>` → do **not** resolve. Surface the `Deferred for operator` block to the operator (interactive) or channel (autonomous). Proposal status stays `accepted`.

        If the body is vague and the falsification gate did not return `PROCEED`, ask the operator for clarification before proceeding.

     **Procedure-capture install flow (when body contains `## Skill Draft`):**
     1. Parse `name`, `source_artifact`, `install_target`, and `triggers` from the `## Skill Draft` block.
     2. **Collision guard:** if `install_target` (`.claude/skills/<name>/SKILL.md`) already exists, do **not** overwrite. Ask the operator: "Skill `<name>` already exists at `<install_target>`. Overwrite / Rename / Cancel?" Default = **Cancel**.
     3. Invoke `/skill-creator:skill-creator` using `source_artifact` (the procedure brief in `compiled/`) as input. Pass the proposed `name` and `triggers` so it can author the correct frontmatter and trigger phrases. `/skill-creator:skill-creator` outputs a proposed SKILL.md.
     4. **Second confirmation gate:** present the full authored SKILL.md to the operator and require an explicit yes/no before installing. An installed skill auto-loads into every future session, so the operator approves the artifact, not just the intent. Record the operator's verdict (confirmed / declined) in the PROP's `## Operator Decision` section.
        - Confirmed: proceed to install.
        - Declined: stop. Notify the operator that they can re-run `/proposal-act accept PROP-NNN` after revising the procedure brief.
     5. Create `.claude/skills/<name>/` and write the authored SKILL.md there. The procedure brief in `compiled/` stays as the permanent audit trail — do not move or delete it.
     6. **Do not auto-stage or commit** the new skill file. Notify the operator: "Skill `<name>` installed at `<install_target>`. Commit it if you want it tracked in version control."

     **Verification for procedure-capture proposals (e.6 note):** the `## Verification` section of a procedure-capture PROP should instruct reading the installed file's frontmatter (`name`/`description` parse) rather than checking the live available-skills list — the harness only picks up new skills on the next session reload, so the live list is unreliable here. A missing or malformed installed file blocks resolution per the normal e.6 contract.
     e.5. **Quality gate (tier-branched).** Applies to **in-main** implementations only (the `## Skill Improvement` → skill-creator and `## Skill Draft` → procedure-capture branches). Dispatched implementations run their own quality gate inside the subagent (see the step (e) dispatch) and are resolved there. Read `.claude-code-hermit/config.json` → `quality_gate.tier`. Resolve per this table:

         | Config state | Resolved tier |
         |---|---|
         | `tier` is `"budget"` / `"balanced"` / `"quality"` | use as-is |
         | `tier` missing, `quality_gate` missing, or value not in enum | `budget` (log one-line warning to SHELL.md Findings) |

         Build a touched-files list from the writes made during the in-main implementation (skill-creator / skill-draft). This is the precise scope for `/claude-code-hermit:simplify` and for the judge. If you can't reliably enumerate it (multi-turn work), omit it; downstream falls back to `git diff --name-only HEAD`.

         Branch on the resolved tier:

         - **`budget`**: skip `/claude-code-hermit:simplify` entirely. Proceed to (f). Resolution notification stays plain: "PROP-NNN implemented and resolved."
         - **`quality`**: invoke `/claude-code-hermit:simplify` directly. Pass the touched-files list as focus when enumerable, otherwise invoke with no focus (it falls back to the working-tree diff):
           ```
           /claude-code-hermit:simplify focus on PROP-NNN implementation: path/a, path/b
           ```
           The skill runs three parallel reviewers (reuse, quality, efficiency), applies the edits it picks itself, and ends with a totals line: `applied N · deduped M · principle-rejected K · stale-anchor skips L · parse failures P`. Capture that line and pass through.

           Resolution notification: "PROP-NNN implemented and resolved. /simplify applied N edits (M deduped, K rejected on principle)." When `N == 0`: "PROP-NNN implemented and resolved. /simplify made no changes." If the totals line is missing or unparseable, fall back to "PROP-NNN implemented and resolved. /simplify completed (totals unavailable)." — never block resolution.
         - **`balanced`**: decide RUN vs SKIP **inline** (no subagent) using this rubric, then act as below.
           - **Scope:** use the touched-files list if enumerable; otherwise run `git diff --name-only HEAD` and drop session-bookkeeping paths (`sessions/SHELL.md`, `state/runtime.json`, `state/monitors.runtime.json`, `state/state-summary.md`, `state/*.jsonl`, `HEARTBEAT.md`, `tasks-snapshot.md`, `proposals/PROP-*.md`).
           - **Category prior** (PROP frontmatter `category`): `constraint`/`routine` → lean SKIP; `bug`/`capability` → lean RUN; `improvement` → judge by scope.
           - **RUN** if any remaining path is code (`.ts/.js/.sh/.py/.go/.rs`) with new logic, a `SKILL.md`/`agents/*.md` with new instruction text, or a `.json/.yml` with new structure — or the Proposed Solution describes new branching, loops, helpers, or near-duplicate blocks.
           - **SKIP** if all remaining paths are pure prose (`CHANGELOG.md`, `README.md`, `docs/**`), purely declarative config (`.gitignore`, value-only bumps), OPERATOR.md-only, or the candidate set is empty after filtering.
           - **Bias toward RUN when uncertain** — a false RUN wastes ~$0.25; a false SKIP misses a cleanup no one notices.

           Then act on the ≤15-word reason you settled on:
           - **RUN** → invoke `/claude-code-hermit:simplify` per the `quality` tier above. Notification: "PROP-NNN implemented and resolved. Cleanup: <reason>. /simplify applied N edits (M deduped, K rejected on principle)." When `N == 0` use "… /simplify made no changes." Same totals-missing fallback as the `quality` tier.
           - **SKIP** → skip `/claude-code-hermit:simplify`. Notification: "PROP-NNN implemented and resolved. Skipped cleanup: <reason>."

         **The quality gate is cleanup, not correctness** — `/simplify` does not check that the proposal works. Correctness is verified by the `## Verification` gate in step (e.6); proposals with no defined verification still resolve, but the skip is recorded.

         Best-effort throughout: if any step errors out (judge fails, `/simplify` failed or totals unavailable, file read fails), log a one-line warning to SHELL.md Findings and fall back to skip. The gate never blocks resolution.
     e.6. **Verification gate** (in-main implementations only — dispatched implementations verify inside the subagent). Read the proposal's `## Verification` section.
         - If it contains real steps (more than the HTML-comment placeholder), perform them now — after the quality gate has applied any `/simplify` edits — before resolving. If a defined step fails, **do not resolve**: report the failure to the operator (or channel in autonomous mode) and stop.
         - If the section is empty, missing, or contains only its placeholder comment, append `Verification: none defined for PROP-NNN — skipped.` to SHELL.md `## Findings` and proceed. The omission is recorded, not blocked.

         Unlike the e.5 quality gate (best-effort, never blocks), e.6 **blocks resolution when a defined verification step fails** — that is the correctness check the quality gate does not provide.
     f. **(in-main path)** When verifiably done: run `/proposal-act resolve PROP-NNN`, then notify the operator (or channel in autonomous mode) with the tier-appropriate message from (e.5). (Dispatched implementations resolve + notify in the step (e) post-return handling.)

   - **"Create a session task"** → Write `.claude-code-hermit/sessions/NEXT-TASK.md`:
     ```markdown
     # Next Task (from PROP-NNN)

     ## Task
     [One-line task derived from the proposal's Proposed Solution]

     ## Context
     [Summary of the pattern/problem from the proposal, including Related Sessions]

     ## Suggested Plan
     1. [Step derived from Proposed Solution]
     2. [Step derived from Proposed Solution]
     3. Verify the fix resolves the pattern
     ```
     If `NEXT-TASK.md` already exists: do **not** write. Status still flips to `accepted` (operator intent is recorded). Notify: "PROP-NNN accepted. NEXT-TASK is already pending another proposal. Run `/session-start` to consume it first, then re-run `/proposal-act accept PROP-NNN` and pick 'Start implementing now' or manual."
     Otherwise write the file. Then append any of the following bullets to the end of the Suggested Plan, in order, numbered sequentially from `4.` (quality-gate bullet is last so `/claude-code-hermit:simplify` reviews any skill-creator output):
       - **(if the proposal contains `## Skill Improvement` AND `/skill-creator:skill-creator` is available)** `Use /skill-creator:skill-creator to build and validate the skill.`
       - **(if the proposal contains `## Skill Draft`)** `Use /skill-creator:skill-creator to author the captured procedure from the source_artifact (see ## Skill Draft), present the final SKILL.md to the operator for confirmation, then install it to the install_target only on confirmation.`
       - **(if `quality_gate.tier` in `.claude-code-hermit/config.json` is not `"budget"` — i.e. `"balanced"` or `"quality"`)** `Run /claude-code-hermit:simplify on the touched files for a cleanup pass, then commit.`
     Confirm: "Task prepared. The next `/session-start` will offer this as the default task."

   - **"I'll handle it manually"** → Just mark accepted. Respond: "Marked as accepted. No further action taken."

5. Notify the operator: "PROP-NNN accepted: [title]". On a channel-tagged turn (Step 0), use plain voice instead, matching the step-4 branch actually taken: **start now** → "Got it — starting on Suggestion #N."; **session task** → "Queued Suggestion #N as a task for the next session."; **manual** → "Marked Suggestion #N as accepted — leaving it to you." (`#N` derivation and the never-surface-`PROP-NNN` rule are canonical in `proposal-list` §4a — don't restate them here.)

**Note:** There is no "Update OPERATOR.md" path. OPERATOR.md is operator-owned — the agent reads it but does not modify it. If the operator wants to update OPERATOR.md based on a proposal, they do it themselves.

## Channel re-entry (`--answer`)

When invoked as `accept PROP-NNN --answer "<label>"` (channel-responder resolving the micro-proposal entry queued by step 4's channel branch, either later in the same turn or in a fresh session): the proposal's frontmatter `status` is already `accepted` from the original turn, so skip steps 1-3c entirely — do not re-append a duplicate "Accepted on …" timestamp or re-fire the `responded` event. Match `<label>` case-insensitively by prefix against the three step-4 options and jump straight into the matching branch:

- `implement now` → **"Start implementing now"** (falsification gate onward; the autonomous-mode channel notifies already present in that branch apply as usual).
- `session task` → **"Create a session task"**.
- `manual` → **"I'll handle it manually"**.

## Defer Flow

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. Update the YAML frontmatter: set `status` to `deferred`, add `deferred_date` as timestamp. Do NOT set `resolved_date` — deferral is not a terminal state. If the file uses old bullet-point metadata (`- **Status:**`), update that instead.
2b. **First-response tracking:** Same as accept flow — check `responded` field, set to `true` if `false`, append `responded` event with `"action":"defer"`, call `generate-summary.ts`. Skip if already `true`.
3. Ask: "Any note on why it's deferred or when to revisit?" (optional — operator can skip)
4. If a note is provided, append to the Operator Decision section:
   ```
   Deferred on 2026-04-06T14:30:00+01:00. Reason: [operator's note]
   ```
5. Respond: "PROP-NNN deferred." On a channel-tagged turn (Step 0), use plain voice instead: "Held Suggestion #N for later."

Deferred proposals still appear in `/proposal-list` but are sorted below open proposals.

## Dismiss Flow

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. Update the YAML frontmatter: set `status` to `dismissed`, add `dismissed_date` and `resolved_date` as timestamps. If the file uses old bullet-point metadata (`- **Status:**`), update that instead.
2b. **First-response tracking:** Same as accept flow — check `responded` field, set to `true` if `false`, append `responded` event with `"action":"dismiss"`, call `generate-summary.ts`. Skip if already `true`.
3. Ask: "Reason for dismissal?" (optional — operator can skip)
4. If a reason is provided, append to the Operator Decision section:
   ```
   Dismissed on 2026-04-06T14:30:00+01:00. Reason: [operator's reason]
   ```
4b. **Dismissal learning** — only when a reason was provided in step 3. Judge whether the reason states a durable preference, rule, or taste that applies to a *family* of future proposals (e.g. "don't propose process changes for things I do twice a year", "stop suggesting test-coverage proposals on docs-only changes") versus a one-off or proposal-specific response ("not now", "already did this manually", "the analysis is wrong", "duplicate of last week"). If generalizable, issue the standard "remember it" reflection framed as a `feedback`-type entry: state the preference as a rule, add a brief `Why:` and `How to apply:` so proposal-triage and reflection-judge can match it in their memory cross-check. Apply auto-memory discipline: respect `WHAT_NOT_TO_SAVE` (no file paths, no debugging recipes, no facts derivable from grep), keep it concise. The native auto-memory flow writes `feedback_<slug>.md` and updates the `MEMORY.md` index — do not write those files directly. If the reason is one-off or sub-threshold, skip — save nothing.
5. Respond: "PROP-NNN dismissed." If step 4b saved a preference, add: "Remembered that as a standing preference (future similar proposals may be filtered)." On a channel-tagged turn (Step 0), use plain voice instead: "Dropped Suggestion #N." (same preference-remembered addendum, in plain voice, if step 4b saved one).

Dismissed proposals are hidden from the default `/proposal-list` view. Use "show all" with `/proposal-list` to see them.

## Resolve Flow

Used when reflect has surfaced a sparse-cadence proposal as a resolution candidate (pattern absent from recent sessions but cadence too infrequent to auto-resolve). Also available directly: `/claude-code-hermit:proposal-act resolve PROP-NNN`.

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. Update the YAML frontmatter: set `status` to `resolved`, `resolved_date` to current timestamp. Do NOT set `dismissed_date`. If the file uses old bullet-point metadata (`- **Status:**`), update that instead.
3. Append a `resolved` event to proposal-metrics.jsonl:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/proposal-metrics.jsonl '{"ts":"<now ISO>","type":"resolved","proposal_id":"PROP-NNN"}'
   ```
4. Append to the Operator Decision section:
   ```
   Resolved on 2026-04-06T14:30:00+01:00.
   ```
   If the resolve was triggered by reflect's auto-resolve flow (pattern absent from recent sessions), the caller may append "Pattern confirmed absent." but this is no longer the default — resolve also covers implementation completion via the Start-now branch.
5. **Compaction boundary marker.** Write `state/compact-requested.json` with `{"requested_at": "<now ISO>", "reason": "proposal-resolve"}` (singleton — overwrite unconditionally). A resolved proposal's implementation is fully committed, so this is a safe moment for the watchdog's routine-hygiene compactor (`maybeContextCompact`) to waive its interval cooldown on the next tick. Both the dispatched-path post-return handling and the in-main path (f) route through this Resolve Flow, so one write here covers both; batch accepts each overwrite the same singleton and coalesce into a single compaction (existing operator-silence + quiescence guards).
6. Respond: "PROP-NNN resolved."

No first-response tracking on resolve — the proposal was already accepted and that event was already logged.
