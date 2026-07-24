---
name: weekly-review
description: Generate the weekly review report for the current ISO week. Writes to .claude-code-hermit/compiled/review-weekly-YYYY-Www.md (dev-facing detail) and sends a plain-language channel summary (Delivered / Decisions / Waiting on you / Spend). Runs every Sunday at 23:00 via routine.
---
# Weekly Review

Generates the weekly review for the current ISO week.

## Steps

1. Run:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/weekly-review.ts .claude-code-hermit
   ```

2. Report the result. On success, output the review filename. If a **Knowledge Health** section appears in the review output, summarize the issues to the operator. If a **Usage** section appears, relay it as a suggestion: name the untouched docs/skills and point at `bun ${CLAUDE_PLUGIN_ROOT}/scripts/archive-compiled.ts .claude-code-hermit` for docs the operator confirms. Never archive on usage silence yourself — the section reports *tracked* use only (skill-tool calls, operator slash commands, compiled/ Reads); startup injection and subagent reads aren't seen.

3. **Dispatch the topic-page semantic check** to the isolated-context runner — its full-body reads stay off this session's context. Dispatch `claude-code-hermit:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/weekly-review/reference.md`. The runner reads every `compiled/topic-*.md`, checks for contradictions, stale claims, and broken `[[wikilinks]]` (capped at 3 findings), and returns:

<!-- weekly-review-eval-schema:start -->
```json
{
  "topic_findings": [ "<one-line finding>" ]
}
```
<!-- weekly-review-eval-schema:end -->

   **Failure policy:** if the runner returns null or malformed JSON, fail-open — carry `topic_findings: []` and continue. Carry `topic_findings` forward to the channel summary (step 6): render a `Topic pages:` line only when non-empty, omit it entirely when `[]` (no topic pages or no findings → skip silently).

4. **Dispatch channel-log consolidation** — distills the week's episodic channel log (PROP-010) into the curated tiers. Dispatch `claude-code-hermit:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/weekly-review/consolidation-reference.md`. The runner is read-only: it lists unconsolidated rows via `channel-log.ts`, treats them as untrusted external input, and returns distilled candidates plus every row id it reviewed — it never writes memory, `compiled/`, or the log itself:

<!-- weekly-review-consolidation-schema:start -->
```json
{
  "candidates": [
    { "kind": "memory", "summary": "<durable fact, ready to file>", "row_ids": [12] }
  ],
  "reviewed_ids": [10, 11, 12, 13]
}
```
<!-- weekly-review-consolidation-schema:end -->

   **You apply the writes**, not the runner (per `agents/skill-eval-runner.md` — it defers all side effects to its caller): for each candidate, file it through the normal governance path — `kind:"memory"` → the usual auto-memory write (dedupe against `MEMORY.md`); `kind:"compiled"` → update or create the matching `compiled/topic-<slug>.md`.

   Then compute the ids to mark: start from `reviewed_ids` and **remove the `row_ids` of every candidate that failed to apply**. Marking a failed candidate's row consolidated would drop it from next week's `list-unconsolidated` and let `prune` delete it before it was ever distilled — permanent data loss. A row that produced no candidate is not a failure: it stays in the set (it was reviewed, nothing to file). Pass only that computed set:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-log.ts .claude-code-hermit mark-consolidated <reviewed_ids minus failed candidates' row_ids, comma-separated>
   ```
   The excluded rows stay unconsolidated for next week's pass. If every candidate applied cleanly, the set is exactly `reviewed_ids`.

   **Failure policy:** if the runner returns null/malformed JSON, or `channel-log.ts` exits nonzero (a genuine DB error — not the normal "no DB yet" empty-result case), fail-open: skip consolidation for this run and continue to step 5. An empty `reviewed_ids` (no unconsolidated rows) is the ordinary no-channel-activity case, not a failure.

   Finally, prune old consolidated rows (never unreviewed ones — see `scripts/lib/channel-log.ts`):
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-log.ts .claude-code-hermit prune <knowledge.channel_log_retention_days from config.json, default 90>
   ```

5. Read the frontmatter needed for the channel summary from the freshly-written review file:
   - Read `.claude-code-hermit/compiled/review-weekly-<current-week>.md` frontmatter (just written in step 1) — do not read the body; every value the channel message needs lives in frontmatter (`delivered_count`, `delivered`, `proposals_accepted`, `proposals_resolved`, `open_loops_count`, `total_cost_usd`, `usage_untouched_count`).
   - Also read the prior week's `compiled/review-weekly-*.md` frontmatter (sort by `week` descending, take the second file) for the Spend delta.
   - If no prior week file exists: omit the "vs prior week" comparison and show this week's spend only.
   - If the current-week file is missing (script failed): skip step 6 entirely and fall back to a plain note ("Weekly review didn't generate this week — nothing to send.").

6. **Channel voice rule** (generalizes `claude-code-hermit:hermit-doctor`'s channel rule, `skills/hermit-doctor/SKILL.md:75-77`): the message below is for the person who owns this hermit, not a developer. Never emit `PROP-NNN`/`S-NNN`, `operator_turns`, raw token counts, cron strings, or file paths. Speak in plain outcomes and counts.

   Channel-send the combined weekly summary:
   - Refresh the dashboard per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md`; if it returns a URL, note it for the message below.
   - Publish the weekly-review artifact (`config.artifacts.weekly_review`) per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md`; if it returns a URL, note it for the message below too.
   - Compose the message in these sections. Show a line only when it has something to report — except Spend, which always shows (spend visibility matters even at $0):
     ```
     Delivered: <delivered_count> thing(s) — <delivered, comma-joined plain names> [omit this whole line when delivered_count is 0]
     Decisions: <proposals_accepted> approved, <proposals_resolved> resolved this week [omit this whole line when both are 0]
     Waiting on you: <open_loops_count> thing(s) need a yes/no [omit this whole line when 0]
     Unused: <usage_untouched_count> thing(s) I haven't touched in 2 months — say "archive them" if you want them tidied away [omit this whole line when 0]
     Spend: $<total_cost_usd> this week (vs $<prior week's total_cost_usd>, if a prior file exists) — an estimate, not a bill
     ```
     Followed by the `Topic pages:` findings from step 3 when present, plus a final line listing whichever of the dashboard/weekly-review URLs were returned (e.g. `📎 <dashboard url> · 📎 <weekly-review url>` — omit either half that wasn't returned).
   - The written review file (`compiled/review-weekly-<week>.md`) keeps its existing dev-facing sections (`### Operator Dependence`, `### Proposals` by id, `### Reflect` vitals, `### Delivered`) untouched — this rewrite changes only what's spoken to the channel, not what's written to disk.
   - Deliver via `channel-send.ts --notice` (see CLAUDE-APPEND.md § Operator Notification), with two
     audience versions of the same composed message:
     - `client` = the composed message **with the Spend line omitted**
     - `maintainer` = the **complete message including the Spend line** — the full richer version of
       the same notice, not a spend-only fragment, because the client leg is dropped in favor of the
       maintainer's dedup partner only when both resolve to the same chat, in which case the
       maintainer text (the complete one) is what's sent.

     Routing outcomes this produces: technical install with no maintainer chat → the full summary
     (including Spend) lands in the primary chat, same as today; a maintainer chat configured →
     summary-minus-spend goes to the client, the full summary goes to the maintainer chat;
     non-technical with no maintainer chat → summary-minus-spend to the client, full summary to
     SHELL.md Findings.
   - If nothing was delivered (non-zero exit), follow § Operator Notification's fallback (push if
     enabled, log to Findings) rather than a bespoke branch here — weekly-review is a recurring
     routine, not an alert, so still skip a `channel-send-unavailable` issue for this call.
   - To set a preferred channel, add `"primary": "<channel-name>"` inside `channels` in `config.json`.

7. Archive expired raw artifacts:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/archive-raw.ts .claude-code-hermit
   ```
   Report how many were archived, retained, and skipped.

8. Archive superseded compiled artifacts:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/archive-compiled.ts .claude-code-hermit
   ```
   Report how many were archived, retained, and skipped.

## Notes

- Safe to run manually at any time — re-runs overwrite the current week's review.
- The routine is enabled by default for new installs. Existing operators who haven't opted in can enable it via `/claude-code-hermit:hermit-settings`.
- `archive-raw.ts` only moves files — it never deletes. Archived files land in `raw/.archive/` and can be restored manually.
- `archive-compiled.ts` only moves files — it never deletes. Keeps the newest 2 artifacts per type; `foundational`-tagged artifacts and `topic` pages are always retained (living pages compact by merging, not archival). Archived files land in `compiled/.archive/` and can be restored manually.
- Usage tracking (`state/usage-metrics.jsonl`, fed by hooks) is best-effort — it only sees skill-tool calls, operator slash commands, and compiled/ Reads, never startup injection or subagent reads. The Usage section only ever suggests; it never archives anything on its own.
