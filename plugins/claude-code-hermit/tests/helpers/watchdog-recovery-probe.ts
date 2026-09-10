#!/usr/bin/env bun
// Explicit native probe, excluded from bun test discovery. No Claude process or
// operator channels are used. Run from the checkout root with Bun.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dir, '../../../..');
const plugin = path.join(root, 'plugins/claude-code-hermit');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const platform = process.platform;
if (platform !== 'linux' && platform !== 'darwin') throw new Error('Requires native Linux/WSL2 or macOS');

function run(cmd: string[], required = true): string {
  const result = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 15000 });
  if (required && (result.error || result.status !== 0)) {
    throw new Error(`${cmd[0]} failed: ${result.error ?? result.stderr ?? result.status}`);
  }
  return result.status === 0 ? result.stdout.trim() : '';
}

async function until(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(100);
  }
}

const tmux = Bun.which('tmux');
if (!tmux) throw new Error('Missing prerequisite: tmux');
const domain = `gui/${process.getuid!()}`;
if (platform === 'linux') run(['systemctl', '--user', 'show-environment']);
else run(['launchctl', 'print', domain]);
console.log(JSON.stringify({ platform, release: os.release(), bun: Bun.version, tmux: run([tmux, '-V']) }));

const fixture = fs.mkdtempSync(path.join(root, '.watchdog-recovery-probe-'));
const id = `hermit-probe-${process.pid}-${Date.now()}`;
const unit = `${id}.service`;
const label = `com.hermit.watchdog.${id}`;
const hermit = path.join(fixture, '.claude-code-hermit');
const state = path.join(hermit, 'state');
const bin = path.join(fixture, 'bin');
const completed = path.join(fixture, 'completed');
const ready = path.join(fixture, 'ready');
const starts = path.join(fixture, 'starts');
const session = 'replacement';
let registered = false;
const tmuxArgs = [tmux, '-L', id, '-f', '/dev/null'];
// has-session has no stdout: use the pane identity as the liveness signal.
const identity = (name: string) => run([...tmuxArgs, 'display-message', '-p', '-t', name, '#{pid}:#{pane_pid}'], false);
const executable = (file: string, body: string) => fs.writeFileSync(file, body, { mode: 0o755 });

try {
  for (const dir of [state, path.join(hermit, 'bin'), bin, path.join(fixture, 'claude-config')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({
    watchdog: { enabled: true }, heartbeat: { enabled: false }, routines: { enabled: false },
    telemetry_export: { enabled: false }, backup: { enabled: false },
  }));
  const writeRuntime = () => fs.writeFileSync(path.join(state, 'runtime.json'), JSON.stringify({
    version: 1, session_state: 'in_progress', runtime_mode: 'tmux', tmux_session: session,
    shutdown_requested_at: null, shutdown_completed_at: null, last_error: null,
    updated_at: '2020-01-01T00:00:00Z', config_dir: path.join(fixture, 'claude-config'),
  }));
  executable(path.join(bin, 'tmux'), `#!/bin/sh\nexec ${tmuxArgs.map(quote).join(' ')} "$@"\n`);
  const pane = path.join(fixture, 'pane');
  executable(pane, `#!/bin/sh\nprintf ready > ${quote(ready)}\nexec sleep 120\n`);
  executable(path.join(hermit, 'bin/hermit-start'), `#!/bin/sh\nprintf start >> ${quote(starts)}\nexec ${tmuxArgs.map(quote).join(' ')} new-session -d -s ${session} ${quote(pane)}\n`);
  // Execute the actual watchdog CLI. The completion marker captures its exit;
  // scheduler state below separately confirms cleanup has finished.
  executable(path.join(hermit, 'bin/hermit-watchdog'), `#!/bin/sh
export PATH=${quote(`${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`)}
export CLAUDE_CONFIG_DIR=${quote(path.join(fixture, 'claude-config'))}
unset TMUX CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
${quote(process.execPath)} ${quote(path.join(plugin, 'scripts/hermit-watchdog.ts'))} run > ${quote(path.join(fixture, 'tick.log'))} 2>&1
result=$?
printf '%s' "$result" > ${quote(completed)}
exit "$result"
`);
  const templateName = platform === 'linux' ? 'hermit-watchdog@.service' : 'com.hermit.watchdog.plist';
  const template = fs.readFileSync(path.join(plugin, 'state-templates/watchdog', templateName), 'utf8');
  const escape = (s: string) => platform === 'darwin'
    ? s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    : s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  const rendered = template.replaceAll('{{NAME}}', id).replaceAll('{{ROOT}}', escape(fixture))
    .replaceAll('{{UNIT_PATH}}', escape(`${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`));
  const registration = path.join(fixture, platform === 'linux' ? unit : `${label}.plist`);
  fs.writeFileSync(registration, rendered);
  if (platform === 'linux') {
    run(['systemctl', '--user', 'link', '--runtime', registration]);
    registered = true;
    run(['systemctl', '--user', 'daemon-reload']);
  } else {
    run(['launchctl', 'bootstrap', domain, registration]);
    registered = true;
  }

  async function tick(): Promise<void> {
    fs.rmSync(completed, { force: true });
    if (platform === 'linux') run(['systemctl', '--user', 'start', '--no-block', unit]);
    else run(['launchctl', 'kickstart', `${domain}/${label}`]);
    await until('watchdog completion', () => fs.existsSync(completed));
    if (fs.readFileSync(completed, 'utf8') !== '0') throw new Error('Watchdog exited unsuccessfully');
    await until('scheduler completion', () => {
      if (platform === 'linux') {
        const status = run(['systemctl', '--user', 'show', unit, '-p', 'ActiveState', '-p', 'Result']);
        return status.includes('ActiveState=inactive') && status.includes('Result=success');
      }
      const status = run(['launchctl', 'print', `${domain}/${label}`]);
      return /state = (not running|waiting)/.test(status) && /last exit code = 0/.test(status);
    });
  }

  for (const existing of [false, true]) {
    writeRuntime();
    fs.rmSync(ready, { force: true });
    fs.rmSync(starts, { force: true });
    if (existing) run([...tmuxArgs, 'new-session', '-d', '-s', 'sentinel', 'sleep 120']);
    const sentinel = existing ? identity('sentinel') : null;
    await tick();
    await until('replacement ready after scheduler exit', () => fs.existsSync(ready) && identity(session) !== '');
    const replacement = identity(session);
    const launchCount = fs.readFileSync(starts, 'utf8');
    if (!launchCount) throw new Error('Restart path did not invoke hermit-start');
    await tick();
    if (identity(session) !== replacement || fs.readFileSync(starts, 'utf8') !== launchCount) {
      throw new Error('Subsequent tick replaced or killed the resident');
    }
    if (existing && identity('sentinel') !== sentinel) throw new Error('Existing server session was disturbed');
    console.log(`PASS: ${existing ? 'existing' : 'fresh'} server recovery survives both ticks`);
    run([...tmuxArgs, 'kill-session', '-t', session]);
    if (existing) run([...tmuxArgs, 'kill-session', '-t', 'sentinel']);
  }
} catch (error) {
  const log = path.join(fixture, 'tick.log');
  if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-8000));
  throw error;
} finally {
  if (registered) {
    if (platform === 'linux') {
      run(['systemctl', '--user', 'stop', unit], false);
      run(['systemctl', '--user', 'disable', '--runtime', unit], false);
      run(['systemctl', '--user', 'reset-failed', unit], false);
      run(['systemctl', '--user', 'daemon-reload'], false);
    } else run(['launchctl', 'bootout', `${domain}/${label}`], false);
  }
  for (const name of [session, 'sentinel']) run([...tmuxArgs, 'kill-session', '-t', name], false);
  fs.rmSync(fixture, { recursive: true, force: true });
}
