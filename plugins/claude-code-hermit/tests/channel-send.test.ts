// Contract tests for scripts/channel-send.ts + scripts/lib/channel-send.ts —
// the first script-owned (non-model) channel send. Exercised as a subprocess
// (the CLI wrapper) against a local HTTP stub standing in for the platform API
// (HERMIT_TELEGRAM_API_URL override), so no real bot token or network access
// is needed.

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { startHttpStub, type Stub } from './helpers/http-stub';
import { unconsolidated, dbExists } from '../scripts/lib/channel-log';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function setupChannelWorkdir(): Workdir {
  const wd = setupWorkdir();
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  write(hermit(wd.dir, 'config.json'), JSON.stringify({
    channels: { telegram: { enabled: true, dm_channel_id: '12345', state_dir: '.claude.local/channels/telegram' } },
  }));
  return wd;
}

describe('channel-send CLI', () => {
  let stub: Stub | undefined;
  let wd: Workdir | undefined;

  afterEach(() => {
    stub?.stop();
    stub = undefined;
    wd?.cleanup();
    wd = undefined;
  });

  test('success: 2xx -> exit 0, request reaches the stub, out-log row written', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r = await runScript('channel-send.ts', {
      args: [hermit(wd.dir), 'hello operator'],
      env: { HERMIT_TELEGRAM_API_URL: stub.url },
    });
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toBe('hello operator');
    expect(stub.requests[0].body.chat_id).toBe('12345');

    const rows = unconsolidated(hermit(wd.dir)).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ source: 'telegram', chat_id: '12345', direction: 'out', text: 'hello operator' });
  });

  test('truncates text over the telegram 4096-char limit', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const longText = 'x'.repeat(5000);
    const r = await runScript('channel-send.ts', {
      args: [hermit(wd.dir), longText],
      env: { HERMIT_TELEGRAM_API_URL: stub.url },
    });
    expect(r.exitCode).toBe(0);
    expect(stub.requests[0].body.text.length).toBe(4096);
  });

  test('reads the message from stdin when the text arg is "-"', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r = await runScript('channel-send.ts', {
      args: [hermit(wd.dir), '-'],
      stdin: 'from stdin',
      env: { HERMIT_TELEGRAM_API_URL: stub.url },
    });
    expect(r.exitCode).toBe(0);
    expect(stub.requests[0].body.text).toBe('from stdin');
  });

  test('whitespace-only stdin -> empty text, exit non-zero, no request sent', async () => {
    stub = startHttpStub();
    wd = setupChannelWorkdir();
    const r = await runScript('channel-send.ts', {
      args: [hermit(wd.dir), '-'],
      stdin: '   \n  ',
      env: { HERMIT_TELEGRAM_API_URL: stub.url },
    });
    expect(r.exitCode).not.toBe(0);
    expect(stub.requests.length).toBe(0);
  });

  test('non-2xx platform response -> exit non-zero, no out-log row', async () => {
    stub = startHttpStub();
    stub.setStatus(400);
    wd = setupChannelWorkdir();
    const r = await runScript('channel-send.ts', {
      args: [hermit(wd.dir), 'hello'],
      env: { HERMIT_TELEGRAM_API_URL: stub.url },
    });
    expect(r.exitCode).not.toBe(0);
    expect(dbExists(hermit(wd.dir))).toBe(false);
  });

  test('dead listener -> exit non-zero with a stderr reason', async () => {
    wd = setupChannelWorkdir();
    const r = await runScript('channel-send.ts', {
      args: [hermit(wd.dir), 'hello'],
      env: { HERMIT_TELEGRAM_API_URL: 'http://127.0.0.1:1' },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test('missing token file -> exit non-zero, missing_token reason', async () => {
    wd = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), JSON.stringify({
      channels: { telegram: { enabled: true, dm_channel_id: '12345', state_dir: '.claude.local/channels/telegram' } },
    }));
    const r = await runScript('channel-send.ts', { args: [hermit(wd.dir), 'hello'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('missing_token');
  });

  test('no eligible channel -> exit non-zero, no_reachable_channel reason', async () => {
    wd = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), JSON.stringify({ channels: {} }));
    const r = await runScript('channel-send.ts', { args: [hermit(wd.dir), 'hello'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('no_reachable_channel');
  });

  test('unreadable config -> exit non-zero, config_read_failed reason', async () => {
    wd = setupWorkdir();
    // No config.json written at all.
    const r = await runScript('channel-send.ts', { args: [hermit(wd.dir), 'hello'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('config_read_failed');
  });

  test('missing arguments -> usage error, exit non-zero', async () => {
    const r = await runScript('channel-send.ts', { args: [] });
    expect(r.exitCode).not.toBe(0);
  });
});
