// Contract tests for scripts/permission-denied-notify.ts — the PermissionDenied
// hook that surfaces an auto-mode classifier denial to the channel on the
// managed unattended session. Exercised as a subprocess (stdin in, exit code +
// stub requests out), the same boundary Claude Code sees. This hook cannot
// block and never emits hookSpecificOutput.retry — every case exits 0.

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { startHttpStub, type Stub } from './helpers/http-stub';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function setupChannelWorkdir(): Workdir {
  const wd = setupWorkdir();
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  write(hermit(wd.dir, 'config.json'), JSON.stringify({
    always_on: true,
    channels: {
      primary: 'telegram',
      telegram: { enabled: true, dm_channel_id: '12345', allowed_users: ['u1'], state_dir: '.claude.local/channels/telegram' },
    },
  }));
  return wd;
}

// Mirrors Claude Code's real PermissionDenied stdin payload: tool_name +
// tool_input + permission_mode, and NO reason field — the classifier's reason
// text stays in the transcript / Recently-denied view, it is not delivered on
// the hook's stdin. The alert must be useful from this shape alone.
const DENIAL_PAYLOAD = {
  hook_event_name: 'PermissionDenied',
  permission_mode: 'auto',
  tool_name: 'Bash',
  tool_input: { command: 'bun scripts/apply-settings.ts .claude/settings.local.json artifact-allow' },
};

const run = (payload: object, dir: string, stubUrl: string, env: Record<string, string> = {}) =>
  runScript('permission-denied-notify.ts', {
    stdin: JSON.stringify(payload),
    cwd: dir,
    env: { HERMIT_MANAGED: '1', HERMIT_TELEGRAM_API_URL: stubUrl, ...env },
  });

describe('permission-denied-notify', () => {
  let stub: Stub | undefined;
  let wd: Workdir | undefined;

  afterEach(() => {
    stub?.stop();
    stub = undefined;
    wd?.cleanup();
    wd = undefined;
  });

  test('managed + always_on + eligible channel — sends exactly one notification', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toContain('Auto-mode denied: Bash');
    // The alert points at *what* was blocked (tool + input), the only signal
    // the real payload carries — not a reason string it doesn't deliver.
    expect(stub.requests[0].body.text).toContain('apply-settings.ts');
  });

  test('includes the classifier reason when a payload happens to carry one (forward-compat)', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r = await run({ ...DENIAL_PAYLOAD, reason: '[Self-Modification] blocked' }, wd.dir, stub.url);
    expect(r.exitCode).toBe(0);
    expect(stub.requests[0].body.text).toContain('Self-Modification');
  });

  test('stdout is always empty (never emits hookSpecificOutput)', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
    expect(r.stdout.trim()).toBe('');
  });

  test('HERMIT_MANAGED absent — attended session, no request', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url, { HERMIT_MANAGED: '' });
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
  });

  test('HERMIT_DENY_NOTIFY=off — escape hatch, no request', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url, { HERMIT_DENY_NOTIFY: 'off' });
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
  });

  test('always_on: false — no request', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    write(hermit(wd.dir, 'config.json'), JSON.stringify({
      always_on: false,
      channels: { primary: 'telegram', telegram: { enabled: true, dm_channel_id: '12345', state_dir: '.claude.local/channels/telegram' } },
    }));
    const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
  });

  test('no eligible channel — no request', async () => {
    stub = startHttpStub();
    wd = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), JSON.stringify({ always_on: true, channels: {} }));
    const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
  });

  test('channel likely down — no request (do not fire into a dead channel)', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    fs.mkdirSync(hermit(wd.dir, 'state'), { recursive: true });
    write(hermit(wd.dir, 'state', 'channel-health.json'), JSON.stringify({ telegram: { last_success_at: null, consecutive_failures: 3 } }));
    const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
  });

  test('dedup: identical payload twice within the window sends only once', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r1 = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
    expect(r1.exitCode).toBe(0);
    const r2 = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
    expect(r2.exitCode).toBe(0);
    expect(stub.requests.length).toBe(1);
  });

  test('dedup: a different payload still sends', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    await run(DENIAL_PAYLOAD, wd.dir, stub.url);
    const other = { tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, reason: 'different' };
    await run(other, wd.dir, stub.url);
    expect(stub.requests.length).toBe(2);
  });

  test('malformed stdin — exit 0, no request', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r = await runScript('permission-denied-notify.ts', {
      stdin: '{broken',
      cwd: wd.dir,
      env: { HERMIT_MANAGED: '1', HERMIT_TELEGRAM_API_URL: stub.url },
    });
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
  });

  test('empty stdin — exit 0, no request', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r = await runScript('permission-denied-notify.ts', {
      stdin: '',
      cwd: wd.dir,
      env: { HERMIT_MANAGED: '1', HERMIT_TELEGRAM_API_URL: stub.url },
    });
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
  });

  test('missing config.json — fail-open, no request, exit 0', async () => {
    stub = startHttpStub();
    wd = setupWorkdir();
    const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
  });
});
