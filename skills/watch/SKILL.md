---
name: watch
description: Background watching via the CC Monitor tool. Starts subprocesses that stream events as conversation notifications — zero token cost when quiet. Supports declared config watches (auto-registered on session start) and ad-hoc operator-invoked watches.
---
# Watch

Run background event watchers using the CC Monitor tool. Each stdout line from
the subprocess becomes a conversation notification. Silence costs zero tokens.

Two classes:
- **Stream:** Source pushes events (`tail -f`, WebSocket, fswatch). Truly event-driven.
- **Poll:** Script checks on interval, emits only on change. Same polling model, less noise.

## Usage

```
/claude-code-hermit:watch <instruction>            — start ad-hoc (poll, default 5m interval)
/claude-code-hermit:watch <stream-command>         — start ad-hoc stream
/claude-code-hermit:watch start                    — register all enabled config watches
/claude-code-hermit:watch stop [id]                — stop by id (or auto if 1 active)
/claude-code-hermit:watch stop --all               — stop all watches
/claude-code-hermit:watch status                   — list active watches from registry
```

## Runtime Registry

All active watches are tracked in `.claude-code-hermit/state/monitors.runtime.json`.
This is the **sole source of truth** — not SHELL.md.

```json
{
  "monitors": [
    {
      "id": "deploy-errors",
      "task_id": "bmg9y1le3",
      "description": "errors in deploy.log",
      "started_at": "2026-04-12T15:00:00Z",
      "source": "config",
      "class": "stream"
    }
  ],
  "last_cleared": "2026-04-12T15:00:00Z"
}
```

SHELL.md `## Monitoring` entries are a **journal only** — no code path reads
them for decisions. Start/stop decisions read from the runtime registry.

## Plan

### Starting an ad-hoc watch

1. Parse instruction + optional interval from operator message. Default interval: 5m.
2. Verify active session exists (`.claude-code-hermit/sessions/SHELL.md` must exist).
   If none: "No active session. Run `/claude-code-hermit:session` first."
3. Generate id: `adhoc-<epoch>-<4char-random>` (e.g., `adhoc-1744460400-a3f2`).
   Timestamp + random suffix avoids collisions across sessions.
4. Determine command shape:
   - If instruction is a shell command (contains pipes, flags, or path): use as-is
   - If instruction is a natural language description: wrap in a poll loop:
     ```
     while true; do <check-command> && echo "<brief-event-description>"; sleep <interval_secs>; done
     ```
5. Invoke Monitor tool with all 4 required params:
   - `description`: the operator's instruction text (shown in every notification)
   - `command`: the constructed command
   - `timeout_ms`: 300000 (ignored when persistent, but always required)
   - `persistent`: true (runs until stopped or session ends)
6. Read `state/monitors.runtime.json` (create if missing: `{"monitors": [], "last_cleared": null}`)
7. Append entry to `monitors[]` with `source: "adhoc"`
8. Write registry back
9. Log to SHELL.md `## Monitoring`: `- [ACTIVE] <instruction> (started HH:MM)`

### Starting config watches (`/watch start`)

Called automatically by session-start (step 11b). Can also be called manually.

1. Read `config.json` → `monitors[]`, filter `enabled: true`
2. Read `state/monitors.runtime.json`
3. For each enabled config watch whose `id` is NOT already in the registry:
   a. **Resolve command:** Replace the literal string `${CLAUDE_PLUGIN_ROOT}` with
      the actual env var value (available at skill execution time inside CC context;
      NOT available in Monitor subprocess). If the var is unset, log a warning and
      skip that watch.
   b. Invoke Monitor tool:
      - `description`: from config entry
      - `command`: the resolved command string
      - `timeout_ms`: `config.timeout_ms ?? 300000`
      - `persistent`: `config.persistent ?? true`
   c. Append to registry with `source: "config"` and the returned task_id
4. Write registry back
5. If any watches were registered: log to SHELL.md `## Monitoring`:
   `[HH:MM] Watches registered: <id1>, <id2> (<N> total)`
6. If all config watches were already in the registry (idempotent): no log, no output

### Stopping a watch

1. Parse id from operator message (or `--all` flag)
2. **`stop <id>`:** Look up `task_id` in registry → `TaskStop` → remove entry from registry → update SHELL.md `[ACTIVE]` to `[STOPPED]`
3. **`stop` (no id):**
   - Count ad-hoc watches in registry (`source: "adhoc"`)
   - 0 active: "No active watches to stop."
   - 1 active: stop it without asking
   - 2+ active: list them, ask which one (or use `--all`)
4. **`stop --all`:** For each entry in registry, call `TaskStop` with its `task_id`.
   Clear all entries from registry. Log to SHELL.md.
5. After any stop: write registry back

Note: If `TaskStop` returns an error for a given task_id (the watch already
died), remove the entry from the registry anyway. A dead watch's entry is stale.

### Status

1. Read `state/monitors.runtime.json`
2. If no watches: "No active watches."
3. Display a table:

```
Active watches:
  ID             SOURCE   CLASS   STARTED    DESCRIPTION
  deploy-errors  config   stream  15:00      errors in deploy.log
  adhoc-...      adhoc    poll    16:30      check error rate in app metrics
```

### Handling self-exit notifications

When a Monitor subprocess exits on its own (timeout, script crash, or clean exit),
CC sends a completion notification into the conversation. On seeing this:

1. Match the `task_id` from the notification against the runtime registry
2. If found: remove the entry and write registry back
3. Log to SHELL.md: `[HH:MM] Watch <id> exited`

If the notification is missed (compaction, context pressure), the stale entry is
harmless. The next session start clears the registry unconditionally.

## Notes

- **All 4 Monitor tool params are required.** Always pass `timeout_ms` even when
  `persistent: true` (the tool schema requires it; the value is ignored).
- **`$CLAUDE_PLUGIN_ROOT` is NOT available in Monitor subprocess.** Resolve it at
  registration time. `$PWD` is the project root in the subprocess.
- **`grep --line-buffered` is required in pipes.** Without it, pipe buffering can
  delay events by minutes.
- **Filesystem events in Docker:** Use `inotifywait` (from `inotify-tools`, included in the hermit base image) instead of `fswatch` (macOS-only). Example stream command: `inotifywait -m -r --format '%w%f %e' -e modify,create,delete src/`.
- **Config hot-reload:** Config watches do NOT hot-reload during a session.
  Changes to `config.json` monitors only apply at the next session start
  or after a manual `/watch stop <id>` + `/watch start`.
- On `/session-close`: session-close stops all watches before archiving. The
  registry is cleared.
- On session start: the registry is cleared unconditionally before registering
  config watches. Monitors are session-scoped.
