// The doctor's `backup` check: the only path from a model-free backup back into a
// session, so its thresholds are the thing worth pinning. Two missed scheduled
// windows warn; one does not (a reboot or a busy tick looks like one miss, and a
// check that cries at that gets ignored).

import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { checkBackup, resolvePaths } from '../scripts/doctor-check';
import { PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-doctor-backup-');
afterAll(cleanup);

const HOUR = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function fixture(backup: any, status?: any, schedule?: any) {
  const dir = freshDir();
  const hermit = path.join(dir, '.hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({ timezone: 'UTC', backup }));
  if (status) fs.writeFileSync(path.join(hermit, 'state', 'backup-status.json'), JSON.stringify(status));
  if (schedule) fs.writeFileSync(path.join(hermit, 'state', 'backup-schedule.json'), JSON.stringify(schedule));
  return checkBackup(resolvePaths(hermit, PLUGIN_ROOT));
}

// Hourly, so "two missed windows" is reachable without faking the clock.
const HOURLY = { enabled: true, mode: 'workspace', schedule: '0 * * * *', remote: '/srv/x.git', push: true, include: [] };

describe('doctor: backup', () => {
  test('not configured is ok, and says where to configure it', () => {
    const r = fixture({ enabled: false, mode: 'workspace', schedule: '0 3 * * *', remote: null, push: true, include: [] });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('not configured');
    expect(r.detail).toContain('backup setup');
  });

  test('configured but not yet run is ok while the first window is still ahead', () => {
    const r = fixture(HOURLY, { version: 1, configured_at: iso(5 * 60_000) });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('first run pending');
  });

  test('a recent success is ok and reports its age', () => {
    const r = fixture(HOURLY, { version: 1, last_success_at: iso(10 * 60_000), push: 'ok' });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('last success');
  });

  // The boundary is "older than the second-most-recent scheduled minute", so these
  // two anchor on the real hour marks rather than a fixed offset — a fixed offset
  // lands on either side of the boundary depending on the wall clock.
  const prevHourBoundary = (n: number) => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    return d.getTime() - n * HOUR;
  };

  test('one missed window does not warn', () => {
    // Succeeded just after the second-most-recent fire: exactly one window since.
    const r = fixture(HOURLY, { version: 1, last_success_at: new Date(prevHourBoundary(1) + 60_000).toISOString(), push: 'ok' });
    expect(r.status).toBe('ok');
  });

  test('two missed windows warn and name the last result', () => {
    const r = fixture(HOURLY, {
      version: 1, last_success_at: new Date(prevHourBoundary(1) - 60_000).toISOString(),
      last_result: 'dirty-index',
      last_error: 'index has staged changes; commit or unstage them first', push: 'ok',
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('two scheduled runs missed');
    expect(r.detail).toContain('dirty-index');
  });

  test('configured long ago with no run at all warns', () => {
    const r = fixture(HOURLY, { version: 1, configured_at: iso(5 * HOUR) });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('never succeeded');
  });

  test('a diverged remote warns and points at the manual reconcile', () => {
    const r = fixture(HOURLY, {
      version: 1, last_success_at: iso(10 * 60_000), last_result: 'committed',
      push: 'diverged', consecutive_push_failures: 1,
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('docs/backup.md');
  });

  test('three consecutive push failures warn with the last error', () => {
    const r = fixture(HOURLY, {
      version: 1, last_success_at: iso(10 * 60_000), push: 'failed',
      consecutive_push_failures: 3, last_push_error: 'could not read Username',
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('push failing');
    expect(r.detail).toContain('could not read Username');
  });

  test('push failures below the floor stay ok', () => {
    const r = fixture(HOURLY, {
      version: 1, last_success_at: iso(10 * 60_000), push: 'failed', consecutive_push_failures: 2,
    });
    expect(r.status).toBe('ok');
  });

  test('never fails — a stale backup is not a liveness problem', () => {
    const r = fixture(HOURLY, { version: 1, last_success_at: iso(500 * HOUR), last_result: 'error', last_error: 'x' });
    expect(r.status).toBe('warn');
    expect(r.status).not.toBe('fail');
  });
});
