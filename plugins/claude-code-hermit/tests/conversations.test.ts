import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { logMessage } from '../scripts/lib/channel-log';
import { bind, list, lookup, prune, unbind, update } from '../scripts/lib/conversations';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('conversations-');
afterAll(cleanup);
const key = 'discord:123';
const input = { session_name: 'conv-discord-123', session_id: 'stable-session', worktree: '/tmp/task-worktree' };

test('binding lifecycle and generation', () => {
  const dir = freshDir();
  expect(lookup(dir, key)).toBeNull();
  bind(dir, key, input);
  expect(lookup(dir, key)).toMatchObject({ ...input, generation: 1, card: null, muted: false, status: 'running' });
  expect(lookup(dir, key)).not.toHaveProperty('bg_id');
  for (const status of ['running', 'idle', 'parked', 'unknown'] as const) {
    update(dir, key, { status });
    expect(lookup(dir, key)?.status).toBe(status);
  }
  update(dir, key, { generation: '+1', muted: true, card: { chat_id: '123', message_id: '456' } });
  expect(lookup(dir, key)).toMatchObject({ generation: 2, muted: true, card: { chat_id: '123', message_id: '456' } });
  expect(Object.keys(list(dir))).toEqual([key]);
  unbind(dir, key);
  expect(lookup(dir, key)).toBeNull();
});

test('prune preserves empty or unparsable input and matches stable session ids only', () => {
  const dir = freshDir();
  bind(dir, key, input);
  for (const text of ['', 'broken', '[]']) {
    prune(dir, text);
    expect(lookup(dir, key)?.status).toBe('running');
  }
  prune(dir, JSON.stringify([{ id: 'new-bg-id', sessionId: input.session_id }]));
  expect(lookup(dir, key)?.status).toBe('running');
  prune(dir, JSON.stringify([{ id: input.session_id, sessionId: 'different' }]));
  expect(lookup(dir, key)?.status).toBe('unknown');
  update(dir, key, { status: 'idle' });
  prune(dir, '[{"sessionId":"other"}]');
  expect(lookup(dir, key)?.status).toBe('unknown');
  update(dir, key, { status: 'parked' });
  prune(dir, '[{"sessionId":"other"}]');
  expect(lookup(dir, key)?.status).toBe('parked');
});

// AGENT_DIR is applied last so an ambient one from the shell running the suite can
// never outrank the fixture dir and trip the state-dir pin; a caller that wants a
// mismatch sets AGENT_DIR in `env` explicitly.
async function cli(dir: string, args: string[], env?: typeof process.env) {
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../scripts/conversation.ts'), dir, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env, AGENT_DIR: env?.AGENT_DIR ?? dir } });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, code };
}

test('CLI output and two concurrent updates both land', async () => {
  const dir = freshDir();
  expect(await cli(dir, ['bind', key, '--session-name', input.session_name, '--session-id', input.session_id, '--worktree', input.worktree])).toEqual({ stdout: `OK|${key}\n`, code: 0 });
  const results = await Promise.all([
    cli(dir, ['update', key, '--generation', '+1', '--muted', 'true']),
    cli(dir, ['update', key, '--generation', '+1', '--status', 'idle']),
  ]);
  expect(results.every(r => r.code === 0)).toBe(true);
  expect(JSON.parse((await cli(dir, ['lookup', key])).stdout)).toMatchObject({ generation: 3, muted: true, status: 'idle' });
  expect(await cli(dir, ['lookup', 'discord:missing'])).toEqual({ stdout: 'ERROR|not-found\n', code: 1 });
  expect(await cli(dir, ['update', key, '--status', 'invalid'])).toEqual({ stdout: 'ERROR|invalid-status\n', code: 1 });
  expect(fs.existsSync(path.join(dir, 'state', 'conversations.json.lock'))).toBe(false);
});

test('CLI session id refresh preserves generation, muted flag and card', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  const card = { chat_id: '123', message_id: '456' };
  update(dir, key, { generation: '+1', muted: true, card });
  expect(await cli(dir, ['update', key, '--session-id', 'resumed-session'])).toEqual({ stdout: `OK|${key}\n`, code: 0 });
  expect(lookup(dir, key)).toMatchObject({ session_id: 'resumed-session', generation: 2, muted: true, card });
});

test('keyless verbs wrap the channel library calls', async () => {
  const dir = freshDir();
  const tokenDir = path.join(dir, 'discord');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    channels: { discord: { state_dir: tokenDir, allowed_users: ['u1'] } },
  }));
  for (const [i, text] of ['first', 'second', 'third'].entries()) {
    logMessage(dir, { source: 'discord', chat_id: '123', direction: i % 2 ? 'out' : 'in', sender: 'u1', text, ts: `2026-01-01T00:00:0${i}Z` });
  }
  const server = Bun.serve({ port: 0, fetch(req) {
    const route = new URL(req.url).pathname;
    if (route === '/channels/123') return Response.json({ parent_id: null, guild_id: '2', type: 0 });
    if (route === '/channels/456') return Response.json({ parent_id: '123', guild_id: '2', type: 11 });
    if (route === '/channels/123/messages/9/threads' && req.method === 'POST') return Response.json({ id: '789' });
    return new Response('', { status: 404 });
  } });
  const env = { HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, ''), DISCORD_STATE_DIR: tokenDir };
  const run = (...args: string[]) => cli(dir, args, env);
  try {
    const history = await run('history', '--source', 'discord', '--chat-id', '123', '--limit', '2');
    expect(history.code).toBe(0);
    expect(JSON.parse(history.stdout).map((r: { text: string }) => r.text)).toEqual(['second', 'third']);
    expect(JSON.parse((await run('history', '--source', 'discord', '--chat-id', '999')).stdout)).toEqual([]);
    expect(await run('history', '--source', 'discord')).toEqual({ stdout: 'ERROR|missing-chat-id\n', code: 1 });
    expect(await run('history', '--source', 'discord', '--chat-id', '123', '--limit', '0')).toEqual({ stdout: 'ERROR|invalid-limit\n', code: 1 });
    expect(JSON.parse((await run('chat-lookup', '--chat-id', '123')).stdout)).toMatchObject({ guild_id: '2', type: 0, thread: false });
    expect(JSON.parse((await run('chat-lookup', '--chat-id', '456')).stdout)).toMatchObject({ parent_id: '123', type: 11, thread: true });
    expect(await run('chat-lookup', '--chat-id', '404')).toEqual({ stdout: 'ERROR|not-found\n', code: 1 });
    expect(await run('thread-create', '--chat-id', '123', '--message-id', '9', '--name', 'Task title')).toEqual({ stdout: 'OK|789\n', code: 0 });
    expect(await run('thread-create', '--chat-id', '123', '--message-id', '8', '--name', 'Task title')).toEqual({ stdout: 'ERROR|thread-failed\n', code: 1 });
    expect(await run('is-trusted', '--source', 'discord', '--user-id', 'u1', '--chat-id', '123')).toEqual({ stdout: 'OK|trusted\n', code: 0 });
    expect(await run('is-trusted', '--source', 'discord', '--user-id', 'u2', '--chat-id', '123')).toEqual({ stdout: 'ERROR|untrusted\n', code: 1 });
    expect(await run('is-trusted', '--source', 'discord', '--user-id', 'u1', '--chat-id', '123', '--name', 'x')).toEqual({ stdout: 'ERROR|invalid-options\n', code: 1 });
  } finally {
    server.stop(true);
  }
});

test("state dir must be this project's before reads or Discord requests", async () => {
  const ownDir = freshDir();
  const foreignDir = freshDir();
  expect(foreignDir).not.toBe(ownDir);
  const tokenDir = path.join(foreignDir, 'discord');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
  // config.json plus state/ is a real foreign hermit root. Without state/ it reads
  // as a worktree projection, and the refusal would come from the walk-up rather
  // than the equality check this pins.
  fs.mkdirSync(path.join(foreignDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(foreignDir, 'config.json'), JSON.stringify({
    channels: { discord: { state_dir: tokenDir } },
  }));
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() {
    requests += 1;
    return Response.json({ id: '789' });
  } });
  const env = { AGENT_DIR: ownDir, HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, ''), DISCORD_STATE_DIR: tokenDir };
  try {
    expect(await cli(foreignDir, ['list'], env)).toEqual({ stdout: '', code: 1 });
    expect(await cli(foreignDir, ['thread-create', '--chat-id', '123', '--message-id', '9', '--name', 'x'], env)).toEqual({ stdout: '', code: 1 });
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
  }
});

// The production shape every skill uses: the literal `.claude-code-hermit` resolved
// against the project root, with no AGENT_DIR. The pin must not reject it.
test('the literal .claude-code-hermit from the project root passes the pin', async () => {
  const root = freshDir();
  const hermit = path.join(root, '.claude-code-hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  fs.writeFileSync(path.join(hermit, 'config.json'), '{}');
  const env = { ...process.env };
  delete env.AGENT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../scripts/conversation.ts'), '.claude-code-hermit', 'list'], { cwd: root, stdout: 'pipe', stderr: 'pipe', env });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect({ stdout, code }).toEqual({ stdout: '{}\n', code: 0 });
});
