// Contract tests for scripts/routine-precheck.ts — consolidates a routine fire's
// pre-dispatch gate (waiting-check + pause-check) and the `started` stamp into one
// script call. Exercised as a subprocess (argv/stdout/exit-code/file writes), the same
// way tests/hermit-pause.test.ts exercises hermit-pause.ts (both resolve the hermit
// root via lib/cc-compat's hermitDir(), which fails open to a path resolved against
// the child process's cwd when no config.json is present — see setupWorkdir()).
//
// Usage: bun test tests/routine-precheck.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { setPause } from '../scripts/lib/pause';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const metricsPath = (dir: string) => hermit(dir, 'state', 'routine-metrics.jsonl');
const readMetricsRows = (dir: string) => {
  try {
    return fs.readFileSync(metricsPath(dir), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const writeRuntime = (dir: string, sessionState: string) =>
  fs.writeFileSync(hermit(dir, 'state', 'runtime.json'), JSON.stringify({ session_state: sessionState }));

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const run = (id: string, rdw: 'true' | 'false', dir: string) =>
  runScript('routine-precheck.ts', { args: [id, rdw], cwd: dir });

describe('routine-precheck', () => {
  test('idle, unpaused, rdw=false → PROCEED + one started row', withDir(async (dir) => {
    const r = await run('morning-brief', 'false', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('PROCEED');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'morning-brief', event: 'started', delivery: 'cron-create' });
    expect(typeof rows[0].ts).toBe('string');
  }));

  test('rdw=false, session_state=waiting → SKIP + skipped-waiting row, no started', withDir(async (dir) => {
    writeRuntime(dir, 'waiting');
    const r = await run('inbox-check', 'false', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('SKIP');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'inbox-check', event: 'skipped-waiting' });
  }));

  test('rdw=true, session_state=waiting → waiting is not consulted; falls through to PROCEED', withDir(async (dir) => {
    writeRuntime(dir, 'waiting');
    const r = await run('always-fire-routine', 'true', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('PROCEED');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'always-fire-routine', event: 'started' });
  }));

  test('paused (operator), rdw=false, idle → SKIP + skipped-paused row', withDir(async (dir) => {
    setPause(hermit(dir), { reason: 'operator', by: 'test' });
    const r = await run('weekly-review', 'false', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('SKIP');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'weekly-review', event: 'skipped-paused' });
  }));

  test('paused (operator), rdw=true → pause still applies → SKIP + skipped-paused row', withDir(async (dir) => {
    setPause(hermit(dir), { reason: 'operator', by: 'test' });
    const r = await run('always-fire-routine', 'true', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('SKIP');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('skipped-paused');
  }));

  test('malformed runtime.json → fail-open PROCEED, no crash', withDir(async (dir) => {
    fs.writeFileSync(hermit(dir, 'state', 'runtime.json'), '{not valid json');
    const r = await run('daily-brief', 'false', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('PROCEED');
    const rows = readMetricsRows(dir);
    expect(rows[0]).toMatchObject({ routine_id: 'daily-brief', event: 'started' });
  }));

  test('missing routine id → fail-open PROCEED, no metrics row written', withDir(async (dir) => {
    const r = await runScript('routine-precheck.ts', { args: [], cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('PROCEED');
    expect(readMetricsRows(dir)).toHaveLength(0);
  }));

  test('subdir with a config.json ancestor resolves to the project root', withDir(async (dir) => {
    // Mirrors the log-routine-event.sh "subdir resolves to ancestor" case: hermitDir()'s
    // walk-up branch requires config.json to exist (setupWorkdir() doesn't seed one, so
    // the root-cwd cases above rely on the fail-open branch instead — see file header).
    fs.writeFileSync(hermit(dir, 'config.json'), '{}');
    fs.mkdirSync(path.join(dir, 'app', 'sub'), { recursive: true });
    const r = await runScript('routine-precheck.ts', {
      args: ['nested-routine', 'false'],
      cwd: path.join(dir, 'app', 'sub'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('PROCEED');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'nested-routine', event: 'started' });
  }));

  test('row schema is byte-identical to log-routine-event.sh (ts, routine_id, event, delivery only)', withDir(async (dir) => {
    await run('schema-check', 'false', dir);
    const rows = readMetricsRows(dir);
    expect(Object.keys(rows[0]).sort()).toEqual(['delivery', 'event', 'routine_id', 'ts']);
  }));

  test('explicit delivery arg "monitor" serializes delivery: monitor', withDir(async (dir) => {
    const r = await runScript('routine-precheck.ts', { args: ['test-routine', 'false', 'monitor'], cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('PROCEED');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'test-routine', event: 'started', delivery: 'monitor' });
  }));

  test('no delivery arg defaults to delivery: cron-create (unchanged)', withDir(async (dir) => {
    const r = await run('legacy-routine', 'false', dir);
    expect(r.exitCode).toBe(0);
    const rows = readMetricsRows(dir);
    expect(rows[0]).toMatchObject({ event: 'started', delivery: 'cron-create' });
    expect(Object.keys(rows[0]).sort()).toEqual(['delivery', 'event', 'routine_id', 'ts']);
  }));
});
