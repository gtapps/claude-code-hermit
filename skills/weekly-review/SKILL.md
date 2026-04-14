---
name: weekly-review
description: Generate the weekly review report for the current ISO week. Writes to .claude-code-hermit/reviews/ and updates obsidian/Latest Review.md if the cortex is set up. Runs every Sunday at 23:00 via routine.
---
# Weekly Review

Generates the weekly review for the current ISO week.

## Steps

1. Run:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/weekly-review.js .claude-code-hermit obsidian
   ```

2. Report the result. On success, output the review filename and whether `Latest Review.md` was updated. If a **Knowledge Health** section appears in the review output, summarize the issues to the operator.

3. If `obsidian/` does not exist, the script skips the `Latest Review.md` update and logs a note. No action required — the review file is still written to `.claude-code-hermit/reviews/`.

4. Archive expired raw artifacts:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/archive-raw.js .claude-code-hermit
   ```
   Report how many were archived, retained, and skipped.

## Notes

- The routine ships `enabled: false` in the config template. Enable it after running `/claude-code-hermit:obsidian-setup`.
- Safe to run manually at any time — re-runs overwrite the current week's review.
- The weekly review does not modify any other Obsidian pages. `obsidian/Latest Review.md` is the only file updated.
- `archive-raw.js` only moves files — it never deletes. Archived files land in `raw/.archive/` and can be restored manually.
