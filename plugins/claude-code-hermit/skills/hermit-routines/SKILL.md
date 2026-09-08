---
name: hermit-routines
description: Schedules routines via one persistent Monitor subprocess (zero-token skips); CronCreate fallback where Monitor is unavailable. heartbeat-restart stays a CronCreate re-arm anchor.
---
# Routines

Register and manage scheduled routines. Where the Monitor tool is available, all enabled routines except `heartbeat-restart` run from ONE persistent Monitor subprocess that decides eligibility outside the session — a skipped fire costs zero model tokens. `heartbeat-restart` stays a CronCreate **re-arm anchor**: its skill IS `load`, so its daily fire re-arms the monitor and the anchor CronCreate — and, unless `heartbeat.enabled` is explicitly false, restores the heartbeat monitor too. The watchdog re-arms a monitor whose liveness has gone stale as a second net, on a resting session too. Where Monitor is unavailable (Bedrock/Google Cloud Agent Platform/Foundry, `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), `load` falls back to per-routine CronCreates.

## Usage

```
/claude-code-hermit:hermit-routines load              register/reconcile: monitor mode if available, else CronCreate diff-register
/claude-code-hermit:hermit-routines load --reset      unconditional reset: tear down + recreate everything
/claude-code-hermit:hermit-routines run <ids>          [internal] ROUTINE_DUE handler — invoked by the monitor's notification
/claude-code-hermit:hermit-routines list               list configured routines from config.json
/claude-code-hermit:hermit-routines status              show monitor/anchor state (or CronCreate registrations in fallback mode)
/claude-code-hermit:hermit-routines stop [id]           stop the monitor (or a specific fallback-mode CronCreate)
/claude-code-hermit:hermit-routines stop --all          stop everything
```

`list`, `status`, `stop` and the notes live in `reference.md`, beside this file in the skill's **Base directory** — `Read` it for those. `load` and `run` stay here: every always-on launch pays for them.

## Plan

### load

Called automatically by `hermit-start.ts` on always-on launches. Can also be called manually to apply config changes mid-session.

1. Resolve the plugin root path: derive it from this skill's **Base directory**, which the harness injects into the invocation context as `<plugin_root>/skills/hermit-routines`. Strip the trailing `/skills/hermit-routines` to get `pluginRoot`. This works in both installed and `--plugin-dir` modes. (`$CLAUDE_PLUGIN_ROOT` is NOT a Bash env var at runtime — evaluating it in Bash always returns empty. The braced `${CLAUDE_PLUGIN_ROOT}` form is text-substituted in skill markdown only in installed mode. Neither is reliable here — always use the Base-directory derivation.) The resolved `pluginRoot` must be baked into the Monitor `command` and into any CronCreate-delivered prompt at registration — it is not available inside either subprocess or cron-delivered prompts.

   **Validate `pluginRoot` before proceeding.** If `pluginRoot` is empty, or either of `<pluginRoot>/scripts/routines.ts` (the `log-event`/`precheck`/`cron-registry` verbs all live in it) or `<pluginRoot>/scripts/routine-monitor.sh` does not exist (`test -f` on each path), abort `load` immediately — do not register/delete anything — and log one line: `Routine load aborted: plugin scripts not found at "<pluginRoot>". No routines registered or reset.`
2. **Ask what needs arming:**
   ```
   bun <pluginRoot>/scripts/routines.ts arm begin .claude-code-hermit <pluginRoot>
   ```
   It reads config, the runtime mirror and both liveness files, and returns the whole plan. Append ` --reset` for `load --reset` (below). Its first line decides the branch:

   - **`HEALTHY|routines=<mode:n>|anchor_age=<d.d>d|heartbeat=<ok|disabled>`** — the monitor is registered, ticking, and current; the anchor and heartbeat legs are too. **Log that one line and stop.** Re-arming a healthy monitor is pure spend.
   - **`ARM|<legs>|<reasons>`** — execute the plan block that follows, in order. Every subsequent line is optional and appears only when it applies.
   - **`ARM|routines,heartbeat|check-error:<reason>`** — the verb could not read `config.json` or the mirror, so it emitted no plan. Abort `load`: register or delete nothing, and log `Routine load aborted: arm check failed — <reason>. No routines registered.`

3. **Execute the `ARM` plan block.** Fetch its five deferred tools in one `ToolSearch` — `select:Monitor,TaskStop,CronCreate,CronList,CronDelete` — not one call each. The lines, in the order they are printed:
   - `HB_OLD_TASK:<id>` / `HB_FIRST_START:1` / `HB_INTERVAL:<s>` / `HB_CMD:<command>` — the **heartbeat leg**, planned here so one `load` arms both monitors. `TaskStop` the `HB_OLD_TASK` id if present (ignore not-found), register a Monitor exactly as `MONITOR_CMD` below but `description: "heartbeat-monitor"` with the `HB_CMD` string, and pass its task id to step 4 as `--heartbeat`. **No `HB_` line** means that leg is current or disabled: register nothing, pass `none`.
   - `OLD_TASK:<id>` — `TaskStop` it (ignore not-found). Printed unless the record belongs to a previous boot, whose task died with that process; a record with no `boot_id` at all was written by this one.
   - `FIRST_TRANSITION:1` — this is a first transition into monitor mode (never printed on the `--fallback` leg, where those crons are the routines). Also `CronList` and `CronDelete` every entry whose prompt contains `[hermit-routine:` **except** `[hermit-routine:heartbeat-restart]` — live crons from an in-process upgrade that the mirror no longer tracks (duplicate-fire hazard). Skip this sweep entirely when the line is absent.
   - `MONITOR_CMD:<command>` — register the Monitor: `description: "routine-monitor"` (reserved slot), `command:` **the string verbatim, unedited** (it is already absolute; `$PWD` would trigger Claude Code's `simple_expansion` approval), `timeout_ms: 86400000` (schema-required boilerplate on a persistent monitor — it does not expire on this deadline), `persistent: true`.
   - `MONITOR_SKIP:zero-scheduled` — instead of the above: register no Monitor (only the anchor is enabled), and pass `none` as the task id in step 4.
   - `DELETE:<id>` / `CREATE:<id>|<schedule>` / `WARN:<id>|<reason>` / `KEEP:<n>` / `WAKESPREAD:…` — the planner's diff, scoped to the anchor in monitor mode and to the full enabled set in fallback. Execute per the **CronCreate flow** below. Skip the `WAKESPREAD` advisory in monitor mode (meaningless over one routine).
   - `ANCHOR_PROMPT_BEGIN` … `ANCHOR_PROMPT_END` — the anchor's `CronCreate` prompt, rendered for you. Pass the enclosed text **verbatim** as the `prompt` for the `heartbeat-restart` `CREATE:` line: it is what makes the next daily fire short-circuit on `HEALTHY`. The planner's `promptHash` does **not** cover the prompt text (only id/skill/flags/shifted schedule/plugin root), so a hand-composed or drifted prompt is registered silently and stays live until the 5-day age cliff or a boot-id change — `load --reset` is the way to force a rendered prompt onto an already-registered anchor.

4. **Commit:**
   ```
   bun <pluginRoot>/scripts/routines.ts arm commit .claude-code-hermit <pluginRoot> <task-id|none> --created "<succeeded-csv>" --heartbeat <task-id|none>
   ```
   `<task-id>` is the routine Monitor's, or `none` after `MONITOR_SKIP`; the `--heartbeat` one is the heartbeat Monitor's. Append ` --reset` when `begin` got it. The verb waits for the monitor's first liveness tick internally (≤10s) and writes `state/routine-monitor.runtime.json` and the registry mirror. Its output:
   - `OK|monitor|<n> scheduled|anchor <created|kept>` — done. Log it.
   - `FALLBACK|liveness-absent` — the routine subprocess never ticked (seccomp/nested-userns). `TaskStop` the **routine** Monitor you registered from `MONITOR_CMD` (never the heartbeat one, whose leg is independent and already committed by the `HEARTBEAT:` line), and go to Step 3-F.
   - `HEARTBEAT:<result>` — the heartbeat leg, independent of the routine line above (absent under `--heartbeat none`). `OK|registered|interval=<s>` → log it. `DEAD|liveness-absent` → report that the heartbeat will not run this session.
5. **Step 3-F — fallback** (Monitor unavailable, registration failed, or `commit` returned `FALLBACK`): run
   ```
   bun <pluginRoot>/scripts/routines.ts arm begin .claude-code-hermit <pluginRoot> --fallback
   ```
   which re-plans over the full enabled set (scheduled routines + anchor) and prints the same block minus `MONITOR_CMD` and the `HB_` lines (the first pass already committed the heartbeat; re-planning it here would register a second monitor). Execute its `DELETE:`/`CREATE:` lines via the **CronCreate flow** below, then commit with `arm commit .claude-code-hermit <pluginRoot> fallback --created "<succeeded-csv>" --heartbeat none`, which records `{"mode":"croncreate-fallback", …}`.

   **CronCreate flow** (executes the `DELETE:`/`CREATE:` lines from any `arm begin` block — monitor-mode anchor, fallback, or `--reset`):
   Report `WARN:routines|...` as a scheduler warning, including when all registrations are kept. CronCreate fallback does not enforce `routine_max_lateness_minutes`.

   1. Parse the block's planner lines: `DELETE:<id>`, `CREATE:<id>|<schedule>`, `WARN:<id>|<reason>`, `KEEP:<n>`, optional trailing `WAKESPREAD:<distinct>|<max>|<loneliest>`.
      - No `DELETE:`/`CREATE:` lines (only `KEEP:<n>`, optional `WAKESPREAD:`): already current — log `Routines unchanged: <n> current, 0 registered.` (plus the wake-spread line if present). No `CronList`, no `CronCreate`, no `CronDelete` this run; go straight to the `arm commit` call.
      - Otherwise, if any `DELETE:` lines: call `CronList` once, `CronDelete` each entry whose prompt contains `[hermit-routine:<id>]` (skip silently if absent).
   2. For each `CREATE:<id>|<schedule>` line, call `CronCreate`: `cron: <schedule>` (as-is — already tz-shifted), `recurring: true`, `durable: false`, `prompt:` the rendered `ANCHOR_PROMPT_*` text for `heartbeat-restart`, or one built per **Shared execution semantics** below for any other id. **Per-routine error isolation:** if `CronCreate` throws for one routine, record the failure and continue — track which ids succeeded.
   3. Log: `Routines registered: <N> ok, <M> failed, <K> kept[, <W> tz-warned]`. List failures/warnings on their own lines. If `WAKESPREAD:<distinct>|<max>|<loneliest>` was present: `WARN: wake spread — <distinct> distinct 30-min wake windows (max <max>); consider clustering: <loneliest>` (advisory only).

**`load --reset`:** the unconditional escape hatch for suspected drift. Append ` --reset` to **both** the `arm begin` and `arm commit` calls (an unforced `commit` replan would carry stale `registered_at` forward, undoing the reset's clock). `begin --reset` never returns `HEALTHY`: it always emits a plan, deletes `state/routine-schedule.json` (a deliberate baseline reset — the ordinary re-arm's "preserve the cursor" rule doesn't apply here), and makes every enabled routine a `CREATE`. On top of the plan block, also `CronList` → `CronDelete` every live `[hermit-routine:*]` entry (anchor included) before creating.

#### Shared execution semantics

Used both by the fallback CronCreate prompt (built at `CREATE:` time) and by the `run <ids>` handler (below) — one definition, two callers.

One shared template for both `run_during_waiting` (rdw) values — `routines.ts precheck` takes `rdw` as an argument and consults the waiting-check and the binding pause flag internally. Default `run_during_waiting` is `false` when the field is absent.

**Model-override substitution.** Read the routine's optional `model` field. First, if `id === "heartbeat-restart"`, treat `model` as absent regardless of its value — its re-arm must run in the session, so it is never dispatched to a subagent. Then: if `model` is absent/null, invoke `/<skill>` directly. If set to a non-null `<model>`, dispatch instead: resolve `<abs-project-dir>` as the session's current absolute working directory (the project root) and `dispatch the skill via the Agent tool: subagent_type "general-purpose", model "<model>", prompt "The hermit project is at <abs-project-dir>; its state lives in <abs-project-dir>/.claude-code-hermit/. Invoke the skill /<skill> to completion, following its instructions exactly, and resolve any project-relative .claude-code-hermit/ reads/writes against <abs-project-dir> — pass the absolute <abs-project-dir>/.claude-code-hermit path to any hermit script the skill runs rather than relying on your cwd. Return only a one-line status."` **Language clause:** when `config.language` is set, append one more sentence to that prompt — `All operator-facing prose you produce (channel messages, push notifications, report text) must be written in <language>.` — substituting the configured language; append nothing when it is null. No script call: the dispatching session already holds the language in its Operator Preferences context. This anchors the subagent's own project-relative state paths without constraining where else it may work — a dispatched skill that legitimately changes directory for unrelated work (e.g. a custom routine touching a sibling repo) is unaffected, since `.claude-code-hermit/` always lives under `<abs-project-dir>` regardless of the subagent's cwd at invocation time. The Agent runs in isolated context and returns only a one-line status; the precheck call, the `finish` call, and any `heartbeat-restart`/`reflect_after` appends stay in the session turn at the session model.

Base execution, one routine, `<delivery>` = `cron-create` (fallback prompt) or `monitor` (`run` handler):
```
Run: bun <pluginRoot>/scripts/routines.ts precheck <id> <rdw> <delivery>
If the output is SKIP, stop. If PROCEED, then invoke /<skill> (or dispatch per the model-override rule above). After it completes, run:
bun <pluginRoot>/scripts/routines.ts finish <id> <delivery> --outcome-stdin <<'HERMIT_LINE'
<one line: the routine id and what the fire actually did or found>
HERMIT_LINE
```
The heredoc line is the fire's Progress Log entry — `finish` timestamps it and appends it under `## Progress Log` itself.
Replace `<pluginRoot>`, `<id>`, `<rdw>` (`true`/`false`; default `false`), and `<skill>` (passed verbatim to the slash invocation — `claude-code-hermit:brief --morning` becomes `/claude-code-hermit:brief --morning`).

**Optional `precheck`: the wake gate.** A routine may declare `precheck` — one of the builtins `"reflect"`, `"doctor"`, `"auto-close"`, `"later"`, or a project-relative path to an executable the operator owns. The routine monitor runs it at fire time, before waking the session: on `SKIP` the fire is consumed and stamped `skipped-precheck` at **zero token cost**, and nothing is emitted. On `WAKE`, any non-zero exit, a timeout (`precheck_timeout_s`, default 30s, max 300), or unparseable output, the routine fires exactly as it would with no gate, and a failure stamps `precheck-error` with the reason. Contract for an operator script: print `SKIP` or `WAKE` as its **first stdout line and nothing else that matters** — no output reaches the session, so a gate that has found something hands nothing over; the skill re-queries its own source, using the `ROUTINE_LAST_FIRED` env var (ISO timestamp of the last successful fire, empty on the first ever fire — treat empty as "everything is new"). Also in the environment: `HERMIT_DIR`, `ROUTINE_ID`, `PATH`, and, when set, `HOME`, `LANG`, `CLAUDE_CONFIG_DIR`, `HERMIT_PLUGIN_ROOT`. No other monitor variables are forwarded. Gates must be read-only and cheap; anything that mutates state belongs in the skill, which only runs when the gate says so. The hermit may write the script for the operator on request. In CronCreate fallback mode the gate still runs, but after the wake — same behavior, no token saving.

**Calling sibling scripts from gates.** `"$HERMIT_DIR/bin/hermit-run" sibling-run <plugin-name> <relative.ts> [args…]` finds the sibling by its manifest name using core's flat/versioned-cache discovery (newest cached sibling version), then runs its TypeScript script with inherited stdio in the caller's cwd. It returns the child's exit code; resolver errors are 2 for no match, 1 for multiple matches (paths on stderr), and 3 for an absolute path, any `..`, a non-`.ts` path, or a missing script. Arguments are passed verbatim. The forwarded `CLAUDE_CONFIG_DIR` and `HERMIT_PLUGIN_ROOT` keep `hermit-run` on the configured core installation.

**`finish` is unconditional and owns the ledger row** — call it whether or not the skill looked successful, and never decide the outcome yourself. It prints `fired`, or `failed|<reason>|<detail>` when the routine declared an `expect_artifact` contract that its run did not satisfy (`artifact-missing`, `artifact-unchanged`, `verification-error`). **On a `failed|…` line, notify the operator** per § Operator Notification, naming the routine and the expected path. Do not retry the skill: routines include channel sends, session closure and archival, none of them guaranteed idempotent.

**Special case — `heartbeat-restart`:** the anchor does not use this template at all. Its prompt is rendered by `arm begin` between `ANCHOR_PROMPT_BEGIN`/`ANCHOR_PROMPT_END` and used verbatim, because what it must say is the short-circuit: run `arm anchor`, and on `HEALTHY` reply with one line and stop. The `promptHash` does not cover prompt text, so a prompt composed here would be registered silently and stay live until the age cliff; use the rendered text.

The daily fire re-arms the monitor and, in fallback mode, the routine CronCreates before the 7-day auto-expiry; `arm anchor` stamps `fired` on a `HEALTHY` verdict so the ledger records the anchor as alive without a re-registration. The heartbeat leg is decided at fire time from `heartbeat.enabled`, never baked in at registration, so flipping it takes effect at the next 4am fire; `false` means off (bootstrap and the watchdog's re-arms honour it the same way, see `maybeMonitorRearm` in `hermit-watchdog.ts`). The watchdog also re-arms a monitor whose liveness file has gone stale, including at `session_state: idle`, where a healthy hermit rests between arcs. An operator with `heartbeat.enabled: false` who wants one for just the current session types `/claude-code-hermit:heartbeat start` themselves.

**`reflect_after: true`:** append after the trailing `finish` call (and after the `heartbeat-restart` append if both apply). Skip when `skill` is `claude-code-hermit:reflect` — chaining reflect after reflect is a config foot-gun.
```
Then, only if `routines.ts precheck` returned PROCEED (not SKIP), run <pluginRoot>/scripts/reflect-precheck.ts .claude-code-hermit <pluginRoot> --quick. If its first output line is exactly `EMPTY`, do not invoke reflect. Otherwise (a `RUN|<hash>` line) invoke /claude-code-hermit:reflect --quick --precheck-verdict '<that full line>'.
```

**Special case — `skill` is exactly `claude-code-hermit:reflect`:** reflect's body should not load on days with nothing to reflect on. Replace the invoke clause with:
```
If the precheck output carried a second line `REFLECT RUN|<phases-json>`, invoke /claude-code-hermit:reflect --precheck-verdict 'RUN|<phases-json>' — do NOT run reflect-precheck.ts yourself; it already ran, and running it again appends its observation rows a second time.
Otherwise run <pluginRoot>/scripts/reflect-precheck.ts .claude-code-hermit <pluginRoot>. If its first output line is exactly `EMPTY`, do not invoke reflect; fall through to the `finish` call. Otherwise (a `RUN|<phases-json>` line) invoke /claude-code-hermit:reflect --precheck-verdict '<that full line>'.
```
The `REFLECT` line is present whenever the routine declares `"precheck": "reflect"` (the shipped default): the gate then ran subprocess-side before the wake, and an EMPTY day never woke the session at all. Without it, the fallback clause runs the precheck in-session: an EMPTY day costs one wake but never loads the reflect skill body. Single-check invocations (`--check-id <id> --check <skill>`) have no cadence precheck; `--quick` gets its own via the `reflect_after` append above.

### run &lt;ids&gt;

The `ROUTINE_DUE` notification handler — invoked when the monitor emits `ROUTINE_DUE [hermit-routine:&lt;id&gt;] ...`. Parse the bracketed ids. For each, look up the routine in `config.routines` and execute per **Shared execution semantics** above with `<delivery>` = `monitor`. Ids no longer present in config are skipped silently.

