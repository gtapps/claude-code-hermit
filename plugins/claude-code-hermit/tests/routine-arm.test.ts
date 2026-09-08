import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptHash } from '../scripts/lib/routines/registry';
import { runScript } from './helpers/run';

const pluginRoot = path.resolve(import.meta.dir, '..');
const tmpdirs: string[] = [];
const now = Date.now();
const iso = (ms = now) => new Date(ms).toISOString();

afterAll(() => {
  for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { scheduled?: boolean; heartbeat?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routine-arm-')));
  tmpdirs.push(root);
  const hermit = path.join(root, '.claude-code-hermit');
  const state = path.join(hermit, 'state');
  fs.mkdirSync(state, { recursive: true });
  const anchor = {
    id: 'heartbeat-restart', schedule: '0 4 * * *',
    skill: 'claude-code-hermit:hermit-routines load', enabled: true,
  };
  const routines = [anchor];
  if (options.scheduled !== false) {
    routines.push({ id: 'reflect', schedule: '0 9 * * *', skill: 'claude-code-hermit:reflect', enabled: true } as typeof anchor);
  }
  const config = {
    timezone: null,
    routines,
    heartbeat: { enabled: options.heartbeat !== false, every: '30m' },
  };
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(state, '.boot-id'), 'boot-a\n');
  fs.writeFileSync(path.join(state, 'cron-registry.json'), JSON.stringify({
    boot_id: 'boot-a',
    routines: {
      'heartbeat-restart': {
        prompt_hash: promptHash(anchor, anchor.schedule, pluginRoot),
        registered_at: now,
      },
    },
  }));
  const routineCommand = `bash ${path.join(pluginRoot, 'scripts', 'routine-monitor.sh')} 60 ${hermit}`;
  const heartbeatCommand = `bash ${path.join(pluginRoot, 'scripts', 'heartbeat-monitor.sh')} 1800 ${hermit}`;
  if (options.scheduled !== false) {
    fs.writeFileSync(path.join(state, 'routine-monitor.runtime.json'), JSON.stringify({
      description: 'routine-monitor', task_id: 'task-old', command: routineCommand,
      interval: 60, started_at: iso(now - 60_000), mode: 'monitor', boot_id: 'boot-a',
    }));
    fs.writeFileSync(path.join(state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  } else {
    fs.writeFileSync(path.join(state, 'routine-monitor.runtime.json'), JSON.stringify({
      description: 'routine-monitor', command: routineCommand, interval: 60,
      started_at: iso(now - 60_000), mode: 'monitor', boot_id: 'boot-a', routines: 0,
    }));
  }
  if (options.heartbeat !== false) {
    fs.writeFileSync(path.join(state, 'heartbeat-monitor.runtime.json'), JSON.stringify({
      command: heartbeatCommand, interval: 1800, started_at: iso(now - 60_000), boot_id: 'boot-a',
    }));
    fs.writeFileSync(path.join(state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  }
  return { root, hermit, state };
}

async function arm(hermit: string, args: string[], env: Record<string, string> = {}) {
  const [subverb, ...flags] = args;
  return runScript('routines.ts', { args: ['arm', subverb, hermit, pluginRoot, ...flags], env });
}

test('anchor HEALTHY stamps started and fired', async () => {
  const f = fixture();
  const result = await arm(f.hermit, ['anchor']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/^HEALTHY\|routines=monitor:1\|anchor_age=0\.0d\|heartbeat=ok$/m);
  const events = fs.readFileSync(path.join(f.state, 'routine-metrics.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line).event);
  expect(events).toEqual(['started', 'fired']);
});

test('anchor arms only the stale leg and stamps started without fired', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  runtime.started_at = iso(now - 1_000_000);
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso(now - 700_000) }));
  const result = await arm(f.hermit, ['anchor']);
  expect(result.stdout).toContain('ARM|routines|routines:liveness-stale');
  const events = fs.readFileSync(path.join(f.state, 'routine-metrics.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line).event);
  expect(events).toEqual(['started']);
});

// The routine monitor dies with its session too, and its last 60s tick is far
// fresher than the 10-minute staleness threshold. Without the boot marker a
// restart inside that window reads as a live monitor and nothing re-arms.
test('anchor re-arms a routine monitor registered by a previous boot', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  runtime.boot_id = 'boot-old';
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  const result = await arm(f.hermit, ['anchor']);
  expect(result.stdout).toContain('routines:boot-mismatch');
});

test('anchor pause short-circuits and stamps skipped-paused', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'operator-pause.json'), JSON.stringify({
    paused: true, paused_until: null, reason: 'operator', by: 'test', ts: iso(),
  }));
  const result = await arm(f.hermit, ['anchor']);
  expect(result.stdout).toBe('SKIP|paused\n');
  expect(fs.readFileSync(path.join(f.state, 'routine-metrics.jsonl'), 'utf8')).toContain('skipped-paused');
});

test('begin reset always plans, removes cursor, and renders the anchor prompt', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'routine-schedule.json'), '{}');
  const result = await arm(f.hermit, ['begin', '--reset']);
  expect(result.stdout).toContain('ARM|routines,heartbeat|reset');
  expect(result.stdout).toContain('OLD_TASK:task-old');
  expect(result.stdout).toContain('MONITOR_CMD:bash ');
  expect(result.stdout).toContain('ANCHOR_PROMPT_BEGIN\n[hermit-routine:heartbeat-restart]');
  expect(result.stdout).toContain('arm anchor');
  expect(result.stdout).toContain('finish heartbeat-restart cron-create');
  expect(fs.existsSync(path.join(f.state, 'routine-schedule.json'))).toBe(false);
});

test('begin reports OLD_TASK only for the current boot', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  runtime.boot_id = 'old-boot';
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  const result = await arm(f.hermit, ['begin', '--reset']);
  expect(result.stdout).not.toContain('OLD_TASK:');
});

// A record written before the field existed belongs to whatever process is reading
// it: an in-process upgrade re-arms while the old monitor is still polling, so
// skipping the stop leaves two monitors firing the same routines.
test('begin stops a task from a runtime record without boot_id', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  delete runtime.boot_id;
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  const result = await arm(f.hermit, ['begin', '--reset']);
  expect(result.stdout).toContain('OLD_TASK:task-old');
});

test('commit none writes monitor runtime and commits the anchor mirror', async () => {
  const f = fixture({ scheduled: false, heartbeat: false });
  fs.writeFileSync(path.join(f.state, 'cron-registry.json'), JSON.stringify({ boot_id: null, routines: {} }));
  const result = await arm(f.hermit, ['commit', 'none', '--created', 'heartbeat-restart']);
  expect(result.stdout).toBe('OK|monitor|0 scheduled|anchor created\n');
  const runtime = JSON.parse(fs.readFileSync(path.join(f.state, 'routine-monitor.runtime.json'), 'utf8'));
  expect(runtime).toMatchObject({ mode: 'monitor', routines: 0, boot_id: 'boot-a' });
  const mirror = JSON.parse(fs.readFileSync(path.join(f.state, 'cron-registry.json'), 'utf8'));
  expect(Object.keys(mirror.routines)).toEqual(['heartbeat-restart']);
});

test('daily HEALTHY verdicts cannot carry registration past the 5-day planner cliff', async () => {
  const f = fixture();
  let sawArm = false;
  for (let day = 1; day <= 6; day++) {
    const dayNow = now + day * 86400000;
    fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso(dayNow) }));
    fs.writeFileSync(path.join(f.state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso(dayNow) }));
    fs.writeFileSync(path.join(f.state, 'routine-metrics.jsonl'), JSON.stringify({
      ts: iso(dayNow - 86400000), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create',
    }) + '\n');
    const result = await arm(f.hermit, ['anchor'], { HERMIT_NOW: iso(dayNow) });
    if (result.stdout.startsWith('ARM|')) {
      sawArm = true;
      expect(day).toBeLessThanOrEqual(6);
      break;
    }
    expect(result.stdout).toStartWith('HEALTHY|');
  }
  expect(sawArm).toBe(true);
});

// --- The heartbeat leg riding along on `load` (one boot arms both monitors) ---

/** Drift the registered interval so heartbeatHealth reports `interval-drift`. */
function staleHeartbeat(f: { state: string }) {
  const p = path.join(f.state, 'heartbeat-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(p, 'utf8'));
  runtime.interval = 600;
  fs.writeFileSync(p, JSON.stringify(runtime));
}

const hbLines = (stdout: string) => stdout.split('\n').filter(line => line.startsWith('HB_'));

test('begin plans the heartbeat leg with the same lines start-check would print', async () => {
  const f = fixture();
  staleHeartbeat(f);
  const g = fixture();
  staleHeartbeat(g);

  const begun = await arm(f.hermit, ['begin']);
  const checked = await runScript('heartbeat.ts', { args: ['start-check', g.hermit] });

  // Same plan, modulo each fixture's own tmp dir.
  const expected = checked.stdout.split('\n')
    .filter(line => line && !line.startsWith('REARM|'))
    .map(line => `HB_${line.split(g.hermit).join(f.hermit)}`);
  expect(expected).toEqual([
    'HB_INTERVAL:1800',
    `HB_CMD:bash ${path.join(pluginRoot, 'scripts', 'heartbeat-monitor.sh')} 1800 ${f.hermit}`,
  ]);
  expect(hbLines(begun.stdout)).toEqual(expected);
});

test('begin carries the old heartbeat task id and the first-start marker', async () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.state, 'heartbeat-monitor.runtime.json'),
    JSON.stringify({ task_id: 'hb-old', interval: 600 }),
  );
  const result = await arm(f.hermit, ['begin']);
  expect(hbLines(result.stdout)).toContain('HB_OLD_TASK:hb-old');
  expect(hbLines(result.stdout)).toContain('HB_FIRST_START:1');
});

test('a disabled heartbeat is never planned by begin', async () => {
  const f = fixture({ heartbeat: false });
  const configPath = path.join(f.hermit, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.heartbeat = { enabled: false, every: '30m' };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const result = await arm(f.hermit, ['begin', '--reset']);
  expect(hbLines(result.stdout)).toEqual([]);
});

// The fallback pass is the second half of a load whose first pass already
// committed the heartbeat; re-planning it there would register a second monitor.
test('the fallback pass never plans the heartbeat leg', async () => {
  const f = fixture();
  staleHeartbeat(f);
  const result = await arm(f.hermit, ['begin', '--fallback']);
  expect(result.stdout).toContain('ARM|routines|fallback');
  expect(result.stdout).toContain('WARN:routines|routine_max_lateness_minutes is not enforced in CronCreate fallback');
  expect(hbLines(result.stdout)).toEqual([]);
});

test('commit --heartbeat records the heartbeat monitor after the routine leg', async () => {
  const f = fixture();
  staleHeartbeat(f);
  await arm(f.hermit, ['begin']);
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  fs.writeFileSync(path.join(f.state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso(Date.now() + 1000) }));

  const result = await arm(f.hermit, ['commit', 'task-new', '--heartbeat', 'hb-new']);
  const lines = result.stdout.trim().split('\n');
  expect(lines[0]).toStartWith('OK|monitor|');
  expect(lines[1]).toBe('HEARTBEAT:OK|registered|interval=1800');
  const runtime = JSON.parse(fs.readFileSync(path.join(f.state, 'heartbeat-monitor.runtime.json'), 'utf8'));
  expect(runtime).toMatchObject({ task_id: 'hb-new', interval: 1800 });
});

test('a symlinked plugin root writes the same heartbeat command as start-commit', async () => {
  const f = fixture();
  const pluginLink = path.join(f.root, 'plugin-link');
  fs.symlinkSync(pluginRoot, pluginLink);
  staleHeartbeat(f);
  await runScript('routines.ts', { args: ['arm', 'begin', f.hermit, pluginLink] });
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  fs.writeFileSync(path.join(f.state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso(Date.now() + 1000) }));

  await runScript('routines.ts', { args: ['arm', 'commit', f.hermit, pluginLink, 'task-new', '--heartbeat', 'hb-new'] });
  const checked = await runScript('heartbeat.ts', { args: ['start-check', f.hermit] });
  expect(checked.stdout).toStartWith('FRESH|interval=1800');
});

// The two legs are independent: a routine subprocess that never ticked says
// nothing about whether the heartbeat one did.
test('a routine fallback still commits the heartbeat leg', async () => {
  const f = fixture();
  staleHeartbeat(f);
  await arm(f.hermit, ['begin']);
  fs.rmSync(path.join(f.state, 'routine-monitor-liveness.json'), { force: true });
  fs.writeFileSync(path.join(f.state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso(Date.now() + 1000) }));

  const result = await arm(f.hermit, ['commit', 'task-new', '--heartbeat', 'hb-new']);
  expect(result.stdout).toContain('FALLBACK|liveness-absent');
  expect(result.stdout).toContain('HEARTBEAT:OK|registered|interval=1800');
  // The absent routine liveness file costs waitForFirstTick its full ~10s poll.
}, 30_000);

test('commit without --heartbeat leaves the heartbeat runtime untouched', async () => {
  const f = fixture();
  const before = fs.readFileSync(path.join(f.state, 'heartbeat-monitor.runtime.json'), 'utf8');
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  const result = await arm(f.hermit, ['commit', 'task-new']);
  expect(result.stdout).not.toContain('HEARTBEAT:');
  expect(fs.readFileSync(path.join(f.state, 'heartbeat-monitor.runtime.json'), 'utf8')).toBe(before);
});

// The commit's own clock, never a liveness tick. The outgoing monitor is still alive
// while the arm is planned — `begin` only prints OLD_TASK, the skill stops it afterwards
// — so a tick sitting in the file at commit time may be the outgoing monitor's, and no
// timestamp can tell the two apart. The routine leg needs no attribution anyway: its
// 60s poll fits inside the 120s startup grace, so a first tick that predates started_at
// is superseded before the grace expires.
test('commit stamps started_at from its own clock, not the liveness tick', async () => {
  const f = fixture();
  await arm(f.hermit, ['begin', '--reset']);

  const tick = iso(now - 60_000);
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: tick }));
  const before = Date.now();
  await arm(f.hermit, ['commit', 'task-new', '--reset']);

  const runtime = JSON.parse(fs.readFileSync(path.join(f.state, 'routine-monitor.runtime.json'), 'utf8'));
  expect(runtime.started_at).not.toBe(tick);
  expect(Date.parse(runtime.started_at)).toBeGreaterThanOrEqual(before);
  expect(runtime.mode).toBe('monitor');
});

// `begin` leaves no provenance key behind for `commit` to read.
test('begin writes no armed_at fence', async () => {
  const f = fixture();
  await arm(f.hermit, ['begin', '--reset']);
  const runtime = JSON.parse(fs.readFileSync(path.join(f.state, 'routine-monitor.runtime.json'), 'utf8'));
  expect(runtime.armed_at).toBeUndefined();
});

// --- `arm check`: the anchor's verdict without the anchor's ledger row ---

test('check reports the healthy verdict and writes nothing', async () => {
  const f = fixture();
  const result = await arm(f.hermit, ['check']);
  expect(result.stdout).toMatch(/^HEALTHY\|routines=monitor:1\|anchor_age=0\.0d\|heartbeat=ok$/m);
  expect(fs.existsSync(path.join(f.state, 'routine-metrics.jsonl'))).toBe(false);
});

test('check reports a stale leg without stamping a fire', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  runtime.started_at = iso(now - 1_000_000);
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso(now - 700_000) }));
  const result = await arm(f.hermit, ['check']);
  expect(result.stdout).toContain('ARM|routines|routines:liveness-stale');
  expect(fs.existsSync(path.join(f.state, 'routine-metrics.jsonl'))).toBe(false);
});

test('check reports pause without consuming the fire', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'operator-pause.json'), JSON.stringify({
    paused: true, paused_until: null, reason: 'operator', by: 'test', ts: iso(),
  }));
  const result = await arm(f.hermit, ['check']);
  expect(result.stdout).toBe('SKIP|paused\n');
  expect(fs.existsSync(path.join(f.state, 'routine-metrics.jsonl'))).toBe(false);
});
