// Behavioral tests for scripts/lib/prompt-stages/channel-reply-reminder.ts —
// the stage that reminds the model which reply tool to use, and captures
// inbound messages into the episodic channel log. Driven through the single
// UserPromptSubmit process, scripts/user-prompt-pipeline.ts, as a subprocess
// (stdin in, stdout out) — the boundary Claude Code sees. Mirrors
// tests/pause-keyword.test.ts.
//
// tests/channel-responder-reply-rule.test.ts is a separate, static wiring
// check (skill text / hooks.json / script presence) — it does not run this
// script, so this file is the only behavioral coverage for it.
//
// Usage: bun test tests/channel-reply-reminder.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { unconsolidated } from '../scripts/lib/channel-log';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function withDir(fn: (dir: string) => Promise<void> | void, config?: string) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), config ?? '{"channels":{"discord":{"allowed_users":["U1"]}}}');
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const ID_ALLOWLIST = '{"channels":{"discord":{"allowed_users":["123456789012345678"]}}}';

const run = (prompt: string, dir: string, env?: Record<string, string>) =>
  runScript('user-prompt-pipeline.ts', { stdin: JSON.stringify({ prompt }), cwd: dir, env });

describe('channel-reply-reminder', () => {
  const SELF_ID = '987654321098765432';
  const withBotId = (extra = '') =>
    `{"channels":{"discord":{"allowed_users":["U1"],"bot_user_id":"${SELF_ID}"${extra}}}}`;

  test('self-mention — names the bot id as the agent itself', withDir(async (dir) => {
    const r = await run(`<channel source="discord" chat_id="1" user="U1"><@${SELF_ID}> ping</channel>`, dir);
    expect(r.stdout).toContain(SELF_ID);
    expect(r.stdout).toContain('your own account on this channel');
  }, withBotId()));

  test('id embedded in a longer number — not a self-mention', withDir(async (dir) => {
    const r = await run(`<channel source="discord" chat_id="1" user="U1">order 5${SELF_ID}7 shipped</channel>`, dir);
    expect(r.stdout).not.toContain('your own account on this channel');
  }, withBotId()));

  test('configured but not mentioned — reminder is unchanged', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">plain message</channel>', dir);
    expect(r.stdout).not.toContain('your own account on this channel');
    expect(r.stdout).toContain('[channel reply reminder]');
  }, withBotId()));

  test('bot_username — an @handle mention matches case-insensitively (telegram shape)', withDir(async (dir) => {
    const r = await run('<channel source="telegram" chat_id="1" user="U1">hey @HermitBot status?</channel>', dir);
    expect(r.stdout).toContain('@hermitbot');
    expect(r.stdout).toContain('your own account on this channel');
  }, '{"channels":{"telegram":{"allowed_users":["U1"],"bot_username":"hermitbot"}}}'));

  test('no bot identity configured — reminder is unchanged', withDir(async (dir) => {
    const r = await run(`<channel source="discord" chat_id="1" user="U1"><@${SELF_ID}> ping</channel>`, dir);
    expect(r.stdout).not.toContain('your own account on this channel');
  }));

  test('bare source — names the exact reply tool', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">hi</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply');
    expect(r.stdout).toContain('`discord` channel');
  }));

  // #634 regression: the harness injects a plugin-qualified source
  // (`plugin:discord:discord`); REPLY_TOOLS must be looked up by the
  // normalized bare key, not the raw qualified one.
  test('plugin-qualified source — still names the exact reply tool', withDir(async (dir) => {
    const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="U1">hi</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply');
    expect(r.stdout).toContain('`discord` channel');
  }));

  test('unrecognized custom channel plugin — generic fallback phrase, no crash', withDir(async (dir) => {
    const r = await run('<channel source="plugin:acme-crm:crm" chat_id="1" user="U1">hi</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("the channel's `reply` tool");
    expect(r.stdout).toContain('`crm` channel');
  }));

  test('plugin-qualified source — episodic capture logs the bare channel key', withDir(async (dir) => {
    const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="U1">hello there</channel>', dir);
    expect(r.exitCode).toBe(0);
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('discord');
    expect(rows[0].text).toBe('hello there');
  }));

  test('plugin-qualified source, sender not on the allowlist — reminder still fires, capture is skipped', withDir(async (dir) => {
    const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="STRANGER">hello there</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply'); // reminder is not gated by allowlist
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(0); // capture is gated by isAllowedSender
  }));

  // Discord puts the display name in `user` and the numeric id in `user_id`.
  // allowed_users holds ids (what every doc instructs), so matching `user`
  // rejected the operator on every inbound message and nothing was ever logged.
  test('id-based allowlist, real wire shape — captured, sender keeps the display name', withDir(async (dir) => {
    const r = await run(
      '<channel source="plugin:discord:discord" chat_id="1" user="display-name" user_id="123456789012345678">hello there</channel>',
      dir,
    );
    expect(r.exitCode).toBe(0);
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe('hello there');
    expect(rows[0].sender).toBe('display-name');
  }, ID_ALLOWLIST));

  test('display name mimicking an allowlisted id — not captured', withDir(async (dir) => {
    const r = await run(
      '<channel source="plugin:discord:discord" chat_id="1" user="123456789012345678" user_id="EVIL">hello there</channel>',
      dir,
    );
    expect(r.exitCode).toBe(0);
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(0);
  }, ID_ALLOWLIST));
});

describe('passive capture', () => {
  const config = (source = 'discord', extra: Record<string, unknown> = {}, logging = true) => JSON.stringify({
    channels: { [source]: { passive_chats: ['1'], allowed_users: ['U1'], bot_user_id: '123', bot_username: 'handle', ...extra } },
    knowledge: { channel_log_enabled: logging },
  });
  const prompt = (body: string, user = 'U1', source = 'discord', chat = '1') =>
    `<channel source="${source}" chat_id="${chat}" user="${user}">${body}</channel>`;
  const blocked = (stdout: string) => expect(JSON.parse(stdout)).toEqual({
    decision: 'block', reason: 'passive chat: recorded, not addressed',
  });

  for (const [user, body, block] of [
    ['STRANGER', 'plain', true], ['U1', '<@123> hello', false], ['STRANGER', '<@123> hello', true],
  ] as const) {
    test(`capture ${user} ${body}`, withDir(async dir => {
      const r = await run(prompt(body, user), dir);
      expect(r.exitCode).toBe(0);
      expect(unconsolidated(hermit(dir)).rows.map(row => row.text)).toEqual([body]);
      if (block) blocked(r.stdout);
      else { expect(r.stdout).toContain('[channel reply reminder]'); expect(r.stdout).not.toContain('"decision":"block"'); }
    }, config()));
  }

  test('absent allowlist still blocks unaddressed chatter', withDir(async dir => {
    blocked((await run(prompt('plain'), dir)).stdout);
  }, config('discord', { allowed_users: undefined })));

  test('guild role membership is fetched, then reused for role mentions', withDir(async dir => {
    const stateDir = path.join(dir, 'discord');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, '.env'), 'DISCORD_BOT_TOKEN=test-token');
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch(req) {
      const route = new URL(req.url).pathname;
      requests.push(route);
      return Response.json(route.includes('/guilds/') ? { roles: ['456'] } : { parent_id: null, guild_id: 'guild', type: 0 });
    } });
    const env = { DISCORD_STATE_DIR: stateDir, HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, '') };
    try {
      const first = await run(prompt('<@&456> hello'), dir, env);
      expect(first.stdout).toContain('[channel reply reminder]');
      blocked((await run(prompt('<@&789> hello'), dir, env)).stdout);
      expect(requests).toEqual(['/channels/1', '/guilds/guild/members/@me']);
      expect(unconsolidated(hermit(dir)).rows.length).toBe(2);
    } finally { server.stop(true); }
  }, config()));

  // The reply stage warms the metadata cache that record-operator-action's
  // cache-only gate reads, so it must run first: auditing first misread the very
  // first message of an unseen thread or guild in both directions.
  for (const [name, extra, chat, body, block] of [
    ['unseen thread chatter does not freeze the clock', { allowed_users: undefined }, 'thread', 'idle chatter', true],
    ['a first role mention still advances the clock', {}, '1', '<@&456> hello', false],
  ] as const) {
    test(name, withDir(async dir => {
      const stateDir = path.join(dir, 'discord');
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(stateDir, '.env'), 'DISCORD_BOT_TOKEN=test-token');
      const server = Bun.serve({ port: 0, fetch(req) {
        const route = new URL(req.url).pathname;
        return Response.json(route.includes('/guilds/')
          ? { roles: ['456'] }
          : { parent_id: '1', guild_id: 'guild', type: 11 });
      } });
      try {
        const env = { DISCORD_STATE_DIR: stateDir, HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, '') };
        const r = await run(prompt(body, 'U1', 'discord', chat), dir, env);
        if (block) blocked(r.stdout);
        else expect(r.stdout).toContain('[channel reply reminder]');
        expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(!block);
      } finally { server.stop(true); }
    }, config('discord', extra)));
  }

  test('Telegram handles require a complete token', withDir(async dir => {
    expect((await run(prompt('@handle hello', 'U1', 'telegram'), dir)).stdout).toContain('[channel reply reminder]');
    blocked((await run(prompt('@handlex hello', 'U1', 'telegram'), dir)).stdout);
  }, config('telegram')));

  test('unlisted non-allowed chat keeps its reminder and skips capture', withDir(async dir => {
    const r = await run(prompt('plain', 'STRANGER', 'telegram', 'other'), dir);
    expect(r.stdout).toContain('[channel reply reminder]');
    expect(unconsolidated(hermit(dir)).rows.length).toBe(0);
  }, config('telegram')));

  test('disabled logging still blocks without creating a database', withDir(async dir => {
    blocked((await run(prompt('plain'), dir)).stdout);
    expect(fs.existsSync(hermit(dir, 'state', 'channel-log.sqlite'))).toBe(false);
  }, config('discord', {}, false)));

  for (const scenario of ['thread', 'forbidden', 'empty'] as const) {
    test(`Discord lookup: ${scenario}`, withDir(async dir => {
      const stateDir = path.join(dir, 'discord');
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(stateDir, '.env'), 'DISCORD_BOT_TOKEN=test-token');
      let requests = 0;
      const server = Bun.serve({ port: 0, fetch(req) {
        requests++;
        expect(new URL(req.url).pathname).toBe('/channels/thread');
        return scenario === 'forbidden' ? new Response('', { status: 403 })
          : Response.json({ parent_id: '1', guild_id: 'guild', type: 11 });
      } });
      try {
        const env = { DISCORD_STATE_DIR: stateDir, HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, '') };
        for (const body of ['first message', 'second message']) {
          const r = await run(prompt(body, 'U1', 'discord', 'thread'), dir, env);
          expect(r.exitCode).toBe(0);
          if (scenario === 'thread') blocked(r.stdout);
          else expect(r.stdout).toContain('[channel reply reminder]');
        }
        expect(requests).toBe(scenario === 'empty' ? 0 : 1);
        expect(fs.existsSync(hermit(dir, 'state', 'channel-chats.json'))).toBe(scenario !== 'empty');
      } finally { server.stop(true); }
    }, config('discord', scenario === 'empty' ? { passive_chats: [] } : {})));
  }
});
