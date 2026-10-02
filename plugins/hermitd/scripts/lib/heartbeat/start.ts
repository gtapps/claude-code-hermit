// Deterministic heartbeat activation, registration, interval and stop commands.
// The skill invokes the native activation skill between start-check and start-commit.

import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../cli';
import { readConfigRaw } from '../config-read';
import { isGuest } from '../guest-marker';
import { pidAlive } from '../lockfile';
import { bootMismatch, waitForFirstTick } from '../monitor-health';
import { readBootId } from '../routines/registry';
import { resolveHermitNowMs } from '../time';
import { hasStartedRegistration, heartbeatCommand, heartbeatHealth, heartbeatInterval } from './monitor-cmd';

type Json = any;

function writeJson(file: string, value: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

const runtimePath = (hermitDir: string) =>
  path.join(hermitDir, 'state', 'heartbeat-monitor.runtime.json');
const livenessPath = (hermitDir: string) =>
  path.join(hermitDir, 'state', 'heartbeat-liveness.json');

/**
 * Side effects and plan lines for one heartbeat re-arm, without the leading
 * `REARM|<reason>` line. Shared by `start-check` and by `routines.ts arm begin`,
 * which prefixes each line with `HB_` — so the two callers can never drift into
 * planning different registrations.
 */
export function prepareHeartbeatArm(hermitDir: string, config: Json): string[] {
  const bootId = readBootId(hermitDir);
  writeJson(path.join(hermitDir, 'state', 'heartbeat-monitor.control.json'), config?.heartbeat?.enabled === false
    ? { mode: 'forced', boot_id: bootId }
    : { mode: 'auto' });
  const runtime = readJson(runtimePath(hermitDir));
  // Same reason as the routine leg: the commit waits for a liveness file to
  // appear, so the outgoing monitor's last tick has to go before the new one spawns
  // — otherwise a monitor blocked by seccomp reads as alive, and the doctor flags
  // stale data from the prior session during the startup window.
  if (runtime?.launch !== 'native' || bootMismatch(runtime.boot_id, bootId)) {
    try { fs.rmSync(livenessPath(hermitDir), { force: true }); } catch {}
  }

  const lines: string[] = [];
  if (!hasStartedRegistration(runtime)) lines.push('FIRST_START:1');
  lines.push(`INTERVAL:${heartbeatInterval(config)}`);
  lines.push('ACTIVATE:/hermitd:monitor-activate');
  return lines;
}

/**
 * Records a heartbeat Monitor registration: waits for the first liveness tick,
 * writes `state/heartbeat-monitor.runtime.json` and returns the result line for the caller to print. This module stays the
 * sole writer of that runtime file — `arm commit --heartbeat` calls in here rather
 * than writing it itself.
 */
export async function commitHeartbeatArm(
  hermitDir: string,
  config: Json,
  taskId: string,
): Promise<string> {
  const interval = heartbeatInterval(config);
  const nowMs = resolveHermitNowMs();
  const liveness = readJson(livenessPath(hermitDir));
  const live = (typeof liveness?.pid === 'number' && pidAlive(liveness.pid))
    || await waitForFirstTick(livenessPath(hermitDir));

  // The monitor's first tick lands before this commit, so started_at postdates it and
  // readers see it untrusted. That is what the predates-grace in monitorFreshness rides
  // out — adopting the tick instead cannot work, because no timestamp proves which
  // process wrote it, and the outgoing monitor is still alive when the arm is planned.
  // Written even on the DEAD path below: without a started_at the readers report
  // `unregistered`, which counts as fresh, and doctor would call a spawn-blocked
  // monitor "warming up" forever.
  writeJson(runtimePath(hermitDir), {
    description: 'heartbeat-monitor',
    launch: 'native',
    command: heartbeatCommand(hermitDir, config),
    interval,
    started_at: new Date(nowMs).toISOString(),
    boot_id: readBootId(hermitDir),
  });

  if (!live) return 'DEAD|liveness-absent';
  return `OK|registered|interval=${interval}`;
}

function cmdCheck(hermitDir: string, config: Json): void {
  const health = heartbeatHealth(hermitDir, config, resolveHermitNowMs());
  if (health.reason === 'restart-required') {
    process.stdout.write('RESTART_REQUIRED|command-drift\n');
    return;
  }
  // `disabled` is healthy to the daily anchor, which must leave a deliberately-off
  // heartbeat alone. Reaching `start` at all is an explicit act, so re-arm instead.
  if (health.healthy && health.reason !== 'disabled') {
    process.stdout.write(`FRESH|interval=${heartbeatInterval(config)}\n`);
    return;
  }
  process.stdout.write(`REARM|${health.reason}\n`);
  for (const line of prepareHeartbeatArm(hermitDir, config)) {
    process.stdout.write(`${line}\n`);
  }
}

async function cmdCommit(hermitDir: string, config: Json, taskId: string): Promise<void> {
  process.stdout.write(`${await commitHeartbeatArm(hermitDir, config, taskId)}\n`);
}

export async function run(verb: string, args: string[]): Promise<void> {
  const hermitDir = args[0] ? path.resolve(args[0]) : null;
  if (!hermitDir) {
    // Fail-open in the same direction the rest of the arming path does: claim
    // nothing is fresh, so the caller re-arms rather than trusting a stale monitor.
    process.stdout.write('REARM|usage\n');
    return;
  }
  const config = readConfigRaw(hermitDir) ?? {};
  const sessionIndex = args.indexOf('--session-id');
  if (verb === 'start-check' && isGuest(path.join(hermitDir, 'state'), sessionIndex < 0 ? null : args[sessionIndex + 1])) {
    process.stdout.write('GUEST|native-monitors-resident-only\n');
    return;
  }
  if (verb === 'interval') process.stdout.write(`${heartbeatInterval(config)}\n`);
  else if (verb === 'stop') {
    writeJson(path.join(hermitDir, 'state', 'heartbeat-monitor.control.json'), { mode: 'stopped' });
    writeJson(runtimePath(hermitDir), {});
    fs.rmSync(livenessPath(hermitDir), { force: true });
  }
  else if (verb === 'start-check') cmdCheck(hermitDir, config);
  else await cmdCommit(hermitDir, config, args[1] ?? '');
}
