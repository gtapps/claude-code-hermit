// Contract tests for scripts/channel-send.ts + scripts/lib/channel-send.ts —
// the first script-owned (non-model) channel send. Exercised as a subprocess
// (the CLI wrapper) against a local HTTP stub standing in for the platform API
// (HERMIT_TELEGRAM_API_URL override), so no real bot token or network access
// is needed.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, runPinnedScript, type RunOptions } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { startHttpStub } from './helpers/http-stub';
import { unconsolidated, dbExists } from '../scripts/lib/channel-log';
import { sendOperatorNotice } from '../scripts/lib/channel-send';
import { channelHealthPath } from '../scripts/lib/channel-health';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

// channel-send.ts pins its state dir to hermitDir(), so these tests need the
// sanctioned absolute-AGENT_DIR override that runPinnedScript already owns for
// this class of script. A call with no argv (the usage-error case) skips the pin
// — its arity check fires first. Tests that pass a deliberately foreign state
// dir call runScript directly, per that helper's own note.
function runChannelSend(opts: RunOptions = {}) {
  const { args = [], ...rest } = opts;
  // The state dir is the first POSITIONAL, not args[0]: parseArgs pulls
  // --tier/--notice out from anywhere in argv, so a flag-first call is legal and
  // would otherwise pin AGENT_DIR to "--tier" and fail with a confusing exit 2.
  const stateDir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--tier');
  return stateDir
    ? runPinnedScript('channel-send.ts', stateDir, args, rest)
    : runScript('channel-send.ts', opts);
}

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
      const r = await runChannelSend({
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
      const r = await runChannelSend({
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
      const r = await runChannelSend({
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
      const r = await runChannelSend({
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
      const r = await runChannelSend({
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
      const r = await runChannelSend({
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
      const r = await runChannelSend({ args: [hermit(wd.dir), 'hello'] });
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
      const r = await runChannelSend({ args: [hermit(wd.dir), 'hello'] });
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
      const r = await runChannelSend({ args: [hermit(wd.dir), 'hello'] });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('config_read_failed');
    } finally {
      wd.cleanup();
    }
  });

  test('missing arguments -> usage error, exit non-zero', async () => {
    const r = await runChannelSend({ args: [] });
    expect(r.exitCode).not.toBe(0);
  });

  // The state-dir pin. `Bash(bun */scripts/channel-send.ts*)` pre-approves every
  // argument, so an unvalidated root let one allowed call send with *another*
  // project's bot token to *that* project's chat. Both modes pin separately —
  // covering each keeps a later edit from dropping one silently. Exit 2, not 1:
  // this is "the caller got it wrong, nothing was sent", not a failed delivery.
  for (const [mode, tail] of [['--tier', ['hello']], ['--notice', ['--notice']]] as const) {
    test(`a foreign state dir is refused in ${mode} mode before anything is sent`, async () => {
      const stub = startHttpStub();
      const mine = setupChannelWorkdir();
      const theirs = setupChannelWorkdir();
      try {
        // runScript, not runChannelSend: the whole point is an argv state dir
        // that AGENT_DIR does not match, which the pinned wrapper would paper over.
        const r = await runScript('channel-send.ts', {
          args: [hermit(theirs.dir), ...tail],
          stdin: '{"client":"x"}',
          env: { AGENT_DIR: hermit(mine.dir), HERMIT_TELEGRAM_API_URL: stub.url },
        });
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain("state dir must be this project's");
        expect(r.stdout.trim()).toBe('');
        expect(stub.requests.length).toBe(0);
      } finally {
        stub.stop();
        mine.cleanup();
        theirs.cleanup();
      }
    });
  }

  // The production shape every caller actually uses — the watchdog passes a
  // relative '.claude-code-hermit' resolved against its own cwd, and the skills
  // pass the same literal from the project root. The pin must not reject it.
  test('the literal .claude-code-hermit from the project root passes the pin', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: ['.claude-code-hermit', 'hello'],
        cwd: wd.dir,
        env: { AGENT_DIR: hermit(wd.dir), HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(1);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('--tier maintainer routes to maintainer_channel_id when configured', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runChannelSend({
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
      const r = await runChannelSend({
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
      const r = await runChannelSend({
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

  test('fallback:primary + maintainer target hit: same token, route maintainer_channel', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'MAINT', fallback: 'primary' } }));
      expect(res.maintainer).toMatchObject({ ok: true, route: 'maintainer_channel' });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests[0].path).toContain('bottest-token'); // same bot token as the client route
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('fallback:primary + non-technical + no maintainer channel -> primary chat', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'DOCTOR ALERT', fallback: 'primary' } }));
      expect(res.maintainer).toMatchObject({ ok: true, route: 'client', delivered: true });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toBe('DOCTOR ALERT');
      expect(findings(wd)).not.toContain('DOCTOR ALERT');
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

  test('fallback:primary + failed maintainer send -> Findings, never the client chat', async () => {
    const stub = startHttpStub();
    stub.setStatus(500);
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'USD DETAIL', fallback: 'primary' } }));
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

  // Load-bearing for maintainer-tier notices: on an install with no maintainer
  // chat, a `--notice` maintainer payload falls back to the pinned home. This
  // routing is what puts the notice in that same chat.
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

// channel-send.ts --notice — the model-facing proactive-notify CLI boundary.
// Drives the subprocess (not sendOperatorNotice in-process) so these tests also
// cover payload parsing/validation and the normalized
// {delivered,degraded,no_channel,result} stdout contract, not just the routing sendOperatorNotice
// already owns (covered above).
describe('channel-send CLI --notice', () => {
  const findings = (wd: Workdir) => fs.readFileSync(hermit(wd.dir, 'sessions', 'SHELL.md'), 'utf8');
  const runNotice = (wd: Workdir, payload: object | string, stub: { url: string }) =>
    runChannelSend({
      args: [hermit(wd.dir), '--notice'],
      stdin: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: { HERMIT_TELEGRAM_API_URL: stub.url },
    });

  test('client only -> client chat receives it, exit 0, delivered:true', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, { client: 'plain notice' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.delivered).toBe(true);
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toBe('plain notice');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('maintainer only, maintainer_channel_id set -> maintainer chat receives it, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runNotice(wd, { maintainer: 'ops detail' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.delivered).toBe(true);
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('maintainer only, no maintainer chat, technical profile -> falls back to primary chat, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, { maintainer: 'ops detail' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.delivered).toBe(true);
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('both legs, different chats -> both received, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runNotice(wd, { client: 'PLAIN', maintainer: 'FULL DETAIL' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.delivered).toBe(true);
      expect(stub.requests.length).toBe(2);
      const byChat = Object.fromEntries(stub.requests.map((req) => [req.body.chat_id, req.body.text]));
      expect(byChat['12345']).toBe('PLAIN');
      expect(byChat['99999']).toBe('FULL DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('both legs, same chat -> one message (maintainer text wins via dedup), exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '12345' });
    try {
      const r = await runNotice(wd, { client: 'PLAIN', maintainer: 'FULL DETAIL' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.delivered).toBe(true);
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.text).toBe('FULL DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('non-technical, no maintainer chat -> maintainer text suppressed to Findings, delivered:true, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    try {
      const r = await runNotice(wd, { maintainer: 'SECRET DETAIL' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.delivered).toBe(true);
      expect(stub.requests.length).toBe(0);
      expect(findings(wd)).toContain('SECRET DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('fallback:primary, non-technical, no maintainer chat -> primary chat, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    try {
      const r = await runNotice(wd, { maintainer: 'DOCTOR ALERT', fallback: 'primary' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.delivered).toBe(true);
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toBe('DOCTOR ALERT');
      expect(findings(wd)).not.toContain('DOCTOR ALERT');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('configured maintainer unreachable -> degraded:true, Findings written', async () => {
    const stub = startHttpStub();
    stub.setStatus(500);
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runNotice(wd, { maintainer: 'USD DETAIL' }, stub);
      const out = JSON.parse(r.stdout);
      expect(out.degraded).toBe(true);
      expect(out.delivered).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(findings(wd)).toContain('USD DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('partial delivery (maintainer suppressed, client unreachable) -> exit 1, not success', async () => {
    const wd = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), JSON.stringify({
      operator_profile: 'non-technical',
      channels: { telegram: { enabled: true } }, // enabled but unpaired: no dm_channel_id
    }));
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--notice'],
        stdin: JSON.stringify({ client: 'PLAIN', maintainer: 'DETAIL' }),
      });
      const out = JSON.parse(r.stdout);
      // The maintainer leg landed in its intended Findings home, but the client
      // leg reached nobody — reporting delivered here would drop it silently.
      expect(out.delivered).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(findings(wd)).toContain('DETAIL');
    } finally {
      wd.cleanup();
    }
  });

  test('no channel at all -> no_channel:true, exit 1', async () => {
    const wd = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), JSON.stringify({ channels: {} }));
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--notice'],
        stdin: JSON.stringify({ client: 'hello' }),
      });
      expect(r.exitCode).not.toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.no_channel).toBe(true);
      expect(out.delivered).toBe(false);
    } finally {
      wd.cleanup();
    }
  });

  test('sensitive:true on the maintainer leg writes no channel-log row', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runNotice(wd, { maintainer: 'SENSITIVE', sensitive: true }, stub);
      expect(r.exitCode).toBe(0);
      expect(dbExists(hermit(wd.dir))).toBe(false);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('malformed JSON on stdin -> exit 1, stderr message, no stdout JSON', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, 'not json', stub);
      expect(r.exitCode).toBe(2); // usage error, not a delivery failure
      expect(r.stderr).toContain('invalid JSON');
      expect(r.stdout.trim()).toBe('');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('unknown field -> exit 1 usage error', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, { maintainr: 'x' }, stub);
      expect(r.exitCode).toBe(2); // usage error, not a delivery failure
      expect(r.stderr).toContain('unknown field');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('empty audience ({}) -> exit 1 usage error', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, {}, stub);
      expect(r.exitCode).toBe(2); // usage error, not a delivery failure
      expect(r.stderr).toContain('at least one of client/maintainer is required');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('bad fallback value -> exit 1 usage error', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, { maintainer: 'x', fallback: 'nope' }, stub);
      expect(r.exitCode).toBe(2); // usage error, not a delivery failure
      expect(r.stderr).toContain('invalid fallback');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('--notice and --tier together -> exit 1 usage error', async () => {
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--notice', '--tier', 'client'],
        stdin: JSON.stringify({ client: 'x' }),
      });
      expect(r.exitCode).toBe(2); // usage error, not a delivery failure
      expect(r.stderr).toContain('mutually exclusive');
    } finally {
      wd.cleanup();
    }
  });
});
