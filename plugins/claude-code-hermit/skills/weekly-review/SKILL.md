---
name: weekly-review
description: Generate the weekly review report for the current ISO week. Writes to .claude-code-hermit/compiled/review-weekly-YYYY-Www.md and sends a channel-friendly summary with an evolution block. Runs every Sunday at 23:00 via routine.
---
# Weekly Review

Generates the weekly review for the current ISO week.

## Steps

1. Run:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/weekly-review.js .claude-code-hermit
   ```

2. Report the result. On success, output the review filename. If a **Knowledge Health** section appears in the review output, summarize the issues to the operator.

3. Build the weekly evolution block from the freshly-written review file:
   - Read `.claude-code-hermit/compiled/review-weekly-<current-week>.md` frontmatter (just written in step 1).
   - Also read the prior week's `compiled/review-weekly-*.md` frontmatter (sort by `week` descending, take the second file).
   - Compute deltas directly from frontmatter values (no synthesis or inference) and format:
     ```
     ## This week's evolution
     - Cost: $X.XX (vs $Y.YY prior week, Δ+/-N%)
     - Autonomy: N% self-directed (vs M% prior, Δ+/-N pp)
     - Proposals: +A created, B resolved (C pending review, D in flight)
     - Oldest open accepted: PROP-NNN (Nd since accepted) [or "none"]
     ```
   - If no prior week file exists: omit the "vs" comparisons and show this week's numbers only.
   - If the current-week file is missing (script failed): skip the evolution block entirely.

4. Channel-send the combined weekly summary:
   - Compose the message: one-line review headline (session count, cost, self-directed rate from frontmatter) followed by the evolution block from step 3.
   - Resolve the outbound channel:
     ```
     node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-outbound-channel.js .claude-code-hermit
     ```
     Parse stdout as JSON. On success (`"id"` and `"chat_id"` present), send via `mcp__plugin_<id>_<id>__reply` with `{ chat_id, text: <message> }` where `<id>` is the resolved channel name.
   - If the script exits non-zero or returns `{"error":"no_reachable_channel"}`: if `push_notifications === true` in `config.json`, fire `PushNotification(message="<one-line weekly review headline>", status="proactive")` so the summary still reaches the operator. Then append a single Findings line to `.claude-code-hermit/sessions/SHELL.md`: `"weekly-review: no reachable channel configured, channel-send skipped"`. Only log this once per session to avoid noise. Do **not** emit a `channel-send-unavailable` alert issue (weekly-review is a recurring routine, not an alert).
   - To set a preferred channel, add `"primary": "<channel-name>"` inside `channels` in `config.json`.

5. Archive expired raw artifacts:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/archive-raw.js .claude-code-hermit
   ```
   Report how many were archived, retained, and skipped.

6. Trim `state/invocation-log.jsonl` to the last 1000 entries (prevents unbounded growth):
   ```
   bash -c 'f=".claude-code-hermit/state/invocation-log.jsonl"; [ -f "$f" ] && tail -n 1000 "$f" > "$f.trim.tmp" && mv "$f.trim.tmp" "$f" || true'
   ```

## Notes

- Safe to run manually at any time — re-runs overwrite the current week's review.
- The routine is enabled by default for new installs. Existing operators who haven't opted in can enable it via `/claude-code-hermit:hermit-settings`.
- `archive-raw.js` only moves files — it never deletes. Archived files land in `raw/.archive/` and can be restored manually.
