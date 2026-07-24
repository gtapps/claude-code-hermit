// Contract tests for scripts/channel-send.ts + scripts/lib/channel-send.ts —
// the first script-owned (non-model) channel send. Exercised as a subprocess
// (the CLI wrapper) against a local HTTP stub standing in for the platform API
// (HERMIT_TELEGRAM_API_URL override), so no real bot token or network access
// is needed.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { startHttpStub } from './helpers/http-stub';
import { unconsolidated, dbExists } from '../scripts/lib/channel-log';
import { sendOperatorNotice } from '../scripts/lib/channel-send';
import { channelHealthPath } from '../scripts/lib/channel-health';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function setupChannelWorkdir(telegramExtra: object = {}, topExtra: object = {}): Workdir {
  const wd = setupWorkdir();
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  write(hermit(wd.dir, 'config.json'), JSON.stringify({
    ...topExtra,
    channels: { telegram: { enabled: true, dm_channel_id: '12345', state_dir: '.claude.local/channels/telegram', ...telegramExtra } },
  }));
  return wd;
}

describe('channel-send CLI', () => {
  test('success: 2xx -> exit 0, request reaches the stub, out-log row written', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
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
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('truncates text over the telegram 4096-char limit', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const longText = 'x'.repeat(5000);
      const r = await runScript('channel-send.ts', {
        args: [hermit(wd.dir), longText],
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests[0].body.text.length).toBe(4096);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('reads the message from stdin when the text arg is "-"', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('channel-send.ts', {
        args: [hermit(wd.dir), '-'],
        stdin: 'from stdin',
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests[0].body.text).toBe('from stdin');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('whitespace-only stdin -> empty text, exit non-zero, no request sent', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('channel-send.ts', {
        args: [hermit(wd.dir), '-'],
        stdin: '   \n  ',
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).not.toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('non-2xx platform response -> exit non-zero, no out-log row', async () => {
    const stub = startHttpStub();
    stub.setStatus(400);
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('channel-send.ts', {
        args: [hermit(wd.dir), 'hello'],
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).not.toBe(0);
      expect(dbExists(hermit(wd.dir))).toBe(false);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('dead listener -> exit non-zero with a stderr reason', async () => {
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('channel-send.ts', {
        args: [hermit(wd.dir), 'hello'],
        env: { HERMIT_TELEGRAM_API_URL: 'http://127.0.0.1:1' },
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.length).toBeGreaterThan(0);
    } finally {
      wd.cleanup();
    }
  });

  test('missing token file -> exit non-zero, missing_token reason', async () => {
    const wd = setupWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), JSON.stringify({
        channels: { telegram: { enabled: true, dm_channel_id: '12345', state_dir: '.claude.local/channels/telegram' } },
      }));
      const r = await runScript('channel-send.ts', { args: [hermit(wd.dir), 'hello'] });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('missing_token');
    } finally {
      wd.cleanup();
    }
  });

  test('no eligible channel -> exit non-zero, no_reachable_channel reason', async () => {
    const wd = setupWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), JSON.stringify({ channels: {} }));
      const r = await runScript('channel-send.ts', { args: [hermit(wd.dir), 'hello'] });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('no_reachable_channel');
    } finally {
      wd.cleanup();
    }
  });

  test('unreadable config -> exit non-zero, config_read_failed reason', async () => {
    const wd = setupWorkdir();
    try {
      // No config.json written at all.
      const r = await runScript('channel-send.ts', { args: [hermit(wd.dir), 'hello'] });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('config_read_failed');
    } finally {
      wd.cleanup();
    }
  });

  test('missing arguments -> usage error, exit non-zero', async () => {
    const r = await runScript('channel-send.ts', { args: [] });
    expect(r.exitCode).not.toBe(0);
  });

  test('--tier maintainer routes to maintainer_channel_id when configured', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runScript('channel-send.ts', {
        args: [hermit(wd.dir), '--tier', 'maintainer', '-'],
        stdin: 'ops detail',
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests[0].body.text).toBe('ops detail');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('--tier maintainer with no maintainer channel falls back to the primary chat', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('channel-send.ts', {
        args: [hermit(wd.dir), '--tier', 'maintainer', 'ops detail'],
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345'); // primary, byte-identical to today
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('--tier with an invalid value -> usage error, exit non-zero, no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('channel-send.ts', {
        args: [hermit(wd.dir), '--tier', 'bogus', 'hi'],
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('invalid --tier value');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});

// sendOperatorNotice — exercised in-process (its client/maintainer/sensitive
// routing and SendResult shape aren't reachable through the pass-through CLI).
// sendTelegram reads HERMIT_TELEGRAM_API_URL at call time, so pointing it at the
// stub for the duration of each call is enough; no real network is touched.
describe('sendOperatorNotice tiering', () => {
  const withApi = async <T>(url: string, fn: () => Promise<T>): Promise<T> => {
    process.env.HERMIT_TELEGRAM_API_URL = url;
    try { return await fn(); } finally { delete process.env.HERMIT_TELEGRAM_API_URL; }
  };
  const findings = (wd: Workdir) => fs.readFileSync(hermit(wd.dir, 'sessions', 'SHELL.md'), 'utf8');

  test('maintainer target hit: same token, route maintainer_channel', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'MAINT', fallback: 'client' } }));
      expect(res.maintainer).toMatchObject({ ok: true, route: 'maintainer_channel' });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests[0].path).toContain('bottest-token'); // same bot token as the client route
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('non-technical + no maintainer channel: suppressed to Findings, no HTTP', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    try {
      const res = await withApi(stub.url, () =>
        // fallback:'client' must be overridden by the non-technical profile.
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'SECRET DETAIL', fallback: 'client' } }));
      // Intended Findings home → delivered:true (no re-announce needed).
      expect(res.maintainer).toMatchObject({ ok: true, suppressed: true, route: 'findings', delivered: true });
      expect(stub.requests.length).toBe(0);
      expect(findings(wd)).toContain('SECRET DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('Findings append fails when SHELL.md is missing -> ok:false', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    fs.rmSync(hermit(wd.dir, 'sessions', 'SHELL.md'));
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'X', fallback: 'findings' } }));
      expect(res.maintainer).toMatchObject({ ok: false, route: 'findings', suppressed: true, delivered: false });
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('failed maintainer send -> Findings, never the client chat (fallback:client honored as intent)', async () => {
    const stub = startHttpStub();
    stub.setStatus(500);
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'USD DETAIL', fallback: 'client' } }));
      // Degraded fallback: configured maintainer channel unreachable → delivered:false.
      expect(res.maintainer).toMatchObject({ ok: true, route: 'findings', suppressed: true, delivered: false });
      // Only the failed 500 to the maintainer chat — never a spill to the primary.
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests.some((r) => r.body.chat_id === '12345')).toBe(false);
      expect(findings(wd)).toContain('USD DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('technical + no maintainer channel + fallback:client -> primary, route client, client leg deduped', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { client: 'PLAIN', maintainer: { text: 'MAINT', fallback: 'client' } }));
      expect(res.maintainer).toMatchObject({ ok: true, route: 'client', delivered: true });
      expect(res.client).toBeUndefined(); // same physical chat -> dropped
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toBe('MAINT');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('sensitive maintainer send writes no channel-log row', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'SENSITIVE', fallback: 'client', sensitive: true } }));
      expect(res.maintainer).toMatchObject({ ok: true, route: 'maintainer_channel' });
      expect(stub.requests.length).toBe(1);
      expect(dbExists(hermit(wd.dir))).toBe(false); // no episodic-log row
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('maintainer send failure does not record platform health', async () => {
    const stub = startHttpStub();
    stub.setStatus(500);
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'MAINT', fallback: 'findings' } }));
      // recordChannelHealth is skipped for the maintainer leg, so a failure there
      // must not create/poison the platform-keyed health file.
      expect(fs.existsSync(channelHealthPath(hermit(wd.dir)))).toBe(false);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});
