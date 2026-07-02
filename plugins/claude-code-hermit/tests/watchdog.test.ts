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
import { inActiveHours, isNearDailyAutoClose } from '../scripts/hermit-watchdog';

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

/** Fake tmux: sessionAlive 0 = alive, 1 = dead. send-keys/kill-session log to tmux-calls.log.
 *  runtimeSnapshotPath: if set, the stub copies runtime.json to this path when it sees send-keys .../clear,
 *  proving the context_cleared marker was written before the /clear keystroke. */
function writeFakeTmux(h: Hermit, sessionAlive: 0 | 1, paneContent = 'tmux pane content', runtimeSnapshotPath?: string): void {
  const log = path.join(h.dir, 'tmux-calls.log');
  const stub = path.join(h.fakeBin, 'tmux');
  const runtimePath = state(h, 'runtime.json');
  const sendKeysExtra = runtimeSnapshotPath
    ? `[[ "$*" == *"/clear"* || "$*" == *"/compact"* ]] && cat "${runtimePath}" > "${runtimeSnapshotPath}"`
    : 'true';
  fs.writeFileSync(stub, `#!/usr/bin/env bash
case "$1" in
  has-session) exit ${sessionAlive} ;;
  capture-pane) echo "${paneContent}" ;;
  send-keys) echo "send-keys $@" >> "${log}" ; ${sendKeysExtra} ;;
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
// 11b. started event is not treated as fired by re-arm check
// -------------------------------------------------------

test('started event does not count as fired for re-arm check', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 1800);
  // started 1h ago (recent) + fired 28h ago. If started were counted as fired, re-arm
  // would be suppressed. With correct behavior (only event==="fired" counts), re-arm fires.
  fs.writeFileSync(state(h, 'routine-metrics.jsonl'), [
    JSON.stringify({ ts: isoAgoSeconds(28), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create' }),
    JSON.stringify({ ts: isoAgoSeconds(1), routine_id: 'heartbeat-restart', event: 'started', delivery: 'cron-create' }),
  ].join('\n') + '\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 0);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('re-arm-fallback');
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

const readWatchdogStateFile = (h: Hermit) => readJson(state(h, 'watchdog-state.json'));

/** Seed watchdog-state.json with a given last_run (null ⇒ omit the field). */
function setLastRun(h: Hermit, iso: string | null): void {
  const p = state(h, 'watchdog-state.json');
  const cur = fs.existsSync(p) ? readJson(p) : { consecutive_stale: 0 };
  if (iso === null) delete cur.last_run; else cur.last_run = iso;
  fs.writeFileSync(p, JSON.stringify(cur) + '\n');
}

function writeDoctorConfig(h: Hermit, enabled = true): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
    JSON.stringify({
      watchdog: enabled
        ? { enabled: true, stale_factor: 2, escalate_after: 3, operator_grace: '15m' }
        : { enabled: false },
      ...DOCTOR_BASE,
    }, null, 2) + '\n');
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
  writeDoctorConfig(h);
  fs.writeFileSync(eventsFile(h), JSON.stringify({
    ts: isoAgoSeconds(0), action: 'restart', reason: 'dead-process',
  }) + '\n');
  setLastRun(h, new Date().toISOString()); // fresh liveness → exercise the restart-summary path, not the liveness warn
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('restarts: 1');
}));

// -------------------------------------------------------
// liveness: last_run stamp (script) + doctor liveness branches
// -------------------------------------------------------

test('run stamps last_run before the enabled gate (enabled:false)', withHermit(async (h) => {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'),
    '{"watchdog": {"enabled": false}}\n');
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const ws = readWatchdogStateFile(h);
  expect(typeof ws.last_run).toBe('string');
  expect(Date.now() - Date.parse(ws.last_run)).toBeLessThan(60_000);
}));

test('doctor checkWatchdog: enabled + fresh last_run + quiet → ok, shows last tick', withHermit(async (h) => {
  writeDoctorConfig(h);
  setLastRun(h, new Date().toISOString());
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('ok');
  expect(w.detail).toContain('last tick');
}));

test('doctor checkWatchdog: enabled + stale last_run + tmux → warn, install hint', withHermit(async (h) => {
  writeDoctorConfig(h);          // setupHermit runtime_mode = tmux
  setLastRun(h, isoAgo(1));      // 1h ago → stale
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('not firing');
  expect(w.detail).toContain('hermit-watchdog install');
}));

test('doctor checkWatchdog: enabled + missing last_run + docker → warn, recreate hint', withHermit(async (h) => {
  writeDoctorConfig(h);
  patchRuntime(h, { runtime_mode: 'docker' });
  // no watchdog-state.json → last_run missing
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('not firing');
  expect(w.detail).toContain('force-recreate');
}));

test('doctor checkWatchdog: enabled + stale last_run + unknown runtime → warn, both hints', withHermit(async (h) => {
  writeDoctorConfig(h);
  fs.rmSync(state(h, 'runtime.json')); // runtime_mode unknown
  setLastRun(h, isoAgo(1));
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('hermit-watchdog install');
  expect(w.detail).toContain('force-recreate');
}));

test('doctor checkWatchdog: stale last_run + recent restart → not-firing wins, summary suppressed', withHermit(async (h) => {
  writeDoctorConfig(h);
  fs.writeFileSync(eventsFile(h), JSON.stringify({
    ts: isoAgoSeconds(0), action: 'restart', reason: 'dead-process',
  }) + '\n');
  setLastRun(h, isoAgo(1)); // stale → liveness takes precedence
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('not firing');
  expect(w.detail).not.toContain('restarts:');
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

// -------------------------------------------------------
// post-close clear tests
// -------------------------------------------------------

function writeClearMarker(h: Hermit): void {
  fs.writeFileSync(state(h, 'clear-requested.json'),
    JSON.stringify({ requested_at: new Date().toISOString(), reason: 'daily-auto-close' }) + '\n');
}

// watchdog.enabled: false verifies clear fires independently of the watchdog restart path
function writePostCloseClearConfig(h: Hermit): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    post_close_clear: true,
    watchdog: { enabled: false },
    heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
  }, null, 2) + '\n');
}

test('post_close_clear: marker + idle + tmux alive + operator silent → /clear sent, marker deleted',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    // runtime: idle (as set by session-mgr after auto-close)
    patchRuntime(h, { session_state: 'idle' });
    writeClearMarker(h);
    // operator idle 30 min ago
    fs.writeFileSync(state(h, 'last-operator-action.json'),
      JSON.stringify({ at: isoAgo(0.5) }) + '\n');
    const snapshotPath = path.join(h.dir, 'runtime-at-clear.json');
    writeFakeTmux(h, 0, 'tmux pane content', snapshotPath); // tmux session alive
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(false);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('post-close-clear');
    const runtimeAtClear = readJson(snapshotPath);
    expect(runtimeAtClear.context_cleared).toBe(true);
    // last_run stamp precedes the maybePostCloseClear process.exit(0) (finding 2)
    const ws = readWatchdogStateFile(h);
    expect(typeof ws.last_run).toBe('string');
    expect(Date.now() - Date.parse(ws.last_run)).toBeLessThan(60_000);
  }));

test('post_close_clear: operator active < 10 min → no send, marker kept',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    patchRuntime(h, { session_state: 'idle' });
    writeClearMarker(h);
    // operator active 3 min ago — within the 10-min grace
    fs.writeFileSync(state(h, 'last-operator-action.json'),
      JSON.stringify({ at: isoAgo(3 / 60) }) + '\n');
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

test('post_close_clear: session not idle → no send, marker kept',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    // setupHermit() defaults to session_state: in_progress — no patchRuntime needed
    writeClearMarker(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

test('post_close_clear: tmux session dead → no send, marker kept',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    patchRuntime(h, { session_state: 'idle' });
    writeClearMarker(h);
    writeFakeTmux(h, 1); // tmux session dead (hermit-stop ran)
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

test('post_close_clear: shutdown requested → no send, marker kept',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    patchRuntime(h, { session_state: 'idle', shutdown_requested_at: isoAgo(0.5) });
    writeClearMarker(h);
    writeFakeTmux(h, 0); // tmux still briefly alive mid-shutdown
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

test('post_close_clear: no marker → no send',
  withHermit(async (h) => {
    writePostCloseClearConfig(h);
    patchRuntime(h, { session_state: 'idle' });
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

test('post_close_clear: flag false → no send even with marker',
  withHermit(async (h) => {
    writeConfig(h); // standard config: watchdog.enabled true, no post_close_clear
    patchRuntime(h, { session_state: 'idle' });
    writeClearMarker(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
  }));

// -------------------------------------------------------
// context-clear tests
// -------------------------------------------------------

const SESSION_ID = 'S-001';

/** Write a cost-log entry under <hermit.dir>/.claude/cost-log.jsonl. */
function writeCostLog(h: Hermit, entries: { session_id: string; input_tokens: number; cache_write_tokens: number; cache_read_tokens: number; timestamp?: string }[]): void {
  const dir = path.join(h.dir, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map(e => JSON.stringify({
    timestamp: e.timestamp ?? new Date().toISOString(),
    session_id: e.session_id,
    input_tokens: e.input_tokens,
    cache_write_tokens: e.cache_write_tokens,
    cache_read_tokens: e.cache_read_tokens,
    output_tokens: 500,
    total_tokens: e.input_tokens + e.cache_write_tokens + e.cache_read_tokens + 500,
    estimated_cost_usd: 1.0,
  })).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'cost-log.jsonl'), lines);
}

/** Write config with context_clear_tokens enabled and watchdog.enabled: false (pre-enabled gate). */
function writeContextClearConfig(h: Hermit, threshold = 700000): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: false, context_clear_tokens: threshold },
    heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
  }, null, 2) + '\n');
}

/** Write runtime.json for an always-on hermit with given session_state. */
function writeAlwaysOnRuntime(h: Hermit, session_state = 'idle'): void {
  patchRuntime(h, { session_state, runtime_mode: 'tmux', session_id: SESSION_ID });
}

/** Write watchdog-state with a specific last_pane_hash_ctx (simulates second tick). */
function primeContextHash(h: Hermit, hash: string): void {
  const p = state(h, 'watchdog-state.json');
  const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  fs.writeFileSync(p, JSON.stringify({ ...existing, last_pane_hash_ctx: hash }) + '\n');
}

test('context_clear: bloated idle + quiescent + operator silent → /clear sent on 2nd tick',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    // Bloated: 850K prompt-side tokens
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    const snapshotPath = path.join(h.dir, 'runtime-at-clear.json');
    // Fake tmux returns deterministic pane content so hash matches across both ticks
    writeFakeTmux(h, 0, 'static pane content', snapshotPath);
    writeFakePgrep(h, 1);

    // Tick 1: hash recorded, no /clear yet
    const r1 = await watchdog(h, 'run');
    expect(r1.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);

    // Tick 2: same hash → /clear fires
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-clear');
    const runtimeAtClear = readJson(snapshotPath);
    expect(runtimeAtClear.context_cleared).toBe(true);
  }));

test('context_clear: fires for in_progress session (evolve case) when quiescent + bloated',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'in_progress');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1 — prime hash
    const r2 = await watchdog(h, 'run'); // tick 2 — should clear
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
  }));

test('context_clear: fires with watchdog.enabled: false (independent of restart path)',
  withHermit(async (h) => {
    // config has enabled: false — verifies context-clear runs before the enabled gate
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1
    const r2 = await watchdog(h, 'run'); // tick 2
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
  }));

test('context_clear: under threshold → no /clear',
  withHermit(async (h) => {
    writeContextClearConfig(h, 700000);
    writeAlwaysOnRuntime(h, 'idle');
    // Only 100K tokens — under threshold
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 50000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    primeContextHash(h, crypto.createHash('sha256').update('static pane content\n').digest('hex'));
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

test('context_clear: threshold 0 → disabled, no /clear',
  withHermit(async (h) => {
    writeContextClearConfig(h, 0);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    primeContextHash(h, crypto.createHash('sha256').update('static pane content\n').digest('hex'));
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

test('context_clear: interactive mode → no /clear',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    patchRuntime(h, { session_state: 'idle', runtime_mode: 'interactive', session_id: SESSION_ID });
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    primeContextHash(h, crypto.createHash('sha256').update('static pane content\n').digest('hex'));
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

test('context_clear: transition set → no /clear',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    patchRuntime(h, { session_state: 'idle', runtime_mode: 'tmux', session_id: SESSION_ID, transition: 'cleaning' });
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    primeContextHash(h, crypto.createHash('sha256').update('static pane content\n').digest('hex'));
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

test('context_clear: operator active < 10 min → no /clear',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    // Operator was active 3 min ago
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(3 / 60) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    primeContextHash(h, crypto.createHash('sha256').update('static pane content\n').digest('hex'));
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

test('context_clear: pane hash changed between ticks → no /clear (active turn)',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    // Store a hash that won't match (simulates pane animation between ticks)
    primeContextHash(h, 'different-hash-from-prev-tick');
    writeFakeTmux(h, 0, 'static pane content'); // returns a different hash than stored
    writeFakePgrep(h, 1);

    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

test('context_clear: no matching session_id in cost-log → no /clear',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    // Cost-log has entries for a different session
    writeCostLog(h, [{ session_id: 'S-999', input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    primeContextHash(h, crypto.createHash('sha256').update('static pane content\n').digest('hex'));
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

test('context_clear: idempotence — same entry not re-cleared on subsequent ticks',
  withHermit(async (h) => {
    writeContextClearConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    const ts = new Date(Date.now() - 3600_000).toISOString(); // fixed timestamp
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000, timestamp: ts }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    // Simulate that this entry was already cleared: last_cleared_cost_ts matches the ts
    const wdState = { last_pane_hash_ctx: crypto.createHash('sha256').update('static pane content\n').digest('hex'), last_cleared_cost_ts: ts };
    fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify(wdState) + '\n');

    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

// -------------------------------------------------------
// context-compact tests (PROP-011 commit 3: maybeContextCompact)
// -------------------------------------------------------

/** Write config with context_hygiene.compact enabled and watchdog.enabled: false (pre-enabled gate). */
function writeContextCompactConfig(h: Hermit, opts: {
  minContextTokens?: number; minInterval?: string; clearTokens?: number;
  routines?: unknown[]; timezone?: string;
} = {}): void {
  fs.writeFileSync(path.join(h.dir, '.claude-code-hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: false, ...(opts.clearTokens ? { context_clear_tokens: opts.clearTokens } : {}) },
    context_hygiene: {
      compact: {
        enabled: true,
        min_context_tokens: opts.minContextTokens ?? 150000,
        min_interval: opts.minInterval ?? '4h',
      },
    },
    heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
    routines: opts.routines ?? [],
    timezone: opts.timezone ?? 'UTC',
  }, null, 2) + '\n');
}

function writeCompactMarker(h: Hermit, ageSeconds = 0): void {
  fs.writeFileSync(state(h, 'compact-requested.json'), JSON.stringify({
    requested_at: new Date(Date.now() - ageSeconds * 1000).toISOString(), reason: 'test',
  }) + '\n');
}

/** Write watchdog-state with a specific last_pane_hash_compact (simulates second tick for the compact tracker). */
function primeCompactHash(h: Hermit, hash: string): void {
  const p = state(h, 'watchdog-state.json');
  const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  fs.writeFileSync(p, JSON.stringify({ ...existing, last_pane_hash_compact: hash }) + '\n');
}

const STATIC_HASH = crypto.createHash('sha256').update('static pane content\n').digest('hex');

test('context_compact: bloated idle + quiescent + operator silent → /compact sent on 2nd tick, context_cleared never set',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    const snapshotPath = path.join(h.dir, 'runtime-at-compact.json');
    writeFakeTmux(h, 0, 'static pane content', snapshotPath);
    writeFakePgrep(h, 1);

    const r1 = await watchdog(h, 'run'); // tick 1: hash recorded, no compact yet
    expect(r1.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);

    const r2 = await watchdog(h, 'run'); // tick 2: same hash → /compact fires
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/compact');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-compact');
    // context_cleared is context_clear's marker only — compact must never touch it.
    const runtimeAtCompact = readJson(snapshotPath);
    expect(runtimeAtCompact.context_cleared).not.toBe(true);
  }));

test('context_compact: under threshold → no compact', withHermit(async (h) => {
  writeContextCompactConfig(h, { minContextTokens: 150000 });
  writeAlwaysOnRuntime(h, 'idle');
  writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 50000 }]);
  fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
  writeFakeTmux(h, 0, 'static pane content');
  writeFakePgrep(h, 1);
  primeCompactHash(h, STATIC_HASH);

  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
}));

test('context_compact: disabled (no context_hygiene block) → no-op even if bloated', withHermit(async (h) => {
  writeContextClearConfig(h, 0); // watchdog.enabled:false, no context_hygiene block at all
  writeAlwaysOnRuntime(h, 'idle');
  writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
  fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
  writeFakeTmux(h, 0, 'static pane content');
  writeFakePgrep(h, 1);
  primeCompactHash(h, STATIC_HASH);

  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
}));

test('context_compact: interactive mode → no compact', withHermit(async (h) => {
  writeContextCompactConfig(h);
  patchRuntime(h, { session_state: 'idle', runtime_mode: 'interactive', session_id: SESSION_ID });
  writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
  fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
  writeFakeTmux(h, 0, 'static pane content');
  writeFakePgrep(h, 1);
  primeCompactHash(h, STATIC_HASH);

  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
}));

test('context_clear takes precedence over compact on the same tick (both thresholds crossed)',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 150000, clearTokens: 700000 });
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 800000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: both trackers prime their hashes
    const r2 = await watchdog(h, 'run'); // tick 2: clear fires first and exits before compact runs
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/clear');
    expect(tmuxLog).not.toContain('/compact');
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('context-clear');
    expect(events).not.toContain('context-compact');
  }));

test('context_compact: boundary marker waives min_interval but not the 60k floor',
  withHermit(async (h) => {
    // Threshold low enough that 40K tokens clears it, but the absolute 60K floor still blocks.
    writeContextCompactConfig(h, { minContextTokens: 10000 });
    writeAlwaysOnRuntime(h, 'idle');
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 20000, cache_write_tokens: 0, cache_read_tokens: 20000 }]); // 40K total
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);
    primeCompactHash(h, STATIC_HASH);
    writeCompactMarker(h); // fresh marker — would waive min_interval, but floor is absolute

    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    // A fresh marker is preserved (not wasted) when the floor blocks the compact —
    // it keeps its interval-cooldown waiver until the compact it enables actually
    // fires or it goes stale. Consuming it here would drop the waiver a tick early.
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(true);
  }));

test('context_compact: min_interval suppresses a second compact inside the window (no marker)',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 150000, minInterval: '4h' });
    writeAlwaysOnRuntime(h, 'idle');
    const ts1 = new Date(Date.now() - 3600_000).toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts1 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: prime hash
    await watchdog(h, 'run'); // tick 2: fires — sets last_compacted_at to now

    // New (larger) turn — different cost-log timestamp so idempotence wouldn't be the
    // reason a re-fire is blocked; isolates min_interval as the actual blocker.
    const ts2 = new Date().toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 100000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts2 }]);

    await watchdog(h, 'run'); // tick 3: hash reset to null after firing → re-primes
    await watchdog(h, 'run'); // tick 4: hash matches again, but min_interval (4h) blocks

    const events = fs.readFileSync(eventsFile(h), 'utf-8').split('\n').filter(l => l.includes('context-compact'));
    expect(events.length).toBe(1); // only the tick-2 fire, not a second one
  }));

test('context_compact: fresh boundary marker waives min_interval and fires again',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 150000, minInterval: '4h' });
    writeAlwaysOnRuntime(h, 'idle');
    const ts1 = new Date(Date.now() - 3600_000).toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts1 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: prime hash
    await watchdog(h, 'run'); // tick 2: fires — sets last_compacted_at to now

    const ts2 = new Date().toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 100000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts2 }]);
    await watchdog(h, 'run'); // tick 3: re-primes hash after reset

    writeCompactMarker(h); // fresh boundary marker — waives the still-open min_interval
    await watchdog(h, 'run'); // tick 4: hash matches, marker waives interval → fires again

    const events = fs.readFileSync(eventsFile(h), 'utf-8').split('\n').filter(l => l.includes('context-compact'));
    expect(events.length).toBe(2);
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(false); // consumed
  }));

test('context_compact: fresh boundary marker survives the two-tick quiescence wait under an active interval cooldown',
  withHermit(async (h) => {
    // Regression: the marker used to be consumed on read (tick 1), a full tick before
    // the quiescence gate confirms the pane is stable (tick 2) — so under an active
    // interval cooldown the waiver was gone by the time the compact could fire, and
    // the compact the boundary requested never happened. The hash is deliberately NOT
    // pre-primed here, mirroring a real boundary where work just churned the pane.
    writeContextCompactConfig(h, { minContextTokens: 150000, minInterval: '4h' });
    writeAlwaysOnRuntime(h, 'idle');
    // Interval cooldown active: compacted 1h ago, on a *different* cost entry so
    // idempotence isn't the blocker — this isolates min_interval as the thing the
    // marker must waive.
    fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
      last_compacted_at: new Date(Date.now() - 3600_000).toISOString(),
      last_compacted_cost_ts: 'earlier-entry',
    }) + '\n');
    const ts = new Date().toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);
    writeCompactMarker(h); // fresh marker, hash not pre-primed

    const r1 = await watchdog(h, 'run'); // tick 1: records hash, not yet stable → no compact, marker preserved
    expect(r1.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(true); // waiver survives to the next tick

    const r2 = await watchdog(h, 'run'); // tick 2: pane stable, marker still waives the cooldown → fires
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/compact');
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(false); // consumed on fire
  }));

describe('isNearDailyAutoClose (midnight-adjacency, unit)', () => {
  const REF_2359 = new Date('2026-06-11T23:59:00Z'); // 1 min before UTC midnight
  const REF_NOON = new Date('2026-06-11T12:00:00Z');
  const routines = [{ id: 'daily-auto-close', schedule: '0 0 * * *', enabled: true }];

  test('within window before midnight → suppresses', () => {
    expect(isNearDailyAutoClose({ routines, timezone: 'UTC' }, 2 * 3600, REF_2359)).toBe(true);
  });

  test('far from the routine → does not suppress', () => {
    expect(isNearDailyAutoClose({ routines, timezone: 'UTC' }, 2 * 3600, REF_NOON)).toBe(false);
  });

  test('routine disabled → does not suppress (fail-open)', () => {
    const disabled = [{ id: 'daily-auto-close', schedule: '0 0 * * *', enabled: false }];
    expect(isNearDailyAutoClose({ routines: disabled, timezone: 'UTC' }, 2 * 3600, REF_2359)).toBe(false);
  });

  test('no daily-auto-close routine configured → does not suppress', () => {
    expect(isNearDailyAutoClose({ routines: [], timezone: 'UTC' }, 2 * 3600, REF_2359)).toBe(false);
  });
});

// ---------- inActiveHours unit tests ----------
// 2026-06-11T03:00:00Z → 12:00 Asia/Tokyo (inside 09:00-17:00), 23:00 America/New_York (outside)
const ACTIVE_WINDOW = { start: '09:00', end: '17:00' };
const REF = new Date('2026-06-11T03:00:00Z');

describe('inActiveHours (timezone)', () => {
  test('honours config.timezone, not the machine clock', () => {
    expect(inActiveHours(ACTIVE_WINDOW, 'Asia/Tokyo', REF)).toBe(true);
    expect(inActiveHours(ACTIVE_WINDOW, 'America/New_York', REF)).toBe(false);
  });

  test('end boundary is exclusive, matching heartbeat-precheck', () => {
    // Pacific/Honolulu reads exactly 17:00 at REF (the window end).
    expect(inActiveHours(ACTIVE_WINDOW, 'Pacific/Honolulu', REF)).toBe(false);
  });

  test('fail-open on unparseable timezone', () => {
    expect(inActiveHours(ACTIVE_WINDOW, 'Not/AZone', REF)).toBe(true);
  });
});
