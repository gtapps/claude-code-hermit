// Deterministic owner of routine/heartbeat arming decisions and durable mirrors.
// Tool ownership stays in the skill: this module plans Monitor, TaskStop and Cron*
// calls, but never attempts to perform them itself.

import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../cli';
import { readConfigRaw } from '../config-read';
import { heartbeatHealth, livenessReason, STARTUP_GRACE_SECS, type LegHealth } from '../heartbeat/monitor-cmd';
import { commitHeartbeatArm, prepareHeartbeatArm } from '../heartbeat/start';
import { bootMismatch, monitorFreshness, waitForFirstTick } from '../monitor-health';
import { isPaused } from '../pause';
import { resolveHermitNowMs } from '../time';
import { logRoutineEvent } from './event';
import { lastRoutineFire } from './history';
import {
  commitCron,
  computeWakeSpread,
  filterRoutinesByIds,
  planCron,
  readBootId,
  readMirror,
  type Mirror,
  type PlanResult,
} from './registry';

type Json = any;

const ANCHOR_ID = 'heartbeat-restart';
const MONITOR_INTERVAL_SECS = 60;
const ANCHOR_MAX_AGE_MS = 26 * 60 * 60 * 1000;

type Context = {
  hermitDir: string;
  pluginRoot: string;
  config: Json;
  routines: Json[];
  scheduled: Json[];
  mirrorPath: string;
  mirror: Mirror;
  bootId: string | null;
  nowMs: number;
};

function writeJson(file: string, value: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function context(hermitDirArg: string, pluginRootArg: string): Context {
  const hermitDir = path.resolve(hermitDirArg);
  const pluginRoot = path.resolve(pluginRootArg);
  const config = readConfigRaw(hermitDir);
  if (config === null) throw new Error('config.json unreadable');
  const routines = Array.isArray(config.routines) ? config.routines : [];
  const scheduled = routines.filter((r: Json) => r?.enabled === true && r.id !== ANCHOR_ID);
  const mirrorPath = path.join(hermitDir, 'state', 'cron-registry.json');
  return {
    hermitDir,
    pluginRoot,
    config,
    routines,
    scheduled,
    mirrorPath,
    mirror: readMirror(mirrorPath),
    bootId: readBootId(hermitDir),
    nowMs: resolveHermitNowMs(),
  };
}

function routineCommand(ctx: Context): string {
  return `bash ${path.join(ctx.pluginRoot, 'scripts', 'routine-monitor.sh')} ${MONITOR_INTERVAL_SECS} ${ctx.hermitDir}`;
}

function plan(ctx: Context, fallback: boolean, reset: boolean): { plan: PlanResult; routines: Json[] } {
  const routines = fallback ? ctx.routines : filterRoutinesByIds(ctx.routines, ANCHOR_ID);
  let machineTz: string | null = null;
  try { machineTz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  return {
    routines,
    plan: planCron(
      routines,
      ctx.mirror,
      ctx.bootId,
      ctx.pluginRoot,
      typeof ctx.config.timezone === 'string' ? ctx.config.timezone : null,
      machineTz,
      ctx.nowMs,
      reset,
    ),
  };
}

function planEmpty(result: PlanResult): boolean {
  return result.deletes.length === 0 && result.creates.length === 0;
}

function monitorHealth(ctx: Context): LegHealth {
  const runtime = readJson(path.join(ctx.hermitDir, 'state', 'routine-monitor.runtime.json'));
  if (runtime?.mode === 'croncreate-fallback') {
    const fullPlan = plan(ctx, true, false).plan;
    return planEmpty(fullPlan)
      ? { healthy: true, reason: 'fallback-current' }
      : { healthy: false, reason: 'fallback-drift' };
  }
  if (runtime?.mode !== 'monitor') return { healthy: false, reason: 'runtime-missing' };
  // Same check as the heartbeat leg (lib/heartbeat/monitor-cmd.ts) — see bootMismatch
  // for why. The anchor plan catches this too whenever the anchor is enabled; this
  // covers the config that disables it.
  if (bootMismatch(runtime.boot_id, ctx.bootId)) {
    return { healthy: false, reason: 'boot-mismatch' };
  }
  if (runtime.command !== routineCommand(ctx) && ctx.scheduled.length > 0) {
    return { healthy: false, reason: 'command-drift' };
  }
  if ((ctx.scheduled.length > 0) !== (typeof runtime.task_id === 'string' && runtime.task_id.length > 0)) {
    return { healthy: false, reason: 'task-drift' };
  }
  if (ctx.scheduled.length > 0) {
    const live = readJson(path.join(ctx.hermitDir, 'state', 'routine-monitor-liveness.json'));
    const interval = typeof runtime.interval === 'number' && runtime.interval > 0 ? runtime.interval : MONITOR_INTERVAL_SECS;
    const freshness = monitorFreshness(
      typeof runtime.started_at === 'string' ? runtime.started_at : null,
      typeof live?.last_peek_at === 'string' ? live.last_peek_at : null,
      Math.max(10 * interval, 600),
      STARTUP_GRACE_SECS,
      ctx.nowMs,
    );
    if (!freshness.fresh || freshness.reason === 'unregistered') {
      return { healthy: false, reason: livenessReason(freshness.reason) };
    }
  }
  const anchorPlan = plan(ctx, false, false).plan;
  if (!planEmpty(anchorPlan)) {
    return { healthy: false, reason: 'anchor-drift' };
  }

  const anchorEnabled = ctx.routines.some((r: Json) => r?.id === ANCHOR_ID && r.enabled === true);
  if (anchorEnabled) {
    const fired = lastRoutineFire(path.join(ctx.hermitDir, 'state', 'routine-metrics.jsonl'), ANCHOR_ID);
    const firedMs = fired === null ? NaN : Date.parse(fired);
    const registered = ctx.mirror.routines[ANCHOR_ID]?.registered_at;
    const fireFresh = Number.isFinite(firedMs) && ctx.nowMs - firedMs <= ANCHOR_MAX_AGE_MS;
    const registrationFresh = Number.isFinite(registered) && ctx.nowMs - registered <= ANCHOR_MAX_AGE_MS;
    if (!fireFresh && !registrationFresh) return { healthy: false, reason: 'anchor-old' };
  }
  return { healthy: true, reason: runtime.mode };
}

function anchorAge(ctx: Context): string {
  const fired = lastRoutineFire(path.join(ctx.hermitDir, 'state', 'routine-metrics.jsonl'), ANCHOR_ID);
  const ages = [
    fired === null ? NaN : ctx.nowMs - Date.parse(fired),
    Number.isFinite(ctx.mirror.routines[ANCHOR_ID]?.registered_at)
      ? ctx.nowMs - ctx.mirror.routines[ANCHOR_ID].registered_at
      : NaN,
  ].filter(Number.isFinite) as number[];
  return `${(ages.length ? Math.max(0, Math.min(...ages)) / 86400000 : 0).toFixed(1)}d`;
}

function summary(ctx: Context, heartbeat: LegHealth): string {
  const runtime = readJson(path.join(ctx.hermitDir, 'state', 'routine-monitor.runtime.json'));
  const mode = runtime?.mode === 'croncreate-fallback' ? 'fallback' : 'monitor';
  return `routines=${mode}:${ctx.scheduled.length}|anchor_age=${anchorAge(ctx)}|heartbeat=${heartbeat.reason === 'disabled' ? 'disabled' : 'ok'}`;
}

function stamp(ctx: Context, event: string): void {
  logRoutineEvent(ANCHOR_ID, event, ctx.hermitDir, 'cron-create');
}

function renderAnchorPrompt(ctx: Context): string {
  const cli = `bun ${path.join(ctx.pluginRoot, 'scripts', 'routines.ts')}`;
  return [
    `[hermit-routine:${ANCHOR_ID}]`,
    `Run: ${cli} arm anchor ${ctx.hermitDir} ${ctx.pluginRoot}`,
    'If the first line is SKIP, or is an ARM line whose reason starts with check-error, stop and report that line — the check could not read state, so there is nothing safe to re-arm.',
    'If it is HEALTHY, reply with one short healthy line and stop without TaskStop, Monitor, Cron, or file writes.',
    'If it is ARM and the legs include routines, invoke /claude-code-hermit:hermit-routines load: it arms the heartbeat leg too, so do not also invoke /claude-code-hermit:heartbeat start.',
    'If it is ARM and heartbeat is the only leg, invoke /claude-code-hermit:heartbeat start.',
    `Then run: ${cli} finish ${ANCHOR_ID} cron-create`,
  ].join('\n');
}

function emitPlan(ctx: Context, result: PlanResult): void {
  for (const id of result.deletes) process.stdout.write(`DELETE:${id}\n`);
  for (const item of result.creates) process.stdout.write(`CREATE:${item.id}|${item.schedule}\n`);
  for (const item of result.creates) if (item.warn) process.stdout.write(`WARN:${item.id}|${item.warn}\n`);
  process.stdout.write(`KEEP:${result.keepCount}\n`);
  try {
    const configured = ctx.config?.routine_wake_lint?.max_windows;
    const maxWindows = Number.isFinite(configured) && configured > 0 ? configured : 6;
    const spread = computeWakeSpread(result.enabledShifted, maxWindows);
    if (spread) process.stdout.write(`WAKESPREAD:${spread.distinct}|${maxWindows}|${spread.loneliest.join(',')}\n`);
  } catch {}
}

/** The verdict line both `anchor` and `check` report, computed without writing anything. */
function armVerdict(ctx: Context): { line: string; healthy: boolean; paused: boolean } {
  if (isPaused(ctx.hermitDir).paused) return { line: 'SKIP|paused', healthy: false, paused: true };
  const routines = monitorHealth(ctx);
  const heartbeat = heartbeatHealth(ctx.hermitDir, ctx.config, ctx.nowMs);
  if (routines.healthy && heartbeat.healthy) {
    return { line: `HEALTHY|${summary(ctx, heartbeat)}`, healthy: true, paused: false };
  }
  const legs = [!routines.healthy ? 'routines' : null, !heartbeat.healthy ? 'heartbeat' : null].filter(Boolean);
  const reasons = [!routines.healthy ? `routines:${routines.reason}` : null, !heartbeat.healthy ? `heartbeat:${heartbeat.reason}` : null].filter(Boolean);
  return { line: `ARM|${legs.join(',')}|${reasons.join(',')}`, healthy: false, paused: false };
}

function cmdAnchor(ctx: Context): void {
  const verdict = armVerdict(ctx);
  // The anchor's ledger rows are what keep `monitorHealth` from reading a live anchor
  // as `anchor-old`, so its fire IS the state change — `check` exists for callers that
  // want the same verdict without claiming a fire happened.
  if (verdict.paused) stamp(ctx, 'skipped-paused');
  else if (verdict.healthy) { stamp(ctx, 'started'); stamp(ctx, 'fired'); }
  else stamp(ctx, 'started');
  process.stdout.write(`${verdict.line}\n`);
}

/** Read-only twin of `anchor`: same verdict line, no ledger row, no file touched. */
function cmdCheck(ctx: Context): void {
  process.stdout.write(`${armVerdict(ctx).line}\n`);
}

function cmdBegin(ctx: Context, flags: string[]): void {
  const reset = flags.includes('--reset');
  const fallback = flags.includes('--fallback');
  // Read once for both the HEALTHY short-circuit and the HB_ plan below: heartbeatHealth
  // re-reads two state files plus `.boot-id`, and both sites see identical inputs. Null
  // on `--fallback`, the one path that never plans the heartbeat leg.
  const heartbeat = fallback ? null : heartbeatHealth(ctx.hermitDir, ctx.config, ctx.nowMs);
  if (heartbeat && !reset && heartbeat.healthy && monitorHealth(ctx).healthy) {
    process.stdout.write(`HEALTHY|${summary(ctx, heartbeat)}\n`);
    return;
  }

  const runtime = readJson(path.join(ctx.hermitDir, 'state', 'routine-monitor.runtime.json'));
  const firstTransition = runtime?.mode !== 'monitor';
  const legs = fallback ? 'routines' : 'routines,heartbeat';
  process.stdout.write(`ARM|${legs}|${fallback ? 'fallback' : reset ? 'reset' : 'reconcile'}\n`);
  // The heartbeat leg rides along so one `load` arms both monitors. `--fallback` is
  // the second pass of a load whose first pass already committed the heartbeat, and
  // a `disabled` verdict is healthy — neither emits a plan.
  if (heartbeat && !heartbeat.healthy) {
    for (const line of prepareHeartbeatArm(ctx.hermitDir, ctx.config)) {
      process.stdout.write(`HB_${line}\n`);
    }
  }
  if (typeof runtime?.task_id === 'string' && runtime.task_id && !bootMismatch(runtime.boot_id, ctx.bootId)) {
    process.stdout.write(`OLD_TASK:${runtime.task_id}\n`);
  }
  // Only ever a transition INTO monitor mode. The line tells the skill to CronDelete
  // every non-anchor `[hermit-routine:*]` entry, which is right when those crons are
  // being replaced by a monitor — and wrong in fallback mode, where they ARE the
  // routines and only the ids carrying a `CREATE:` line would come back.
  if (firstTransition && !fallback) process.stdout.write('FIRST_TRANSITION:1\n');
  if (reset || firstTransition) {
    try { fs.rmSync(path.join(ctx.hermitDir, 'state', 'routine-schedule.json'), { force: true }); } catch {}
  }
  // The outgoing monitor's last tick must not be mistaken for the incoming one's
  // first: `arm commit` waits for a liveness file to appear, and a leftover one
  // would let a subprocess that never spawned read as alive.
  try { fs.rmSync(path.join(ctx.hermitDir, 'state', 'routine-monitor-liveness.json'), { force: true }); } catch {}
  if (!fallback) {
    if (ctx.scheduled.length === 0) process.stdout.write('MONITOR_SKIP:zero-scheduled\n');
    else process.stdout.write(`MONITOR_CMD:${routineCommand(ctx)}\n`);
  }
  if (fallback && ctx.scheduled.length > 0) {
    process.stdout.write('WARN:routines|routine_max_lateness_minutes is not enforced in CronCreate fallback; Monitor scheduling is required\n');
  }
  const result = plan(ctx, fallback, reset).plan;
  emitPlan(ctx, result);
  process.stdout.write('ANCHOR_PROMPT_BEGIN\n');
  process.stdout.write(renderAnchorPrompt(ctx) + '\n');
  process.stdout.write('ANCHOR_PROMPT_END\n');
}

function commitMirror(ctx: Context, fallback: boolean, reset: boolean, created: Set<string>): void {
  const planned = plan(ctx, fallback, reset);
  const byId = new Map(planned.routines.map((r: Json) => [r.id, r]));
  const next = commitCron(ctx.mirror, planned.plan, created, byId, ctx.pluginRoot, ctx.bootId, ctx.nowMs);
  writeJson(ctx.mirrorPath, next);
}

/**
 * Starts recording the heartbeat Monitor the skill registered from this run's `HB_`
 * lines, or returns null when no heartbeat task was passed. Independent of the routine
 * leg's outcome: `lib/heartbeat/start.ts` owns the write, and a routine fallback says
 * nothing about whether the heartbeat subprocess ticked.
 */
function startHeartbeatLeg(ctx: Context, flags: string[]): Promise<string> | null {
  const index = flags.indexOf('--heartbeat');
  const taskId = index === -1 ? '' : (flags[index + 1] ?? '').trim();
  if (!taskId || taskId === 'none') return null;
  const pending = commitHeartbeatArm(ctx.hermitDir, ctx.config, taskId);
  // Both monitors are already spawned by the time `commit` runs, so this leg's
  // first-tick wait overlaps the routine leg's instead of following it — up to 10s off
  // every boot that arms both. The awaits below still surface any rejection; this
  // handler only stops it counting as unhandled during the overlap window.
  pending.catch(() => {});
  return pending;
}

async function cmdCommit(ctx: Context, taskId: string, flags: string[]): Promise<void> {
  const fallback = taskId === 'fallback';
  const reset = flags.includes('--reset');
  const createdIndex = flags.indexOf('--created');
  const created = new Set(
    (createdIndex === -1 ? '' : flags[createdIndex + 1] ?? '')
      .split(',').map(value => value.trim()).filter(Boolean),
  );
  const heartbeatLeg = startHeartbeatLeg(ctx, flags);
  commitMirror(ctx, fallback, reset, created);

  if (fallback) {
    writeJson(path.join(ctx.hermitDir, 'state', 'routine-monitor.runtime.json'), {
      mode: 'croncreate-fallback',
      started_at: new Date(ctx.nowMs).toISOString(),
      boot_id: ctx.bootId,
    });
    process.stdout.write(`OK|monitor|${ctx.scheduled.length} scheduled|anchor ${created.has(ANCHOR_ID) ? 'created' : 'kept'}\n`);
    if (heartbeatLeg) process.stdout.write(`HEARTBEAT:${await heartbeatLeg}\n`);
    return;
  }

  const noMonitor = taskId === 'none';
  const live = noMonitor || await waitForFirstTick(path.join(ctx.hermitDir, 'state', 'routine-monitor-liveness.json'));
  const runtime: Json = {
    description: 'routine-monitor',
    command: routineCommand(ctx),
    interval: MONITOR_INTERVAL_SECS,
    started_at: new Date(ctx.nowMs).toISOString(),
    mode: live ? 'monitor' : 'croncreate-fallback',
    boot_id: ctx.bootId,
  };
  if (!noMonitor && taskId) runtime.task_id = taskId;
  if (noMonitor) runtime.routines = 0;
  writeJson(path.join(ctx.hermitDir, 'state', 'routine-monitor.runtime.json'), runtime);
  process.stdout.write(
    live
      ? `OK|monitor|${ctx.scheduled.length} scheduled|anchor ${created.has(ANCHOR_ID) ? 'created' : 'kept'}\n`
      : 'FALLBACK|liveness-absent\n',
  );
  if (heartbeatLeg) process.stdout.write(`HEARTBEAT:${await heartbeatLeg}\n`);
}

export async function run(args: string[]): Promise<void> {
  const [subverb, hermitDir, pluginRoot, ...rest] = args;
  if (!subverb || !hermitDir || !pluginRoot || !['anchor', 'check', 'begin', 'commit'].includes(subverb)) {
    process.stdout.write('ARM|routines,heartbeat|check-error:usage\n');
    return;
  }
  try {
    const ctx = context(hermitDir, pluginRoot);
    if (subverb === 'anchor') cmdAnchor(ctx);
    else if (subverb === 'check') cmdCheck(ctx);
    else if (subverb === 'begin') cmdBegin(ctx, rest);
    else {
      const [taskId, ...flags] = rest;
      await cmdCommit(ctx, taskId || 'none', flags);
    }
  } catch (error: any) {
    const message = String(error?.message ?? error).replace(/[\r\n|]+/g, ' ').slice(0, 200);
    process.stdout.write(`ARM|routines,heartbeat|check-error:${message}\n`);
  }
}
