// Contract tests for scripts/channel-status-responder.ts — the deterministic
// send-then-block status responder. Exercised as a subprocess against a local
// HTTP stub (HERMIT_TELEGRAM_API_URL override) standing in for the platform.
//
// Covers the probe-verified constraints this hook rests on: exact-match gate
// (near-misses fall through), allowed_users enforcement, and send-then-block
// (only emit {"decision":"block"} after a confirmed send; a failed send must
// never leave both a blocked prompt and a silent operator).

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { startHttpStub } from './helpers/http-stub';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function envelope(body: string, user = 'u1', chatId = '12345'): string {
  return `<channel source="telegram" chat_id="${chatId}" user="${user}">${body}</channel>`;
}

function payload(body: string, user = 'u1'): string {
  return JSON.stringify({ prompt: envelope(body, user) });
}

function setupChannelWorkdir(configExtra: object = {}): Workdir {
  const wd = setupWorkdir();
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  write(hermit(wd.dir, 'config.json'), JSON.stringify({
    timezone: 'UTC',
    channels: { telegram: { enabled: true, dm_channel_id: '12345', allowed_users: ['u1'], state_dir: '.claude.local/channels/telegram' } },
    ...configExtra,
  }));
  return wd;
}

async function run(wd: Workdir, body: string, stubUrl: string, user = 'u1') {
  return runScript('channel-status-responder.ts', {
    stdin: payload(body, user),
    cwd: wd.dir,
    env: { HERMIT_TELEGRAM_API_URL: stubUrl },
  });
}

describe('channel-status-responder', () => {
  test('exact "status" + allowed sender -> send-then-block', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      fs.writeFileSync(hermit(wd.dir, 'sessions', '.status.json'), JSON.stringify({ status: 'in_progress', task: 'writing the plan' }));
      const r = await run(wd, 'status', stub.url);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.text).toContain('writing the plan');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('routes the reply to the chat it was asked on (group id), not dm_channel_id', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      // Asked in a Telegram group: chat_id is the group id, distinct from dm_channel_id (12345).
      const groupPayload = JSON.stringify({ prompt: envelope('status', 'u1', '-1001234567890') });
      const r = await runScript('channel-status-responder.ts', {
        stdin: groupPayload,
        cwd: wd.dir,
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('-1001234567890');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('case-insensitive and surrounding whitespace still match exactly', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(wd, '  STATUS  ', stub.url);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('near-miss body falls through to the model (no block, no send)', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(wd, 'what is the status of the task you are working on?', stub.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('unauthorized sender -> no block, no send', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(wd, 'status', stub.url, 'not-allowed');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // #10b: a failed deterministic send no longer falls through to a blind model turn —
  // it injects the composed status via stdout (probe-verified to reach the model) for
  // the model to relay verbatim, and does NOT block.
  test('failed send -> injects composed status for the model to relay (not a blind fallthrough)', async () => {
    const wd = setupChannelWorkdir();
    try {
      const r = await run(wd, 'status', 'http://127.0.0.1:1'); // dead listener -> send fails
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('"decision":"block"'); // not blocked — model turn proceeds
      expect(r.stdout).toContain('[status]');               // relay instruction emitted
      expect(r.stdout).toContain('reply tool');             // tells the model to relay
      expect(r.stdout).toContain('All quiet');              // carries the composed status text
    } finally {
      wd.cleanup();
    }
  });

  test('non-channel prompt -> no-op', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('channel-status-responder.ts', {
        stdin: JSON.stringify({ prompt: 'status' }),
        cwd: wd.dir,
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('empty stdin -> fail open, exit 0', async () => {
    const r = await runScript('channel-status-responder.ts', { stdin: '' });
    expect(r.exitCode).toBe(0);
  });

  test('reply never leaks internal vocabulary (PROP/S-NNN)', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      fs.writeFileSync(hermit(wd.dir, 'sessions', '.status.json'), JSON.stringify({ status: 'in_progress', task: 'PROP-020 implementation' }));
      await run(wd, 'status', stub.url);
      const sent = stub.requests[0].body.text as string;
      expect(sent).not.toMatch(/S-\d{3}/);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('paused session -> reply mentions the pause without reading .status.json', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      fs.mkdirSync(hermit(wd.dir, 'state'), { recursive: true });
      write(hermit(wd.dir, 'state', 'pause.json'), JSON.stringify({
        paused: true, paused_until: null, reason: 'operator', by: 'test', ts: new Date().toISOString(),
      }));
      const r = await run(wd, 'status', stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests[0].body.text).toContain('Paused');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('pending micro-proposal -> reply names the reply hint', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      write(hermit(wd.dir, 'state', 'micro-proposals.json'), JSON.stringify({
        pending: [{ id: 'MP-20260705-0', status: 'pending', tier: 1, question: 'ok?' }],
      }));
      await run(wd, 'status', stub.url);
      expect(stub.requests[0].body.text).toContain('MP-20260705-0');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('over-budget -> reply names the cap', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ budget: { daily_usd: 5, weekly_usd: null, monthly_usd: null, action: 'alert' } });
    try {
      await run(wd, 'status', stub.url);
      expect(stub.requests[0].body.text).toContain('$5.00 cap');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('empty/fresh state -> "all quiet" fallback', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      await run(wd, 'status', stub.url);
      expect(stub.requests[0].body.text).toContain('All quiet');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // #10a: an accepted-but-untrusted sender (no allowlist configured, message from a
  // chat that isn't the operator DM) gets a coarse reply — never spend, task, or IDs.
  test('untrusted sender (no allowlist, non-DM chat) -> redacted coarse status', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({
      channels: { telegram: { enabled: true, dm_channel_id: '12345', state_dir: '.claude.local/channels/telegram' } },
      budget: { daily_usd: 5, weekly_usd: null, monthly_usd: null, action: 'alert' },
    });
    try {
      fs.mkdirSync(hermit(wd.dir, 'sessions'), { recursive: true });
      fs.mkdirSync(hermit(wd.dir, 'state'), { recursive: true });
      write(hermit(wd.dir, 'sessions', '.status.json'), JSON.stringify({ task: 'secret-migration', status: 'in_progress' }));
      write(hermit(wd.dir, 'state', 'micro-proposals.json'), JSON.stringify({ pending: [{ id: 'MP-20260705-0', status: 'pending', tier: 1, question: 'ok?' }] }));

      const stranger = JSON.stringify({ prompt: '<channel source="telegram" chat_id="999" user="stranger">status</channel>' });
      const r = await runScript('channel-status-responder.ts', { stdin: stranger, cwd: wd.dir, env: { HERMIT_TELEGRAM_API_URL: stub.url } });
      expect(r.exitCode).toBe(0);
      const text = stub.requests[0].body.text;
      expect(text).not.toContain('secret-migration'); // task text withheld
      expect(text).not.toContain('$5.00');             // budget figure withheld
      expect(text).not.toContain('MP-20260705-0');     // approval id withheld
      expect(text).toContain('Working');               // coarse state only
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});
