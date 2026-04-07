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

2. Report the result. On success, output the review filename and whether `Latest Review.md` was updated.

3. If `obsidian/` does not exist, the script skips the `Latest Review.md` update and logs a note. No action required — the review file is still written to `.claude-code-hermit/reviews/`.

## Notes

- The routine ships `enabled: false` in the config template. Enable it after running `/claude-code-hermit:obsidian-setup`.
- Safe to run manually at any time — re-runs overwrite the current week's review.
- The weekly review does not modify any other Obsidian pages. `obsidian/Latest Review.md` is the only file updated.
