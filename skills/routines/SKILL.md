---
name: routines
description: Manages scheduled routines as per-session CronCreate jobs. Each enabled routine in config.json becomes an idle-gated CronCreate registered at session launch.
---
# Routines

Register and manage scheduled routines as per-session CronCreate jobs. Each routine fires only when the REPL is idle — no mid-task interruptions. Mirrors the `/watch` skill pattern.

## Usage

```
/claude-code-hermit:routines load              register all enabled config.routines as CronCreates
/claude-code-hermit:routines list              list configured routines from config.json
/claude-code-hermit:routines status            list active CronCreate registrations
/claude-code-hermit:routines stop [id]         stop a specific routine's CronCreate
/claude-code-hermit:routines stop --all        stop all active routine CronCreates
```

## Plan

### load

Called automatically by `hermit-start.py` on always-on launches. Can also be called manually to apply config changes mid-session.

1. Resolve the plugin root path: run `echo $CLAUDE_PLUGIN_ROOT` via Bash. Store as `pluginRoot`. This env var is available at skill execution time but NOT inside cron-delivered prompts — it must be baked into each prompt at registration.
2. Read `config.routines`, filter `enabled: true`. If none, log "No enabled routines in config." and stop.
3. Call `CronList`. For each entry whose prompt contains `[hermit-routine:`: call `CronDelete` with its ID. Unconditional reset — ensures stale entries from prior sessions are cleared and the 7-day auto-expiry clock is reset.
4. For each enabled routine, build the prompt string (see templates below), then call `CronCreate`:
   - `cron`: the routine's `schedule` field
   - `recurring`: true
   - `durable`: false
   - `prompt`: the resolved prompt string

   **Per-routine error isolation:** if `CronCreate` throws for one routine (bad cron expression, hit the 50-task session limit, etc.), record the failure and continue with the next routine. Do not abort the loop — one bad config entry must not prevent unrelated routines from registering.
5. Log one line summarizing outcomes: `Routines registered: <id1>, <id2> (<N> ok, <M> failed)`. If any failed, list each failed id with the error on its own line.

#### Prompt templates

Use `run_during_waiting` (rdw) from the config entry to select the template. Default `run_during_waiting` is `false` when the field is absent.

**rdw=true** — routine fires even when `session_state` is `waiting`:
```
[hermit-routine:<id>] Invoke /<skill>. After it completes, run:
<pluginRoot>/scripts/log-routine-event.sh <id> fired
```

**rdw=false** (default) — routine is suppressed when `session_state` is `waiting`:
```
[hermit-routine:<id>] Read .claude-code-hermit/state/runtime.json. If session_state is "waiting", run:
<pluginRoot>/scripts/log-routine-event.sh <id> skipped-waiting
and stop. Otherwise: invoke /<skill>. After it completes, run:
<pluginRoot>/scripts/log-routine-event.sh <id> fired
```

Replace `<pluginRoot>` with the resolved absolute path from step 1, `<id>` with the routine's `id`, and `<skill>` with the routine's `skill` field. The skill string is passed verbatim to the slash invocation (so `claude-code-hermit:brief --morning` becomes `/claude-code-hermit:brief --morning`). `log-routine-event.sh` takes `<id> <event>` only.

**Special case — `heartbeat-restart`:** append ` Then invoke /claude-code-hermit:routines load to re-arm all routine CronCreates and reset the 7-day expiry clock.` to the prompt (after the trailing `fired` log line). Daily re-arm via this routine is what keeps routine CronCreates from ever reaching the 7-day auto-expiry in always-on deployments.

### list

Show configured routines from `config.json` (not from CronList — this is the config view, not the live view).

1. Read `config.routines`.
2. If empty: "No routines configured."
3. Display table:
```
Routines (config.json):
  #  ID                 Schedule      Skill                                    RDW    Status
  1. heartbeat-restart  0 4 * * *     claude-code-hermit:heartbeat start       true   enabled
  2. weekly-review      0 23 * * 0    claude-code-hermit:weekly-review         false  disabled
```

### status

Show active CronCreate registrations for hermit routines.

1. Call `CronList`. Filter entries whose prompt starts with `[hermit-routine:`.
2. If none: "No active routine CronCreates. Run `/claude-code-hermit:routines load` to register."
3. Display table:
```
Active routine CronCreates:
  ID                 CRON-ID    SCHEDULE
  heartbeat-restart  4e007cf4   0 4 * * *
```
Extract the routine ID from the `[hermit-routine:<id>]` prefix in the prompt.

### stop

**`stop <id>`:**
1. Call `CronList`. Find the entry whose prompt contains `[hermit-routine:<id>]`.
2. If found: `CronDelete` it. Log: "Stopped routine: <id>."
3. If not found: "Routine <id> is not active (not in CronList)."

**`stop` (no id):**
1. Call `CronList`, filter `[hermit-routine:*]` entries.
2. 0 active: "No active routine CronCreates."
3. 1 active: stop it without asking.
4. 2+ active: list them, ask which one (or use `--all`).

**`stop --all`:**
1. Call `CronList`. For each `[hermit-routine:*]` entry: `CronDelete`.
2. Log: "Stopped <N> routine CronCreate(s)."

## Notes

- **Changes take effect immediately.** `hermit-settings routines` automatically invokes `/routines load` after writing config. If you edit `config.json` by hand, run `/claude-code-hermit:routines load` to apply — no session restart needed.
- **Interactive mode does not auto-register routines.** `hermit-start.py` calls `/routines load` only on always-on launches. Operators using `/session` interactively who want routines must run `/claude-code-hermit:routines load` themselves.
- **`$CLAUDE_PLUGIN_ROOT` is NOT available in cron-delivered prompts.** Always resolve and bake the absolute path at `load` time.
- **CronCreate is idle-gated.** Routines only fire between REPL turns — never mid-task.
- **`durable: false` (default).** CronCreates die with the session. `hermit-start.py` re-registers on every always-on launch.
- **7-day auto-expiry depends on `heartbeat-restart`.** `load` resets the 7-day clock unconditionally on each call. The `heartbeat-restart` routine fires daily and re-invokes `/routines load`, so entries never reach expiry. **If you disable `heartbeat-restart`, routine CronCreates expire after 7 days** — re-enable it, or run `/routines load` weekly by hand.
