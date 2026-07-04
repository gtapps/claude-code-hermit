---
name: hermit-routines
description: Manages scheduled routines as per-session CronCreate jobs. Each enabled routine in config.json becomes an idle-gated CronCreate registered at session launch.
---
# Routines

Register and manage scheduled routines as per-session CronCreate jobs. Each routine fires only when the REPL is idle — no mid-task interruptions. Mirrors the `/watch` skill pattern.

## Usage

```
/claude-code-hermit:hermit-routines load              register all enabled config.routines as CronCreates
/claude-code-hermit:hermit-routines list              list configured routines from config.json
/claude-code-hermit:hermit-routines status            list active CronCreate registrations
/claude-code-hermit:hermit-routines stop [id]         stop a specific routine's CronCreate
/claude-code-hermit:hermit-routines stop --all        stop all active routine CronCreates
```

## Plan

### load

Called automatically by `hermit-start.ts` on always-on launches. Can also be called manually to apply config changes mid-session.

1. Resolve the plugin root path: derive it from this skill's **Base directory**, which the harness injects into the invocation context as `<plugin_root>/skills/hermit-routines`. Strip the trailing `/skills/hermit-routines` to get `pluginRoot`. This works in both installed and `--plugin-dir` modes. (`$CLAUDE_PLUGIN_ROOT` is NOT a Bash env var at runtime — evaluating it in Bash always returns empty. The braced `${CLAUDE_PLUGIN_ROOT}` form is text-substituted in skill markdown only in installed mode. Neither is reliable here — always use the Base-directory derivation.) Read `config.timezone` from `.claude-code-hermit/config.json`. Store as `configTz` (may be null — the shift helper treats null as a no-op). The resolved `pluginRoot` must be baked into each routine's prompt at registration — it is not available inside cron-delivered prompts.

   **Validate `pluginRoot` before proceeding.** If `pluginRoot` is empty or `<pluginRoot>/scripts/log-routine-event.sh` does not exist (`test -f`), abort `load` immediately — do **not** run the Step 3 reset or register any CronCreate — and log one line: `Routine load aborted: plugin scripts not found at "<pluginRoot>". No routines registered or reset.` This is a whole-`load` abort, not the per-routine isolation of Step 4: a bad `pluginRoot` breaks every routine's baked paths, and aborting before Step 3 protects the prior session's CronCreates from being torn down and left unreplaced.
2. Read `config.routines`, filter `enabled: true`. If none, log "No enabled routines in config." and stop.
3. Call `CronList`. For each entry whose prompt contains `[hermit-routine:`: call `CronDelete` with its ID. Unconditional reset — ensures stale entries from prior sessions are cleared and the 7-day auto-expiry clock is reset.
4. For each enabled routine, build the prompt string (see templates below), then call `CronCreate`:
   - **Compute the timezone-shifted schedule**: run `bun <pluginRoot>/scripts/cron-tz-shift.ts "<routine.schedule>" "<configTz>"` via Bash. Use the script's stdout (trimmed) as the `cron` value. If the script writes a `WARN:` line to stderr, record it for the Step 5 summary but proceed — the script outputs the original schedule unchanged on unsupported patterns.
   - `cron`: the shifted schedule (script stdout)
   - `recurring`: true
   - `durable`: false
   - `prompt`: the resolved prompt string

   **Per-routine error isolation:** if `CronCreate` throws for one routine (bad cron expression, hit the 50-task session limit, etc.), record the failure and continue with the next routine. Do not abort the loop — one bad config entry must not prevent unrelated routines from registering.
5. Log one line summarizing outcomes: `Routines registered: <id1>, <id2> (<N> ok, <M> failed[, <K> tz-shifted, <W> tz-warned])`. If any failed, list each failed id with the error on its own line. If any warned, list each warned id with the WARN reason on its own line.

#### Prompt templates

Use `run_during_waiting` (rdw) from the config entry to select the template. Default `run_during_waiting` is `false` when the field is absent.

**Model-override substitution.** Read the routine's optional `model` field. First, if `id === "heartbeat-restart"`, treat `model` as absent regardless of its value — its re-arm append must run in the session, so it is never dispatched to a subagent. Then: if `model` is absent/null, use the literal `invoke /<skill>` clause in the templates below (current behavior). If set to a non-null `<model>`, replace that clause — `invoke /<skill>` in the rdw=false template, `Invoke /<skill>` (capitalized) in the rdw=true template — with the **Agent-dispatch clause**:

```
dispatch the skill via the Agent tool: subagent_type "general-purpose", model "<model>", prompt "Invoke the skill /<skill> to completion in this project, following its instructions exactly, including any reads/writes to .claude-code-hermit/ state files. Return only a one-line status."
```

The Agent runs in isolated context (no live session conversation, but full filesystem access) and returns only a one-line status to the session. The waiting-check, `log-routine-event.sh` call, and any `heartbeat-restart`/`reflect_after` appends stay in the session turn and run at the session model.

Both templates below consult the binding pause flag (PROP-015) before firing —
`bun <pluginRoot>/scripts/hermit-pause.ts status --quiet` prints exactly
`PAUSED` or `OK` (same deterministic-token convention as `reflect-precheck.ts`'s
`EMPTY`/`RUN`). Registration itself stays unconditional — a registration-skip
would leave routines dead after resume until the next daily re-arm.

**rdw=true** — routine fires even when `session_state` is `waiting`:
```
[hermit-routine:<id>] First run:
bun <pluginRoot>/scripts/hermit-pause.ts status --quiet
If the output is PAUSED, run:
<pluginRoot>/scripts/log-routine-event.sh <id> skipped-paused
and stop. Otherwise: run:
<pluginRoot>/scripts/log-routine-event.sh <id> started
Then Invoke /<skill>. After it completes, run:
<pluginRoot>/scripts/log-routine-event.sh <id> fired
```

**rdw=false** (default) — routine is suppressed when `session_state` is `waiting`:
```
[hermit-routine:<id>] Read .claude-code-hermit/state/runtime.json. If session_state is "waiting", run:
<pluginRoot>/scripts/log-routine-event.sh <id> skipped-waiting
and stop. Otherwise: run:
bun <pluginRoot>/scripts/hermit-pause.ts status --quiet
If the output is PAUSED, run:
<pluginRoot>/scripts/log-routine-event.sh <id> skipped-paused
and stop. Otherwise: first run:
<pluginRoot>/scripts/log-routine-event.sh <id> started
Then invoke /<skill>. After it completes, run:
<pluginRoot>/scripts/log-routine-event.sh <id> fired
```

Replace `<pluginRoot>` with the resolved absolute path from step 1, `<id>` with the routine's `id`, and `<skill>` with the routine's `skill` field. The skill string is passed verbatim to the slash invocation (so `claude-code-hermit:brief --morning` becomes `/claude-code-hermit:brief --morning`). `log-routine-event.sh` takes `<id> <event>` only.

**Special case — `heartbeat-restart`:** append ` Then invoke /claude-code-hermit:hermit-routines load to re-arm all routine CronCreates and reset the 7-day expiry clock.` to the prompt (after the trailing `fired` log line). Daily re-arm via this routine is what keeps routine CronCreates from ever reaching the 7-day auto-expiry in always-on deployments.

**`reflect_after: true`:** when a routine config entry has `reflect_after: true`, append ` Then, only if the skill actually fired (not skipped-waiting), invoke /claude-code-hermit:reflect --quick.` to the prompt (after the trailing `fired` log line, and after the `heartbeat-restart` append if both apply). **Skip this append when the routine's `skill` is `claude-code-hermit:reflect`** — chaining reflect after reflect is wasteful and a config foot-gun.

**Special case — the routine's `skill` is exactly `claude-code-hermit:reflect`** (the scheduled full-reflect routine; not `--quick`/`--scheduled-checks` variants): reflect's 42KB body should not load on days with nothing to reflect on, so gate it in the prompt. In both templates, replace the `invoke /<skill>` / `Invoke /<skill>` clause with:
```
run <pluginRoot>/scripts/reflect-precheck.ts .claude-code-hermit <pluginRoot>. If its first output line is exactly `EMPTY`, do not invoke reflect — the precheck already updated reflection-state.json and appended the Progress Log line; fall through to the `fired` log line. Otherwise (a `RUN|<phases-json>` line) invoke /claude-code-hermit:reflect --precheck-verdict '<that full line>'.
```
This runs the precheck exactly once (in bash), so an EMPTY day never loads the reflect skill body, and a RUN day passes the verdict through so reflect does not re-run the precheck. When a `model` override is set, the precheck clause stays in the session turn and only the reflect invocation is dispatched (identical to the model-override split above). This special case does not apply to `--quick` or `--scheduled-checks` invocations — those never run the cadence precheck.

### list

Show configured routines from `config.json` (not from CronList — this is the config view, not the live view).

1. Read `config.routines`.
2. If empty: "No routines configured."
3. Display table:
```
Routines (config.json):
  #  ID                 Schedule      Skill                                    RDW    RA     Model   Status
  1. heartbeat-restart  0 4 * * *     claude-code-hermit:heartbeat start       true   false  -       enabled
  2. weekly-review      0 23 * * 0    claude-code-hermit:weekly-review         false  false  -       disabled
```
`RA` is `true` when `reflect_after: true` is set on the routine entry, `false` otherwise. `Model` is the value of `model` if set, otherwise `-`.

### status

Show active CronCreate registrations for hermit routines.

1. Call `CronList`. Filter entries whose prompt starts with `[hermit-routine:`.
2. If none: "No active routine CronCreates. Run `/claude-code-hermit:hermit-routines load` to register."
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

- **Routine schedules are interpreted in `config.timezone`.** `load` shifts each routine's cron from `config.timezone` to the machine's local timezone before registering with `CronCreate` (which only knows about machine local time). If `config.timezone` is null, schedules pass through unchanged. The shift uses minute granularity, so half-hour and 45-minute IANA zones (Asia/Kolkata, Australia/Adelaide, Asia/Kathmandu) work correctly.
- **DST handling.** The offset is recomputed on every `load`. The `heartbeat-restart` daily reload self-corrects across DST transitions within 24h. **On the DST transition day itself, one fire may land at the wrong wall-clock hour** — the routine fires on the previous day's offset, then `load` runs and re-registers with the corrected offset. Schedules that cannot be expressed as a single cron after shifting (mixed day-wrap on restricted-DOW, step patterns that lose their structure) pass through unchanged with a `WARN:` line.
- **Changes take effect immediately.** `hermit-settings routines` automatically invokes `/claude-code-hermit:hermit-routines load` after writing config. If you edit `config.json` by hand, run `/claude-code-hermit:hermit-routines load` to apply — no session restart needed.
- **Interactive mode does not auto-register routines.** `hermit-start.ts` calls `/claude-code-hermit:hermit-routines load` only on always-on launches. Operators using `/session` interactively who want routines must run `/claude-code-hermit:hermit-routines load` themselves.
- **`$CLAUDE_PLUGIN_ROOT` is NOT a Bash env var at runtime** — evaluating it in Bash returns empty in all modes. The braced `${CLAUDE_PLUGIN_ROOT}` form is text-substituted in skill markdown only in installed mode. Always derive `pluginRoot` from the skill's Base directory (step 1) and bake the absolute path into each routine's prompt at registration — it is not available inside cron-delivered prompts.
- **CronCreate is idle-gated.** Routines only fire between REPL turns — never mid-task.
- **`durable: false` (default).** CronCreates die with the session. `hermit-start.ts` re-registers on every always-on launch.
- **7-day auto-expiry depends on `heartbeat-restart`.** `load` resets the 7-day clock unconditionally on each call. The `heartbeat-restart` routine fires daily and re-invokes `/claude-code-hermit:hermit-routines load`, so entries never reach expiry. **If you disable `heartbeat-restart`, routine CronCreates expire after 7 days** — re-enable it, or run `/claude-code-hermit:hermit-routines load` weekly by hand.
- **`model` (optional) runs a routine's skill in a subagent at the named model** (`opus`, `sonnet`, or `haiku`) to save cost on lightweight routines. Subagents run in **isolated context** and return only a one-line status to the session — only set `model` on self-contained, stateless routines (file/threshold/URL checks). Do **not** set it on `heartbeat-restart` (re-arm must run in the session — `load` ignores it), avoid it on `reflect`/`weekly-review` (live-session-dependent or already cheap), and **do not use it for routines whose value is chat/transcript output** (the rich output is collapsed to one line and lost). Validated by `scripts/validate-config.ts`.
