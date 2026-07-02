---
name: weekly-review
description: Generate the weekly review report for the current ISO week. Writes to .claude-code-hermit/compiled/review-weekly-YYYY-Www.md and sends a channel-friendly summary with an evolution block. Runs every Sunday at 23:00 via routine.
---
# Weekly Review

Generates the weekly review for the current ISO week.

## Steps

1. Run:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/weekly-review.ts .claude-code-hermit
   ```

2. Report the result. On success, output the review filename. If a **Knowledge Health** section appears in the review output, summarize the issues to the operator.

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

5. Build the weekly evolution block from the freshly-written review file:
   - Read `.claude-code-hermit/compiled/review-weekly-<current-week>.md` frontmatter (just written in step 1).
   - Also read the prior week's `compiled/review-weekly-*.md` frontmatter (sort by `week` descending, take the second file).
   - Compute deltas directly from frontmatter values (no synthesis or inference) and format:
     ```
     ## This week's evolution
     - Cost: $X.XX (vs $Y.YY prior week, Δ+/-N%)
     - Autonomy: N% self-directed (vs M% prior, Δ+/-N pp)
     - Proposals: +A created, B resolved (C pending review, D in flight)
     - Oldest open accepted: PROP-NNN (Nd since accepted) [or "none"]
     - Reflect: <the `reflect:` line from the review body's ### Reflect section, or "no reflect runs">
     ```
   - If no prior week file exists: omit the "vs" comparisons and show this week's numbers only.
   - If the current-week file is missing (script failed): skip the evolution block entirely.

6. Channel-send the combined weekly summary:
   - Compose the message: one-line review headline (session count, cost, self-directed rate from frontmatter) followed by the evolution block from step 5, plus the `Topic pages:` findings from step 3 when present.
   - Resolve the outbound channel:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-outbound-channel.ts .claude-code-hermit
     ```
     Parse stdout as JSON. On success (`"id"` and `"chat_id"` present), send via `mcp__plugin_<id>_<id>__reply` with `{ chat_id, text: <message> }` where `<id>` is the resolved channel name.
   - If the script exits non-zero or returns `{"error":"no_reachable_channel"}`: if `push_notifications === true` in `config.json`, fire `PushNotification(message="<one-line weekly review headline>", status="proactive")` so the summary still reaches the operator. Then append a single Findings line to `.claude-code-hermit/sessions/SHELL.md`: `"weekly-review: no reachable channel configured, channel-send skipped"`. Only log this once per session to avoid noise. Do **not** emit a `channel-send-unavailable` alert issue (weekly-review is a recurring routine, not an alert).
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
