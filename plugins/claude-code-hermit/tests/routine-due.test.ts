// Contract tests for scripts/routine-due.ts — the monitor-mode deterministic
// scheduler. Exercised as a subprocess (argv/stdout/exit-code/file writes), same
// convention as tests/routine-precheck.test.ts.
//
// Usage: bun test tests/routine-due.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { setPause } from '../scripts/lib/pause';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const metricsPath = (dir: string) => hermit(dir, 'state', 'routine-metrics.jsonl');
const schedulePath = (dir: string) => hermit(dir, 'state', 'routine-schedule.json');
const livenessPath = (dir: string) => hermit(dir, 'state', 'routine-monitor-liveness.json');

const readMetricsRows = (dir: string) => {
  try {
    return fs.readFileSync(metricsPath(dir), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const readSchedule = (dir: string): any => {
  try { return JSON.parse(fs.readFileSync(schedulePath(dir), 'utf-8')); } catch { return null; }
};
const writeSchedule = (dir: string, value: any) =>
  fs.writeFileSync(schedulePath(dir), JSON.stringify(value));
const writeRuntime = (dir: string, sessionState: string) =>
  fs.writeFileSync(hermit(dir, 'state', 'runtime.json'), JSON.stringify({ session_state: sessionState }));
const turnMarkerPath = (dir: string) => hermit(dir, 'state', 'operator-turn-open.json');
const writeTurnMarker = (dir: string, at: string) =>
  fs.writeFileSync(turnMarkerPath(dir), JSON.stringify({ at }));
const writeTurnMarkerRaw = (dir: string, raw: string) =>
  fs.writeFileSync(turnMarkerPath(dir), raw);
const writeConfig = (dir: string, routines: any[], timezone: string | null = 'UTC') =>
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ timezone, routines }));

const ROUTINE = (overrides: any = {}) => ({
  id: 'test-routine', skill: 'claude-code-hermit:reflect', schedule: '0 9 * * *',
  enabled: true, run_during_waiting: false, ...overrides,
});
const ANCHOR = { id: 'heartbeat-restart', skill: 'claude-code-hermit:heartbeat start', schedule: '0 4 * * *', enabled: true, run_during_waiting: true };

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const run = (dir: string, now: string) =>
  runScript('routine-due.ts', { args: [hermit(dir)], env: { HERMIT_NOW: now } });

describe('routine-due', () => {
  test('no schedule file + due-now mark → init-to-now, NO emission, entry created', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE(), ANCHOR]);
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    const sched = readSchedule(dir);
    expect(sched['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
    expect(sched['heartbeat-restart']).toBeUndefined(); // anchor never tracked
  }));

  test('mark in window → emits bracketed id, consumes latest match', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('two routines due → one line, both bracketed ids, config order', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'first', schedule: '0 9 * * *' }), ROUTINE({ id: 'second', schedule: '0 9 * * *' })]);
    writeSchedule(dir, {
      first: { last_consumed_mark: '2026-07-15T08:00:00.000Z' },
      second: { last_consumed_mark: '2026-07-15T08:00:00.000Z' },
    });
    const r = await run(dir, '2026-07-15T09:05:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:first] [hermit-routine:second]');
  }));

  test('multiple pending marks collapse into one fire, cursor = latest', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ schedule: '0 * * * *' })]); // hourly
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T05:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:00:00Z'); // 3 missed hourly marks (6,7,8) + due now (9)
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('mark older than 24h with no recent match → expired, no fire, cursor advances to nowMinute', withDir(async (dir) => {
    // A daily schedule always has exactly one occurrence inside any 24h lookback
    // window (the window width equals the period), so this case needs a schedule
    // whose period exceeds 24h — weekly Monday 9am, evaluated on a Wednesday, so
    // the (windowFloor(Tue), now(Wed)] window spans neither this nor last Monday.
    // On no-match the cursor converges to nowMinute (not windowFloor) so the next
    // poll re-scans only new minutes instead of re-walking the dead 24h window.
    writeConfig(dir, [ROUTINE({ schedule: '0 9 * * 1' })]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-01T00:00:00.000Z' } }); // long stale
    const r = await run(dir, '2026-07-15T03:00:00Z'); // Wednesday
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T03:00:00.000Z');
  }));

  test('not-yet-due routine advances cursor to nowMinute on a no-match poll', withDir(async (dir) => {
    // Daily 9am, cursor at yesterday's fire, polled at 08:00 — no match in (cursor, now].
    // Old behavior left the cursor put (re-scanning a growing window every poll); now it
    // converges to nowMinute so the next poll's window is just the elapsed minute.
    writeConfig(dir, [ROUTINE({ schedule: '0 9 * * *' })]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-14T09:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T08:00:00Z');
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T08:00:00.000Z');
  }));

  test('invalid config.timezone → fail-soft: no fire, but cursor init and stale-entry prune still run', withDir(async (dir) => {
    // A bad tz makes the formatter null → the minute scan finds no match, but the missing
    // cursor must still initialize and a stale non-eligible entry must still be pruned.
    writeConfig(dir, [ROUTINE({ id: 'live-one' })], 'Not/AZone');
    writeSchedule(dir, { 'gone-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } }); // no longer in config
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    const sched = readSchedule(dir);
    expect(sched['live-one']).toBeDefined();               // missing cursor initialized despite bad tz
    expect(sched['live-one'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
    expect(sched['gone-routine']).toBeUndefined();          // stale entry pruned
  }));

  test('incident repro: in_progress + no operator-turn marker → emits and consumes (extratus starvation)', withDir(async (dir) => {
    // session_state alone no longer defers — it means "nobody closed the session",
    // not "a conversation is happening". Without a marker, a due routine (including
    // daily-auto-close) must fire even while in_progress persists indefinitely.
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeRuntime(dir, 'in_progress');
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('in_progress + fresh operator-turn marker → defer, no consume', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeRuntime(dir, 'in_progress');
    writeTurnMarker(dir, '2026-07-15T09:15:00.000Z'); // 15 min old at run time, well under the 60-min TTL
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T08:00:00.000Z'); // untouched
  }));

  test('in_progress + stale marker (> 60-min TTL) → emits (orphaned-marker backstop)', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeRuntime(dir, 'in_progress');
    writeTurnMarker(dir, '2026-07-15T08:00:00.000Z'); // 90 min old at run time
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('in_progress + future-dated marker (clock skew) → emits, not treated as live', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeRuntime(dir, 'in_progress');
    writeTurnMarker(dir, '2026-07-15T10:30:00.000Z'); // an hour ahead of run time
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('in_progress + malformed marker file → fail-open to emit', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeRuntime(dir, 'in_progress');
    writeTurnMarkerRaw(dir, '{oops');
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('in_progress lull catch-up: deferred while marker present, emits once marker clears', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeRuntime(dir, 'in_progress');
    writeTurnMarker(dir, '2026-07-15T09:15:00.000Z');
    const r1 = await run(dir, '2026-07-15T09:30:00Z');
    expect(r1.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T08:00:00.000Z');

    fs.rmSync(turnMarkerPath(dir)); // Stop-pipeline cleared it — turn ended
    const r2 = await run(dir, '2026-07-15T09:40:00Z');
    expect(r2.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('paused → no emission, mark consumed, skipped-paused row (delivery=monitor)', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    setPause(hermit(dir), { reason: 'operator', by: 'test' });
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'test-routine', event: 'skipped-paused', delivery: 'monitor' });
  }));

  test('persist failure in skip branch → NO skipped-* row, cursor unchanged; retry writes exactly one', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    setPause(hermit(dir), { reason: 'operator', by: 'test' });

    // Force the schedule persist to fail via the test seam — the deferred skip stamp must
    // not be written and the cursor must not advance (persist-before-stamp ordering).
    const rFail = await runScript('routine-due.ts', {
      args: [hermit(dir)],
      env: { HERMIT_NOW: '2026-07-15T09:00:00Z', HERMIT_DUE_FORCE_PERSIST_FAIL: '1' },
    });
    expect(rFail.exitCode).toBe(0);
    expect(rFail.stdout.trim()).toBe('');
    expect(readMetricsRows(dir)).toHaveLength(0); // no phantom skipped-* row
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T08:00:00.000Z'); // cursor unchanged
    expect(fs.existsSync(livenessPath(dir))).toBe(true); // liveness still written (seam is schedule-scoped)

    // Retry without the seam — now exactly one skip row, and the cursor advances.
    const rOk = await run(dir, '2026-07-15T09:00:00Z');
    expect(rOk.stdout.trim()).toBe('');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'test-routine', event: 'skipped-paused', delivery: 'monitor' });
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('waiting × run_during_waiting matrix', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'rdw-false', run_during_waiting: false }), ROUTINE({ id: 'rdw-true', run_during_waiting: true })]);
    writeSchedule(dir, {
      'rdw-false': { last_consumed_mark: '2026-07-15T08:00:00.000Z' },
      'rdw-true': { last_consumed_mark: '2026-07-15T08:00:00.000Z' },
    });
    writeRuntime(dir, 'waiting');
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:rdw-true]');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'rdw-false', event: 'skipped-waiting', delivery: 'monitor' });
  }));

  test('heartbeat-restart is never emitted, never touched in schedule file', withDir(async (dir) => {
    writeConfig(dir, [ANCHOR]);
    const r = await run(dir, '2026-07-15T04:00:00Z'); // matches anchor's own schedule
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)).toBeNull(); // nothing written — anchor filtered before any state touch
  }));

  test('liveness file written on: normal run, no-op run, and corrupt-config run', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    await run(dir, '2026-07-15T09:00:00Z');
    expect(fs.existsSync(livenessPath(dir))).toBe(true);
    const firstStamp = JSON.parse(fs.readFileSync(livenessPath(dir), 'utf-8')).last_peek_at;

    await run(dir, '2026-07-15T09:00:30Z'); // no-op (same minute, already consumed)
    expect(fs.existsSync(livenessPath(dir))).toBe(true);

    fs.writeFileSync(hermit(dir, 'config.json'), '{not valid json');
    const r3 = await run(dir, '2026-07-15T09:01:00Z');
    expect(r3.exitCode).toBe(0);
    expect(r3.stdout.trim()).toBe('');
    expect(fs.existsSync(livenessPath(dir))).toBe(true);
    expect(typeof firstStamp).toBe('string');
  }));

  test('invalid schedule string on one routine → other routines still evaluated', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'bad', schedule: 'not a cron' }), ROUTINE({ id: 'good', schedule: '0 9 * * *' })]);
    writeSchedule(dir, { good: { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:good]');
    expect(r.stderr).toContain('bad');
  }));

  test('future last_consumed_mark (clock skew) → reset to now, no fire', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-20T00:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('schedule-write failure (directory collision) → exit 0, NO emission, stderr note, liveness still attempted', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    fs.mkdirSync(schedulePath(dir)); // pre-create as a directory: rename(file, dir) fails EISDIR for any uid
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toContain('routine-due');
    expect(fs.existsSync(livenessPath(dir))).toBe(true);
  }));

  test('invalid routine id (grammar) → skipped with stderr note; other routines unaffected', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'bad id with spaces' }), ROUTINE({ id: 'good-id', schedule: '0 9 * * *' })]);
    writeSchedule(dir, { 'good-id': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:good-id]');
    expect(r.stderr).toContain('invalid id');
  }));

  test('missing hermit-dir arg → exit 0, no crash, no output', withDir(async (dir) => {
    const r = await runScript('routine-due.ts', { args: [] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));
});
