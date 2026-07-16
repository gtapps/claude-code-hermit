---
name: hermit-routines
description: Schedules routines via one persistent Monitor subprocess (zero-token skips); CronCreate fallback where Monitor is unavailable. heartbeat-restart stays a CronCreate re-arm anchor.
---
# Routines

Register and manage scheduled routines. Where the Monitor tool is available, all enabled routines except `heartbeat-restart` run from ONE persistent Monitor subprocess that decides eligibility outside the session — a skipped fire costs zero model tokens. `heartbeat-restart` stays a CronCreate **re-arm anchor**: its daily fire re-invokes `load` (re-arming the monitor) and its skill re-arms the heartbeat monitor. Where Monitor is unavailable (Bedrock/Google Cloud Agent Platform/Foundry, `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), `load` falls back to per-routine CronCreates.

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

## Plan

### load

Called automatically by `hermit-start.ts` on always-on launches. Can also be called manually to apply config changes mid-session.

1. Resolve the plugin root path: derive it from this skill's **Base directory**, which the harness injects into the invocation context as `<plugin_root>/skills/hermit-routines`. Strip the trailing `/skills/hermit-routines` to get `pluginRoot`. This works in both installed and `--plugin-dir` modes. (`$CLAUDE_PLUGIN_ROOT` is NOT a Bash env var at runtime — evaluating it in Bash always returns empty. The braced `${CLAUDE_PLUGIN_ROOT}` form is text-substituted in skill markdown only in installed mode. Neither is reliable here — always use the Base-directory derivation.) The resolved `pluginRoot` must be baked into the Monitor `command` and into any CronCreate-delivered prompt at registration — it is not available inside either subprocess or cron-delivered prompts.

   **Validate `pluginRoot` before proceeding.** If `pluginRoot` is empty, or any of `<pluginRoot>/scripts/log-routine-event.sh`, `<pluginRoot>/scripts/routine-precheck.ts`, `<pluginRoot>/scripts/routine-monitor.sh`, `<pluginRoot>/scripts/cron-registry.ts` does not exist (`test -f`), abort `load` immediately — do not register/delete anything — and log one line: `Routine load aborted: plugin scripts not found at "<pluginRoot>". No routines registered or reset.`
2. Read `config.routines`, filter `enabled: true`, split into the anchor (`id === "heartbeat-restart"`) and everyone else ("scheduled routines").

   **Empty scheduled-routine set does not early-exit** — an operator disabling every routine mid-session must not leave a live monitor/anchor/crons behind. Reconcile: TaskStop any `routine-monitor` task (ignore not-found), delete `state/routine-monitor-liveness.json` and `state/routine-monitor.runtime.json`, run the anchor-only planner leg (Step 3's `--ids heartbeat-restart`, which with nothing else enabled emits `DELETE:` for every tracked id including the anchor if it too is disabled) and execute its deletes, then log "No enabled routines in config." and stop.
3. **Monitor path (tried first, unless a prior `load` in this deployment already fell back — see Step 3-F note):**
   - **Idempotent sweep:** read `state/routine-monitor.runtime.json`; if it has a `task_id`, `TaskStop` it (ignore not-found). `TaskList` → `TaskStop` any remaining task with description `routine-monitor` (orphan sweep). Delete `state/routine-monitor-liveness.json`. **Do NOT delete `state/routine-schedule.json` on an ordinary re-arm** — the anchor invokes `load` daily, and wiping the cursor would silently lose any pending mark, including one deferred by an in-progress session. Delete it only on a **first transition** into monitor mode (runtime file was absent, or `mode` was `croncreate-fallback`) or on `load --reset` (below).
   - **Register:** call the Monitor tool — `description: "routine-monitor"` (reserved slot), `command: "bash <pluginRoot>/scripts/routine-monitor.sh 60 $PWD/.claude-code-hermit"`, `timeout_ms: 86400000` (schema-required boilerplate on a persistent monitor — it does not expire on this deadline; the daily anchor re-arm exists to recover from monitor *death* and session restarts, not a timeout), `persistent: true`.
   - **Liveness-verify:** wait 5s, then check `state/routine-monitor-liveness.json` exists. Absent → the subprocess likely failed to spawn (seccomp/nested-userns) — `TaskStop` the task just registered and go to Step 3-F.
   - On success: write `state/routine-monitor.runtime.json`: `{"description":"routine-monitor","task_id":"<id>","command":"<cmd>","interval":60,"started_at":"<ISO now>","mode":"monitor"}`. If there are zero scheduled routines but the anchor is enabled, skip registering the Monitor and record `"routines":0` in the runtime file instead — go straight to anchor registration below.
   - **Anchor registration:** run the diff planner scoped to the anchor alone: `bun <pluginRoot>/scripts/cron-registry.ts plan .claude-code-hermit <pluginRoot> --ids heartbeat-restart`. Execute its `DELETE:`/`CREATE:` lines exactly as Step 3-F's fallback flow does below — the `DELETE:` lines are what sweep any formerly-tracked non-anchor CronCreate; no separate sweep step needed. Commit with `... cron-registry.ts commit .claude-code-hermit <pluginRoot> "<succeeded-csv>" --ids heartbeat-restart` (`--ids` must match on both calls — `commit` replans internally). Skip the WAKESPREAD advisory in monitor mode (meaningless over one routine).
   - **First-transition sweep only** (runtime file was absent, or `mode` just changed to `monitor`): also call `CronList` and `CronDelete` every entry whose prompt contains `[hermit-routine:` except `[hermit-routine:heartbeat-restart]` — covers live crons from an in-process upgrade that the mirror no longer tracks (duplicate-fire hazard).
   - Log: `Routines: monitor registered (<N> scheduled), anchor re-armed.` or the `routines:0`/first-transition variants.
4. **Step 3-F — fallback** (Monitor unavailable, registration failed, or liveness-verify failed): run the **CronCreate flow** below against the full enabled set (scheduled routines + anchor), then write `state/routine-monitor.runtime.json`: `{"mode":"croncreate-fallback","started_at":"<ISO now>"}`.

   **CronCreate flow** (also used verbatim by `load --reset`'s fallback branch):
   1. Run the diff planner: `bun <pluginRoot>/scripts/cron-registry.ts plan .claude-code-hermit <pluginRoot>` (append ` --force` for `load --reset`). Parse stdout: `DELETE:<id>`, `CREATE:<id>|<schedule>`, `WARN:<id>|<reason>`, `KEEP:<n>`, optional trailing `WAKESPREAD:<distinct>|<max>|<loneliest>`.
      - First line `SKIP|<reason>` (planner fell open, e.g. corrupt `config.json`): abort, log `Routine load aborted: cron planner failed — <reason>. No routines registered.`
      - No `DELETE:`/`CREATE:` lines (only `KEEP:<n>`, optional `WAKESPREAD:`): already current — log `Routines unchanged: <n> current, 0 registered.` (plus the wake-spread line if present); stop. No `CronList`, no `CronCreate`, no `CronDelete` this run.
      - Otherwise, if any `DELETE:` lines: call `CronList` once, `CronDelete` each entry whose prompt contains `[hermit-routine:<id>]` (skip silently if absent).
   2. For each `CREATE:<id>|<schedule>` line, build the prompt (Shared execution semantics, below) using `<schedule>` as-is (already tz-shifted). Call `CronCreate`: `cron: <schedule>`, `recurring: true`, `durable: false`, `prompt: <resolved>`. **Per-routine error isolation:** if `CronCreate` throws for one routine, record the failure and continue — track which ids succeeded.
   3. Commit: `bun <pluginRoot>/scripts/cron-registry.ts commit .claude-code-hermit <pluginRoot> "<succeeded-csv>"` (append ` --force` for `load --reset`).
   4. Log: `Routines registered: <N> ok, <M> failed, <K> kept[, <W> tz-warned]`. List failures/warnings on their own lines. If `WAKESPREAD:<distinct>|<max>|<loneliest>` was present: `WARN: wake spread — <distinct> distinct 30-min wake windows (max <max>); consider clustering: <loneliest>` (advisory only).

**`load --reset`:** the unconditional escape hatch for suspected drift. **Monitor mode:** unconditionally `TaskStop`/orphan-sweep any `routine-monitor` task, `CronList` → `CronDelete` every live `[hermit-routine:*]` entry (anchor included), delete `state/routine-schedule.json` (deliberate baseline reset — the ordinary re-arm's "preserve the cursor" rule doesn't apply here), then re-register per Step 3 with `--force` appended to **both** the anchor `plan` and `commit` calls. **Fallback mode:** Step 3's planner call gets `--force` (every enabled routine becomes `CREATE`, no `DELETE`s) — `--reset` also sweeps unconditionally first: `CronList`, then `CronDelete` every `[hermit-routine:` entry. Step 3's `commit` call gets `--force` too. Both modes need `--force` on `commit` as well as `plan`: an unforced `commit` replan would carry stale `registered_at` forward, undoing the reset's clock.

#### Shared execution semantics

Used both by the fallback CronCreate prompt (built at `CREATE:` time) and by the `run <ids>` handler (below) — one definition, two callers.

One shared template for both `run_during_waiting` (rdw) values — `routine-precheck.ts` takes `rdw` as an argument and consults the waiting-check and the binding pause flag internally. Default `run_during_waiting` is `false` when the field is absent.

**Model-override substitution.** Read the routine's optional `model` field. First, if `id === "heartbeat-restart"`, treat `model` as absent regardless of its value — its re-arm append must run in the session, so it is never dispatched to a subagent. Then: if `model` is absent/null, invoke `/<skill>` directly. If set to a non-null `<model>`, dispatch instead: resolve `<abs-project-dir>` as the session's current absolute working directory (the project root) and `dispatch the skill via the Agent tool: subagent_type "general-purpose", model "<model>", prompt "The hermit project is at <abs-project-dir>; its state lives in <abs-project-dir>/.claude-code-hermit/. Invoke the skill /<skill> to completion, following its instructions exactly, and resolve any project-relative .claude-code-hermit/ reads/writes against <abs-project-dir>. Return only a one-line status."` This anchors the subagent's own project-relative state paths without constraining where else it may work — a dispatched skill that legitimately changes directory for unrelated work (e.g. a custom routine touching a sibling repo) is unaffected, since `.claude-code-hermit/` always lives under `<abs-project-dir>` regardless of the subagent's cwd at invocation time. The Agent runs in isolated context and returns only a one-line status; the precheck call, the `fired` log line, and any `heartbeat-restart`/`reflect_after` appends stay in the session turn at the session model.

Base execution, one routine, `<delivery>` = `cron-create` (fallback prompt) or `monitor` (`run` handler):
```
Run: bun <pluginRoot>/scripts/routine-precheck.ts <id> <rdw> <delivery>
If the output is SKIP, stop. If PROCEED, then invoke /<skill> (or dispatch per the model-override rule above). After it completes, run:
<pluginRoot>/scripts/log-routine-event.sh <id> fired <delivery>
```
Replace `<pluginRoot>`, `<id>`, `<rdw>` (`true`/`false`; default `false`), and `<skill>` (passed verbatim to the slash invocation — `claude-code-hermit:brief --morning` becomes `/claude-code-hermit:brief --morning`).

**Special case — `heartbeat-restart`:** append ` Then invoke /claude-code-hermit:hermit-routines load to re-arm the routine monitor (and the anchor CronCreate).` after the trailing `fired` log line. Daily re-arm via this routine is what keeps the monitor and, in fallback mode, the routine CronCreates from reaching the 7-day auto-expiry.

**`reflect_after: true`:** append after the trailing `fired` log line (and after the `heartbeat-restart` append if both apply). Skip when `skill` is `claude-code-hermit:reflect` — chaining reflect after reflect is a config foot-gun.
```
Then, only if routine-precheck returned PROCEED (not SKIP), run <pluginRoot>/scripts/reflect-precheck.ts .claude-code-hermit <pluginRoot> --quick. If its first output line is exactly `EMPTY`, do not invoke reflect. Otherwise (a `RUN|<hash>` line) invoke /claude-code-hermit:reflect --quick --precheck-verdict '<that full line>'.
```

**Special case — `skill` is exactly `claude-code-hermit:reflect`:** reflect's body should not load on days with nothing to reflect on. Replace the invoke clause with:
```
run <pluginRoot>/scripts/reflect-precheck.ts .claude-code-hermit <pluginRoot>. If its first output line is exactly `EMPTY`, do not invoke reflect; fall through to the `fired` log line. Otherwise (a `RUN|<phases-json>` line) invoke /claude-code-hermit:reflect --precheck-verdict '<that full line>'.
```
Runs the precheck once; an EMPTY day never loads the reflect skill body. Does not apply to `--scheduled-checks` invocations (no cadence precheck) — `--quick` gets its own via the `reflect_after` append above.

### run &lt;ids&gt;

The `ROUTINE_DUE` notification handler — invoked when the monitor emits `ROUTINE_DUE [hermit-routine:&lt;id&gt;] ...`. Parse the bracketed ids. For each, look up the routine in `config.routines` and execute per **Shared execution semantics** above with `<delivery>` = `monitor`. Ids no longer present in config are skipped silently.

### list

Show configured routines from `config.json` (not the live view — that's `status`).

1. Read `config.routines`. If empty: "No routines configured."
2. Display table:
```
Routines (config.json):
  #  ID                 Schedule      Skill                                    RDW    RA     Model   Status
  1. heartbeat-restart  0 4 * * *     claude-code-hermit:heartbeat start       true   false  -       enabled
  2. weekly-review      0 23 * * 0    claude-code-hermit:weekly-review         false  false  -       disabled
```
`RA` is `true` when `reflect_after: true`. `Model` is the `model` value if set, otherwise `-`.

### status

1. Read `state/routine-monitor.runtime.json`.
   - **Monitor mode:** report `mode`, `started_at`, `interval`, and `state/routine-monitor-liveness.json`'s `last_peek_at`. Call `CronList` filtered to `[hermit-routine:` — in steady state only `[hermit-routine:heartbeat-restart]` should appear; more means "legacy CronCreates still active — run `load` to clean up."
   - **Fallback mode:** `CronList` filtered to `[hermit-routine:`, displayed as:
     ```
     Active routine CronCreates:
       ID                 CRON-ID    SCHEDULE
       heartbeat-restart  4e007cf4   0 4 * * *
     ```
     (Extract id from the `[hermit-routine:<id>]` prefix.) If none: "No active routine CronCreates. Run `load` to register."
   - **Absent runtime file:** "Not yet loaded. Run `/claude-code-hermit:hermit-routines load`."

### stop

**Monitor mode:**
- `stop` or `stop --all` (no id, or `--all`): `TaskStop` the monitor task, clear `state/routine-monitor.runtime.json`, `CronDelete` the anchor. Log: "Stopped routine monitor and anchor."
- `stop <id>` (id ≠ `heartbeat-restart`): routines share one subprocess — do not stop it. Reply: "Routines share one monitor subprocess — to stop just `<id>`, set `enabled: false` on that entry in config.json and run `load`."
- `stop heartbeat-restart`: `CronDelete` the anchor alone (the monitor, if any, keeps running).

**Fallback mode (unchanged):**
- `stop <id>`: `CronList`, find the `[hermit-routine:<id>]` entry, `CronDelete` it (or "not active").
- `stop` (no id): `CronList` filtered to `[hermit-routine:*]` — 0 active: report; 1 active: stop without asking; 2+: list and ask (or `--all`).
- `stop --all`: `CronDelete` every `[hermit-routine:*]` entry.

## Notes

- **Monitor mode gates on `session_state`, coarser than CronCreate's turn-level idle gate.** A routine wake can interject mid-conversation (same trade the heartbeat monitor accepts) — CronCreate never fires mid-task.
- **Routine ids** must match `^[A-Za-z0-9._-]{1,64}$` (enforced by `validate-config.ts`) — ids travel through bracket markers, `--ids` CSVs, and JSONL rows.
- **Changes take effect immediately.** `hermit-settings routines` invokes `load` after writing config; hand-edited `config.json` needs a manual `load`.
- **Interactive mode does not auto-register routines.** `hermit-start.ts` calls `load` only on always-on launches.
- **`model` (optional)** runs a routine's skill in an isolated-context subagent at the named model (`opus`/`sonnet`/`haiku`) — returns only a one-line status, so skip it on routines whose value is the rich chat output. Ignored on `heartbeat-restart` (re-arm must run in the session). Validated by `scripts/validate-config.ts`.
- **Converting a costly broad-skill routine into a scoped one?** See [Routine Authoring](../../docs/routine-authoring.md).

### CronCreate fallback details

- **Timezone.** CronCreate flow shifts each cron from `config.timezone` to machine-local (CronCreate only knows machine time) at minute granularity — half-hour/45-minute zones (Kolkata, Adelaide, Kathmandu) work. Null `config.timezone` passes through unchanged. Monitor mode needs no shift — `routine-due.ts` evaluates directly in `config.timezone`.
- **DST.** Recomputed every `load`; `heartbeat-restart`'s daily reload self-corrects within 24h. On the transition day, one fallback-mode fire may land at the wrong hour. Inexpressible-after-shift schedules pass through unchanged with a `WARN:` line.
- **`durable: false`.** CronCreates die with the session; re-registered on every always-on launch.
- **7-day auto-expiry depends on `heartbeat-restart`.** CC's recurring-task expiry is a hard 7-day cliff, reset only by re-creating. The diff planner re-registers any routine whose age crosses a conservative threshold even with unchanged config; `heartbeat-restart`'s daily `load` is what crosses it. Disable it in fallback mode and routine CronCreates expire after 7 days.
- **`state/cron-registry.json`** is a derived mirror, never hand-edited — `--reset`, a missing/corrupt mirror, or a `.boot-id` mismatch all fall back to treating every enabled routine as needing registration.
