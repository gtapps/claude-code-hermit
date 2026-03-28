---
name: hermit-takeover
description: Stops the Docker container running the autonomous hermit, marks the session as operator takeover, loads full hermit context, and presents a summary. Run locally (outside Docker) when you want to drive interactively.
---
# Hermit Takeover

Stop the autonomous hermit and take the wheel. This skill is for Docker-based always-on setups — it stops the container, preserves all session state, and loads the hermit's context so you can work interactively with full continuity.

## Plan

### 1. Read config

Read `.claude-code-hermit/config.json` to get:
- `tmux_session_name` — resolve `{project_name}` with the actual project directory name
- `agent_name` — for display

### 2. Check Docker container status

Run `docker compose -f docker-compose.hermit.yml ps --status running --format '{{.Name}}'` in the project root.

- If a container is running: proceed to step 3
- If no container is running: skip to step 4 (just load state — the hermit may have already been stopped manually)
- If `docker compose` fails (Docker not installed or no compose file): inform the operator: "No docker-compose.hermit.yml found. This skill is for Docker-based setups." and stop.

### 3. Stop the container

Run `docker compose -f docker-compose.hermit.yml stop` (not `down` — we want to preserve the container for restart).

This sends SIGTERM, which triggers the entrypoint to exit cleanly. If hermit-stop runs inside the container, it archives the current report before exiting.

Wait briefly for the container to stop: check `docker compose -f docker-compose.hermit.yml ps --status running` up to 3 times with 5-second intervals. If it's still running after 15 seconds, warn: "Container is still stopping — it may take a moment for the session to archive."

### 4. Mark SHELL.md as operator takeover

Read `.claude-code-hermit/sessions/SHELL.md`.

If the file exists and has content:
- Find the `**Status:**` line and change the value to `operator_takeover`
- After the Status line, add: `- **Takeover:** YYYY-MM-DD HH:MM` with the current timestamp
- Preserve all other content (plan, progress log, blockers, cost, etc.)

If SHELL.md doesn't exist or is empty: note this for the summary — the hermit may have been idle with no active session.

### 5. Load hermit context

Read these files (all in parallel):
- `.claude-code-hermit/OPERATOR.md` — the project rulebook
- `.claude-code-hermit/sessions/SHELL.md` — current/last session state
- Latest archived report: find the most recent `S-*-REPORT.md` in `.claude-code-hermit/sessions/` (by filename sort, descending)

### 6. Present summary

Print a structured summary for the operator:

```
Takeover complete.

Session: S-NNN | was: in_progress
Task: "Add input validation to API endpoints"
Plan: 2/4 steps completed
  [x] Step 1 — done
  [x] Step 2 — done
  [ ] Step 3 — in progress
  [ ] Step 4 — pending
Blockers: none
Cost so far: $1.80

You're now driving. The hermit's full context is loaded.
When you're done, run /claude-code-hermit:hermit-hand-back to restart the hermit.
```

Adapt based on what's actually in SHELL.md:
- If there was no active task (hermit was idle): say "Hermit was idle — no active task."
- If there are blockers: highlight them
- If SHELL.md didn't exist: say "No session state found — starting fresh."

The session continues normally from here. The operator works interactively with the full hermit context loaded.
