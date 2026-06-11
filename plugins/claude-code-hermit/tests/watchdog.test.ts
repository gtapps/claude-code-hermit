// bun test port of tests/test-watchdog.sh — black-box tests of
// scripts/hermit-watchdog.ts, the single-shot watchdog decision flow.
// The watchdog stays a spawned subprocess (it is a standalone script);
// fake tmux/pgrep live as executable stubs in a temp bin dir prepended to PATH
// in the spawn env, driving each branch without live sessions.
//
// Usage: bun test tests/watchdog.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, SCRIPTS_DIR } from './helpers/run';
import { inActiveHours } from '../scripts/hermit-watchdog';

// The one line to flip when hermit-watchdog is ported to TypeScript.
// (Absolute bun path via process.execPath: Bun.spawn resolves the executable
// against the child env PATH, which the no-systemctl cases restrict to the
// fake bin dir.)
const WATCHDOG_CMD = [process.execPath, path.join(SCRIPTS_DIR, 'hermit-watchdog.ts')];

// ---------- fixture scaffolding ----------

interface Hermit {
  dir: string;
  fakeBin: string;
  cleanup(): void;
}

const state = (h: Hermit, ...p: string[]) => path.join(h.dir, '.claude-code-hermit', 'state', ...p);
const eventsFile = (h: Hermit) => state(h, 'watchdog-events.jsonl');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

/** Standard hermit project fixture: in_progress always-on tmux session. */
function setupHermit(): Hermit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-watchdog-'));
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'bin'), { recursive: true });

  fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'state', 'runtime.json'), JSON.stringify({
    version: 1,
    session_state: 'in_progress',
    runtime_mode: 'tmux',
    tmux_session: 'hermit-test',
    shutdown_requested_at: null,
    shutdown_completed_at: null,
    last_error: null,
    updated_at: '2026-01-01T00:00:00+0000',
  }, null, 2) + '\n');

  // Stub hermit-start: writes a marker so we can detect invocation
  const start = path.join(dir, '.claude-code-hermit', 'bin', 'hermit-start');
  fs.writeFileSync(start, `#!/usr/bin/env bash\necho "hermit-start called" > "${dir}/hermit-start-called"\n`);
  fs.chmodSync(start, 0o755);

  // Stub bin dir on PATH for fake tmux + pgrep
  const fakeBin = path.join(dir, 'fake-bin');
  fs.mkdirSync(fakeBin);

  return {
    dir, fakeBin,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function writeConfig(h: Hermit): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: true, stale_factor: 2, escalate_after: 3, operator_grace: '15m' },
    heartbeat: {
      enabled: true, every: '2h',
      active_hours: { start: '00:00', end: '23:59' },
      stale_threshold: '2h',
    },
  }, null, 2) + '\n');
}

function patchRuntime(h: Hermit, patch: Record<string, unknown>): void {
  const p = state(h, 'runtime.json');
  fs.writeFileSync(p, JSON.stringify({ ...readJson(p), ...patch }) + '\n');
}

/** Fake tmux: sessionAlive 0 = alive, 1 = dead. send-keys/kill-session log to tmux-calls.log. */
function writeFakeTmux(h: Hermit, sessionAlive: 0 | 1, paneContent = 'tmux pane content'): void {
  const log = path.join(h.dir, 'tmux-calls.log');
  const stub = path.join(h.fakeBin, 'tmux');
  fs.writeFileSync(stub, `#!/usr/bin/env bash
case "$1" in
  has-session) exit ${sessionAlive} ;;
  capture-pane) echo "${paneContent}" ;;
  send-keys) echo "send-keys $@" >> "${log}" ;;
  kill-session) echo "kill-session $@" >> "${log}" ;;
esac
`);
  fs.chmodSync(stub, 0o755);
}

/** Fake pgrep: found 0 = found, 1 = not found. */
function writeFakePgrep(h: Hermit, found: 0 | 1): void {
  const stub = path.join(h.fakeBin, 'pgrep');
  fs.writeFileSync(stub, `#!/usr/bin/env bash\nexit ${found}\n`);
  fs.chmodSync(stub, 0o755);
}

/** Backdate a file's mtime by `seconds` (creating it empty if absent). */
function touchAgo(p: string, seconds: number): void {
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  const t = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(p, t, t);
}

const isoAgo = (hours: number) =>
  new Date(Date.now() - hours * 3600_000).toISOString();
const isoAgoSeconds = (hours: number) =>
  new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Spawn the watchdog. restrictPath limits PATH to the fake bin dir (no systemctl). */
async function watchdog(h: Hermit, sub: string, opts: { restrictPath?: boolean } = {}) {
  const proc = Bun.spawn({
    cmd: [...WATCHDOG_CMD, sub],
    cwd: h.dir,
    env: {
      ...process.env,
      PATH: opts.restrictPath ? h.fakeBin : `${h.fakeBin}:${process.env.PATH}`,
    },
    stdin: Buffer.from(''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Run a test body against a throwaway hermit fixture, always cleaning up. */
function withHermit(fn: (h: Hermit) => Promise<void> | void) {
  return async () => {
    const h = setupHermit();
    try { await fn(h); } finally { h.cleanup(); }
  };
}

// -------------------------------------------------------
// 1. Config gate: watchdog.enabled false → no-op
// -------------------------------------------------------

test('watchdog disabled → exit 0, no events', withHermit(async (h) => {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
    '{"watchdog": {"enabled": false}}\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 2. Shutdown gate: session_state idle → no-op
// -------------------------------------------------------

test('idle session → exit 0, no events', withHermit(async (h) => {
  writeConfig(h);
  patchRuntime(h, { session_state: 'idle' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 3. Shutdown gate: shutdown_completed_at set → no-op
// -------------------------------------------------------

test('shutdown_completed_at set → exit 0, no events', withHermit(async (h) => {
  writeConfig(h);
  patchRuntime(h, { shutdown_completed_at: '2026-06-10T04:00:00Z' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 4. Interactive mode → skip
// -------------------------------------------------------

test('interactive mode → exit 0, no events', withHermit(async (h) => {
  writeConfig(h);
  patchRuntime(h, { runtime_mode: 'interactive' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 5. Dead session → restart
// -------------------------------------------------------

describe('dead session', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    // tmux has-session returns 1 (dead)
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('dead session → restart event written', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('restart');
  });

  test('dead session → restart reason dead-process', () => {
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('dead-process');
  });

  test('dead session → runtime.json last_error set', () => {
    const d = readJson(state(h, 'runtime.json'));
    expect(d.last_error).toBe('unclean_shutdown');
    expect(d.watchdog_restart_reason).toBe('dead-process');
  });
});

// -------------------------------------------------------
// 6. Alive + operator recent → back off (no events)
// -------------------------------------------------------

describe('alive + operator recent', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    // .heartbeat mtime 6h ago (stale — threshold is 2h*2=4h)
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    // operator action 5 minutes ago (within 15m grace)
    fs.writeFileSync(state(h, 'last-operator-action.json'),
      JSON.stringify({ at: isoAgo(5 / 60) }) + '\n');
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('stale + operator recent → no events', () => {
    expect(exitCode).toBe(0);
    expect(fs.existsSync(eventsFile(h))).toBe(false);
  });

  test('stale + operator recent → consecutive reset to 0', () => {
    expect(readJson(state(h, 'watchdog-state.json')).consecutive_stale).toBe(0);
  });
});

// -------------------------------------------------------
// 7. Alive + stale + operator silent → nudge on cycle 1
// -------------------------------------------------------

describe('alive + stale + operator silent', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    // No last-operator-action.json (operator silent)
    writeFakeTmux(h, 0, 'some pane content');
    // pgrep returns 1 = monitor not running (wedge signal)
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('stale + operator silent → nudge event written', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
  });

  test('nudge cycle 1 → consecutive_stale = 1', () => {
    expect(readJson(state(h, 'watchdog-state.json')).consecutive_stale).toBe(1);
  });

  test('nudge cycle 1 → send-keys called', () => {
    expect(fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')).toContain('send-keys');
  });
});

// -------------------------------------------------------
// 8. Escalation after escalate_after cycles (pane frozen + monitor dead)
// -------------------------------------------------------

describe('escalation', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    // Fake tmux pane content — the stub's echo adds a trailing newline, so the
    // stored hash must include it for the pane to read as frozen.
    const paneContent = 'frozen pane';
    const frozenHash = crypto.createHash('sha256').update(`${paneContent}\n`).digest('hex');
    fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
      consecutive_stale: 2, last_pane_hash: frozenHash, last_nudge_at: '2026-01-01T00:00:00Z',
    }) + '\n');
    // Fake tmux: session alive, pane returns same content → same hash
    writeFakeTmux(h, 0, paneContent);
    // pgrep returns 1 = monitor not running
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('escalation at cycle 3 (pane frozen + monitor dead) → restart', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('restart');
  });

  test('escalation reason is pane-frozen', () => {
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('pane-frozen');
  });
});

// -------------------------------------------------------
// 9. Alive + pane changed → nudge (not restart), even at escalate_after cycles
// -------------------------------------------------------

test('pane changed at cycle 3 → nudge (not restart)', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  // State shows 2 prior stale cycles with old hash
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 2, last_pane_hash: 'old-hash-abc', last_nudge_at: '2026-01-01T00:00:00Z',
  }) + '\n');
  // Fake tmux returns DIFFERENT pane content → different hash
  writeFakeTmux(h, 0, 'new pane content different from old');
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).toContain('nudge');
  expect(events).not.toContain('restart');
}));

// -------------------------------------------------------
// 10. Re-arm fallback: heartbeat-restart not fired in > 26h
// -------------------------------------------------------

test('heartbeat-restart missed > 26h → re-arm-fallback event', withHermit(async (h) => {
  writeConfig(h);
  // Recent .heartbeat (30 minutes ago) so wedge detection is skipped
  touchAgo(state(h, '.heartbeat'), 1800);
  // routine-metrics.jsonl: heartbeat-restart fired 28h ago
  fs.writeFileSync(state(h, 'routine-metrics.jsonl'), JSON.stringify({
    ts: isoAgoSeconds(28), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create',
  }) + '\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 0);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('re-arm-fallback');
}));

// -------------------------------------------------------
// 11. Re-arm suppressed: heartbeat-restart fired < 26h ago
// -------------------------------------------------------

test('heartbeat-restart fired < 26h → no re-arm', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 1800);
  // fired 2h ago — within the 26h window
  fs.writeFileSync(state(h, 'routine-metrics.jsonl'), JSON.stringify({
    ts: isoAgoSeconds(2), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create',
  }) + '\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 0);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 12. checkWatchdog in doctor-check.ts: disabled → ok
// -------------------------------------------------------

const DOCTOR_BASE = {
  agent_name: null, language: null, timezone: null, escalation: 'balanced',
  channels: {}, env: {}, heartbeat: { enabled: true, every: '2h' },
  routines: [], quality_gate: { tier: 'budget' },
};

async function doctorWatchdogCheck(h: Hermit) {
  const r = await runScript('doctor-check.ts', { cwd: h.dir });
  const checks = JSON.parse(r.stdout).checks.filter((c: any) => c.id === 'watchdog');
  expect(checks.length).toBeGreaterThan(0); // watchdog check missing otherwise
  return checks[0];
}

test('doctor checkWatchdog: disabled → ok', withHermit(async (h) => {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
    JSON.stringify({ watchdog: { enabled: false }, ...DOCTOR_BASE }, null, 2) + '\n');
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('ok');
  expect(w.detail).toContain('disabled');
}));

// -------------------------------------------------------
// 13. checkWatchdog: enabled + recent restart → warn
// -------------------------------------------------------

test('doctor checkWatchdog: restart in last 7d → warn', withHermit(async (h) => {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
    JSON.stringify({
      watchdog: { enabled: true, stale_factor: 2, escalate_after: 3, operator_grace: '15m' },
      ...DOCTOR_BASE,
    }, null, 2) + '\n');
  fs.writeFileSync(eventsFile(h), JSON.stringify({
    ts: isoAgoSeconds(0), action: 'restart', reason: 'dead-process',
  }) + '\n');
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
}));

// -------------------------------------------------------
// install / uninstall without systemctl (Linux-only path)
// -------------------------------------------------------

const isLinux = process.platform === 'linux';

test.if(isLinux)('install without systemctl → exit 0, prints crontab, no traceback', withHermit(async (h) => {
  writeConfig(h);
  // fake-bin has tmux/pgrep stubs but no systemctl — simulates systemd-less host
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'install', { restrictPath: true });
  const out = r.stdout + r.stderr;
  expect(r.exitCode).toBe(0);
  expect(out).toContain('crontab'); // expected crontab guidance
  expect(out).not.toContain('Traceback');
}));

test.if(isLinux)('uninstall without systemctl → exit 0, no traceback', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'uninstall', { restrictPath: true });
  expect(r.exitCode).toBe(0);
  expect(r.stdout + r.stderr).not.toContain('Traceback');
}));

// ---------- inActiveHours unit tests ----------
// 2026-06-11T03:00:00Z → 12:00 Asia/Tokyo (inside 09:00-17:00), 23:00 America/New_York (outside)
const ACTIVE_WINDOW = { start: '09:00', end: '17:00' };
const REF = new Date('2026-06-11T03:00:00Z');

describe('inActiveHours (timezone)', () => {
  test('honours config.timezone, not the machine clock', () => {
    expect(inActiveHours(ACTIVE_WINDOW, 'Asia/Tokyo', REF)).toBe(true);
    expect(inActiveHours(ACTIVE_WINDOW, 'America/New_York', REF)).toBe(false);
  });

  test('fail-open on unparseable timezone', () => {
    expect(inActiveHours(ACTIVE_WINDOW, 'Not/AZone', REF)).toBe(true);
  });
});
