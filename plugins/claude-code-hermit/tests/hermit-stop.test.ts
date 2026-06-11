import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCRIPTS_DIR } from './helpers/run';

// Black-box contract tests for the hermit-stop lifecycle script. Written
// against the Python implementation first, then flipped to the TS port in the
// same commit — STOP_CMD is the single line that changes.
const STOP_IMPL = fs.existsSync(path.join(SCRIPTS_DIR, 'hermit-stop.ts'))
  ? path.join(SCRIPTS_DIR, 'hermit-stop.ts')
  : path.join(SCRIPTS_DIR, 'hermit-stop.py');
const STOP_CMD = STOP_IMPL.endsWith('.ts') ? ['bun', STOP_IMPL] : ['python3', STOP_IMPL];
const IS_TS = STOP_IMPL.endsWith('.ts');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-stop-'));
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'sessions'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(extra: Record<string, any> = {}) {
  fs.writeFileSync(
    path.join(dir, '.claude-code-hermit', 'config.json'),
    JSON.stringify({ agent_name: 't', always_on: true, tmux_session_name: 'hermit-test', ...extra }, null, 2)
  );
}

function writeRuntime(data: Record<string, any>) {
  fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'state', 'runtime.json'), JSON.stringify(data));
}

function readJson(rel: string) {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf-8'));
}

// Stateful fake tmux: `has-session` consults a marker file so tests can make
// the session "exit" mid-run; every invocation is logged for assertions.
function installFakeTmux(opts: { hasSession?: boolean; dieOnSessionClose?: boolean } = {}) {
  const bin = path.join(dir, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'tmux.log');
  const aliveMarker = path.join(dir, 'session-alive');
  if (opts.hasSession) fs.writeFileSync(aliveMarker, '1');
  const dieLine = opts.dieOnSessionClose
    ? `case "$*" in *session-close*) rm -f '${aliveMarker}' ;; esac`
    : '';
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    `#!/usr/bin/env bash
echo "$@" >> '${log}'
${dieLine}
case "$1" in
  has-session) [ -f '${aliveMarker}' ] && exit 0 || exit 1 ;;
  kill-session) rm -f '${aliveMarker}'; exit 0 ;;
  *) exit 0 ;;
esac
`
  );
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  return { log, aliveMarker, bin };
}

async function runStop(args: string[], fakeBin?: string) {
  const env: Record<string, string> = { ...process.env } as any;
  if (fakeBin) env.PATH = `${fakeBin}:${env.PATH}`;
  const proc = Bun.spawn([...STOP_CMD, ...args], {
    cwd: dir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe('hermit-stop contract', () => {
  test('no config → exit 1 with guidance', async () => {
    const { exitCode, stdout } = await runStop([]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('No config found');
  });

  test('no session, interactive runtime → guidance, always_on reset, lifecycle untouched', async () => {
    writeConfig();
    writeRuntime({ runtime_mode: 'interactive', session_state: 'in_progress' });
    const { bin } = installFakeTmux({ hasSession: false });
    const { exitCode, stdout } = await runStop([], bin);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('running in interactive mode');
    expect(readJson('.claude-code-hermit/config.json').always_on).toBe(false);
    // The Stop hook owns the idle transition — stop must not have written it.
    expect(readJson('.claude-code-hermit/state/runtime.json').session_state).toBe('in_progress');
  });

  test('no session, non-interactive → idle written with cleared transition', async () => {
    writeConfig();
    writeRuntime({ runtime_mode: 'tmux', session_state: 'in_progress', transition: 'stopping' });
    fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'sessions', 'S-001-REPORT.md'), '# r');
    const { bin } = installFakeTmux({ hasSession: false });
    const { exitCode, stdout } = await runStop([], bin);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No running session: hermit-test');
    expect(stdout).toContain('S-001-REPORT.md');
    const rt = readJson('.claude-code-hermit/state/runtime.json');
    expect(rt.session_state).toBe('idle');
    expect(rt.transition).toBeNull();
    expect(rt.transition_target).toBeNull();
    expect(rt.transition_started_at).toBeNull();
    expect(rt.shutdown_completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/);
    expect(rt.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/);
    expect(readJson('.claude-code-hermit/config.json').always_on).toBe(false);
  });

  test('--force with live session → kill-session, unclean_shutdown recorded', async () => {
    writeConfig();
    writeRuntime({ runtime_mode: 'tmux', session_state: 'in_progress' });
    const { bin, log } = installFakeTmux({ hasSession: true });
    const { exitCode, stdout } = await runStop(['--force'], bin);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Force-killing session: hermit-test');
    expect(stdout).toContain('not closed gracefully');
    expect(fs.readFileSync(log, 'utf-8')).toContain('kill-session -t hermit-test');
    const rt = readJson('.claude-code-hermit/state/runtime.json');
    expect(rt.session_state).toBe('idle');
    expect(rt.last_error).toBe('unclean_shutdown');
    expect(rt.shutdown_requested_at).toBeDefined();
    expect(readJson('.claude-code-hermit/config.json').always_on).toBe(false);
  });

  test('graceful: session-close sent, session exits, no report → unclean recorded', async () => {
    writeConfig({ heartbeat: { enabled: true } });
    writeRuntime({ runtime_mode: 'tmux', session_state: 'in_progress' });
    const { bin, log } = installFakeTmux({ hasSession: true, dieOnSessionClose: true });
    const { exitCode, stdout } = await runStop([], bin);
    expect(exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(log, 'utf-8');
    expect(tmuxLog).toContain('heartbeat stop');
    expect(tmuxLog).toContain('session-close --shutdown');
    expect(stdout).toContain('Session exited without generating a report');
    const rt = readJson('.claude-code-hermit/state/runtime.json');
    expect(rt.session_state).toBe('idle');
    expect(rt.last_error).toBe('unclean_shutdown');
    expect(rt.shutdown_requested_at).toBeDefined();
    expect(rt.shutdown_completed_at).toBeDefined();
  }, 20000);

  test.if(IS_TS)('lifecycle lock contention → exit 1, no state mutation', async () => {
    writeConfig();
    writeRuntime({ runtime_mode: 'tmux', session_state: 'in_progress' });
    const lock = path.join(dir, '.claude-code-hermit', 'state', '.lifecycle.lock');
    // A real, signalable, same-user holder — a foreign-user pid (EPERM) is no
    // longer treated as a hermit holder, so pid 1 would be taken over.
    const holder = Bun.spawn(['sleep', '30']);
    try {
      fs.writeFileSync(lock, String(holder.pid));
      const { bin } = installFakeTmux({ hasSession: false });
      const { exitCode, stdout } = await runStop([], bin);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('Another lifecycle operation in progress');
      expect(readJson('.claude-code-hermit/state/runtime.json').session_state).toBe('in_progress');
      expect(readJson('.claude-code-hermit/config.json').always_on).toBe(true);
    } finally {
      holder.kill();
    }
  });
});
