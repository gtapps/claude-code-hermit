---
name: hermit-hand-back
description: Summarizes what the operator did during takeover (via git log), optionally queues instructions in NEXT-TASK.md, updates SHELL.md, and restarts the Docker container. Run locally after a /hermit-takeover session.
---
# Hermit Hand-Back

Hand control back to the autonomous hermit after an operator takeover session. Summarizes what you did, optionally leaves instructions, and restarts the container.

## Plan

### 1. Verify takeover state

Read `.claude/.claude-code-hermit/sessions/SHELL.md` and check for the `**Takeover:**` timestamp line.

- If found: extract the takeover timestamp for use in step 2
- If not found: warn "No takeover timestamp found in SHELL.md — proceeding anyway." Use a fallback of 24 hours ago for the git log.

### 2. Summarize operator activity

Build a summary of what happened during the takeover using git:

1. Run `git log --oneline --since="<takeover_timestamp>"` to get commits made during takeover
2. If there are commits: use the oldest commit's parent as the anchor — run `git log --oneline --since="<takeover_timestamp>" --format="%H" | tail -1` to get the first takeover commit, then `git diff --stat <first_commit>^..HEAD` for a file change summary
3. Format as a concise summary:
   - "3 commits during takeover: fixed auth bug, updated README, bumped version. 5 files changed."
   - Or: "No commits during takeover." (operator may have just explored, tested, or reviewed)

### 3. Ask for instructions

Ask the operator: "Any instructions for the hermit to work on next?"

- If yes: write the instructions to `.claude/.claude-code-hermit/sessions/NEXT-TASK.md`. This file is automatically picked up at the next session-start.
- If no / skip: don't create or modify NEXT-TASK.md

### 4. Update SHELL.md

1. Add a progress log entry summarizing the takeover:
   ```
   [HH:MM] Operator takeover — <git summary from step 2>. <Instructions queued / No specific instructions.>
   ```
2. Change `**Status:**` from `operator_takeover` to `idle`
3. Remove the `**Takeover:**` timestamp line

### 5. Restart the container

Run `docker compose -f docker-compose.hermit.yml up -d` in the project root.

Check that the container started: run `docker compose -f docker-compose.hermit.yml ps --status running` after a few seconds.

- If running: confirm success
- If not running: warn "Container didn't start — check `docker compose -f docker-compose.hermit.yml logs` for errors."

### 6. Confirm hand-back

Print confirmation:

```
Hermit is back online.
Takeover summary: <git summary>
Instructions: <queued / none>

Check status anytime: .claude/.claude-code-hermit/bin/hermit-status
```
