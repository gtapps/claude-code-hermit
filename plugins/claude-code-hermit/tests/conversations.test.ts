import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { logMessage } from '../scripts/lib/channel-log';
import { awaitAgent, bind, harness, helperStatus, list, lookup, prune, unbind, update, type HarnessSpawn } from '../scripts/lib/conversations';
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

test('per-helper launch overrides persist across an unrelated update and clear on +1', () => {
  const dir = freshDir();
  bind(dir, key, input);
  update(dir, key, { model: 'sonnet', effort: 'high', permission_mode: 'acceptEdits', advisor: 'opus' });
  expect(lookup(dir, key)).toMatchObject({ model: 'sonnet', effort: 'high', permission_mode: 'acceptEdits', advisor: 'opus' });
  update(dir, key, { status: 'idle' });
  expect(lookup(dir, key)).toMatchObject({ model: 'sonnet', effort: 'high', permission_mode: 'acceptEdits', advisor: 'opus', status: 'idle' });
  update(dir, key, { generation: '+1' });
  const record = lookup(dir, key);
  expect(record).not.toHaveProperty('model');
  expect(record).not.toHaveProperty('effort');
  expect(record).not.toHaveProperty('permission_mode');
  expect(record).not.toHaveProperty('advisor');
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

test('awaitAgent returns the listing once it appears and treats unparsable output as unlisted', async () => {
  let n = 0;
  const found = await awaitAgent('abcd1234', {
    timeoutMs: 3000,
    readRegistry: () => {
      n += 1;
      return n === 1 ? [] : [{ id: 'abcd1234', sessionId: 'abcd1234-sess', cwd: '/w' }];
    },
  });
  expect(found).toEqual({ sessionId: 'abcd1234-sess', cwd: '/w' });
  expect(n).toBe(2);
  expect(await awaitAgent('abcd1234', { timeoutMs: 300, readRegistry: () => [] })).toBeNull();
  expect(await awaitAgent('abcd1234', { timeoutMs: 300, readRegistry: () => 'broken' })).toBeNull();
});

function writeJob(jobsDir: string, id: string, body: string | object): void {
  const dir = path.join(jobsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

test('helperStatus joins a full job file and skips interactive registry entries', () => {
  const jobsDir = freshDir();
  writeJob(jobsDir, 'abcd1234', {
    state: 'running',
    detail: 'Reading foo.ts',
    tempo: 'working',
    needs: 'login required: run /login',
    updatedAt: '2026-09-17T12:00:00.000Z',
  });
  const agents = JSON.stringify([
    { id: 'abcd1234', kind: 'background', name: 'conv-x', sessionId: 'sess-1', state: 'running' },
    { id: 'ffff0000', kind: 'interactive', name: 'resident', sessionId: 'sess-0', state: 'idle' },
  ]);
  expect(helperStatus(agents, jobsDir, Date.parse('2026-09-17T12:00:10.000Z'))).toEqual([{
    name: 'conv-x',
    sessionId: 'sess-1',
    state: 'running',
    detail: 'Reading foo.ts',
    tempo: 'working',
    needs: 'login required: run /login',
    age_s: 10,
  }]);
});

test('helperStatus degrades to registry fields when the job file is missing, malformed, or the id is invalid', () => {
  const jobsDir = freshDir();
  writeJob(jobsDir, '22222222', '{broken');
  writeJob(jobsDir, '33333333', { state: 'running', tempo: 'working', updatedAt: 'not-a-date' });
  const agents = JSON.stringify([
    { id: '11111111', kind: 'background', name: 'a', sessionId: 'sa', state: 'running' },
    { id: '22222222', kind: 'background', name: 'b', sessionId: 'sb', state: 'idle' },
    { id: '33333333', kind: 'background', name: 'c', sessionId: 'sc', state: 'running' },
    { id: 'not-hex', kind: 'background', name: 'd', sessionId: 'sd', state: 'running' },
  ]);
  expect(helperStatus(agents, jobsDir, Date.now())).toEqual([
    { name: 'a', sessionId: 'sa', state: 'running' },
    { name: 'b', sessionId: 'sb', state: 'idle' },
    { name: 'c', sessionId: 'sc', state: 'running', tempo: 'working' },
    { name: 'd', sessionId: 'sd', state: 'running' },
  ]);
});

test('helperStatus omits empty detail and truncates long job fields', () => {
  const jobsDir = freshDir();
  writeJob(jobsDir, 'abcd1234', {
    state: 'blocked',
    detail: '',
    tempo: 'blocked',
    needs: 'n'.repeat(121),
    updatedAt: '2026-09-17T12:00:00.000Z',
  });
  const row = helperStatus(JSON.stringify([
    { id: 'abcd1234', kind: 'background', name: 'h', sessionId: 's', state: 'blocked' },
  ]), jobsDir, Date.parse('2026-09-17T12:00:00.000Z'))[0];
  expect(row).not.toHaveProperty('detail');
  expect(row.needs).toBe('n'.repeat(120));
  expect(row.tempo).toBe('blocked');
  expect(row.age_s).toBe(0);
});

test('helperStatus returns an empty list for unparsable or non-array registry text', () => {
  const jobsDir = freshDir();
  expect(helperStatus('broken', jobsDir, 0)).toEqual([]);
  expect(helperStatus('{}', jobsDir, 0)).toEqual([]);
  expect(helperStatus('', jobsDir, 0)).toEqual([]);
});

function recordCalls(script: (argv: string[], opts?: { cwd?: string }) => { stdout: string; exitCode: number }) {
  const calls: { argv: string[]; cwd?: string }[] = [];
  const spawn: HarnessSpawn = (argv, opts) => { calls.push({ argv, cwd: opts?.cwd }); return script(argv, opts); };
  return { spawn, calls };
}

const CONFIG = { permission_mode: 'auto', remote: false };

test('harness: idle helper is stopped, then relaunched flagless for /compact', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  const { spawn, calls } = recordCalls(argv => {
    if (argv[1] === 'stop') return { stdout: '', exitCode: 0 };
    return { stdout: 'woke session', exitCode: 0 };
  });
  // Live registry shape for a helper that finished its turn: `status: idle` with
  // `state: done` — an idle helper never reports `state: 'idle'`.
  const readRegistry = () => [{ id: 'aaaa1111', sessionId: input.session_id, status: 'idle', state: 'done' }];
  const sessionName = await harness(dir, key, '/compact', null, CONFIG, { spawn, readRegistry });
  expect(sessionName).toBe(input.session_name);
  expect(calls).toEqual([
    { argv: ['claude', 'stop', 'aaaa1111'], cwd: undefined },
    { argv: ['claude', '--bg', '--resume', input.session_id, '/compact'], cwd: input.worktree },
  ]);
  expect(lookup(dir, key)?.status).toBe('running');
});

test('harness: absent registry entry skips the stop', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  const { spawn, calls } = recordCalls(() => ({ stdout: 'woke session', exitCode: 0 }));
  const readRegistry = () => []; // no entry with this record's session_id: nothing to stop
  await harness(dir, key, '/model', 'sonnet', CONFIG, { spawn, readRegistry });
  expect(calls).toHaveLength(1);
  expect(calls[0].argv).not.toContain('stop');
});

test('harness: a busy helper refuses without stopping or relaunching', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  const { spawn, calls } = recordCalls(() => ({ stdout: '', exitCode: 0 }));
  const readRegistry = () => [{ id: 'aaaa1111', sessionId: input.session_id, status: 'busy', state: 'working' }];
  await expect(harness(dir, key, '/effort', 'high', CONFIG, { spawn, readRegistry })).rejects.toThrow('helper-busy');
  expect(calls).toHaveLength(0);
});

test('harness: a blocked helper refuses without stopping or relaunching', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  const { spawn, calls } = recordCalls(() => ({ stdout: '', exitCode: 0 }));
  // A blocked helper also reports `status: idle`, so `state` is what distinguishes it.
  const readRegistry = () => [{ id: 'aaaa1111', sessionId: input.session_id, status: 'idle', state: 'blocked' }];
  await expect(harness(dir, key, '/effort', 'high', CONFIG, { spawn, readRegistry })).rejects.toThrow('helper-blocked');
  expect(calls).toHaveLength(0);
});

test('harness: a "started a copy" relaunch resolves through awaitAgent and stores the new session id', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  let registryReads = 0;
  const { spawn } = recordCalls(() => ({ stdout: 'started a copy as bbbb2222', exitCode: 0 }));
  const readRegistry = () => {
    registryReads += 1;
    return registryReads === 1
      ? [] // the pre-relaunch liveness check: nothing running, so no stop
      : [{ id: 'bbbb2222', sessionId: 'copy-session', cwd: input.worktree }]; // awaitAgent's poll
  };
  await harness(dir, key, '/model', 'opus', CONFIG, { spawn, readRegistry });
  expect(lookup(dir, key)).toMatchObject({ session_id: 'copy-session', model: 'opus', status: 'running' });
});

test('harness: a "woke session" relaunch leaves the session id unchanged', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  const { spawn } = recordCalls(() => ({ stdout: 'woke session', exitCode: 0 }));
  const readRegistry = () => [];
  await harness(dir, key, '/compact', null, CONFIG, { spawn, readRegistry });
  expect(lookup(dir, key)?.session_id).toBe(input.session_id);
});

test('harness: a second flagged command re-passes the first one\'s stored value', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  const { spawn, calls } = recordCalls(() => ({ stdout: 'woke session', exitCode: 0 }));
  const readRegistry = () => []; // no running entry: nothing to stop, focus on relaunch argv
  await harness(dir, key, '/model', 'sonnet', CONFIG, { spawn, readRegistry });
  await harness(dir, key, '/effort', 'high', CONFIG, { spawn, readRegistry });
  const secondRelaunch = calls[calls.length - 1].argv;
  expect(secondRelaunch).toContain('--model');
  expect(secondRelaunch[secondRelaunch.indexOf('--model') + 1]).toBe('sonnet');
  expect(secondRelaunch).toContain('--effort');
  expect(secondRelaunch[secondRelaunch.indexOf('--effort') + 1]).toBe('high');
});

test('harness: remote config adds --remote-control with the session name', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  const { spawn, calls } = recordCalls(() => ({ stdout: 'woke session', exitCode: 0 }));
  const readRegistry = () => [];
  await harness(dir, key, '/advisor', 'opus', { ...CONFIG, remote: true }, { spawn, readRegistry });
  const relaunch = calls[calls.length - 1].argv;
  expect(relaunch).toContain('--remote-control');
  expect(relaunch[relaunch.indexOf('--remote-control') + 1]).toBe(input.session_name);
});

test('harness: a failed relaunch restores the record\'s previous override values', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  update(dir, key, { model: 'opus' });
  const { spawn } = recordCalls(() => ({ stdout: '', exitCode: 1 }));
  const readRegistry = () => [];
  await expect(harness(dir, key, '/effort', 'high', CONFIG, { spawn, readRegistry })).rejects.toThrow('resume-failed');
  const record = lookup(dir, key);
  expect(record?.model).toBe('opus');
  expect(record).not.toHaveProperty('effort');
});

test('harness: unknown key, bad command, doctor/clear, refused mode, and bypass-mode all refuse', async () => {
  const dir = freshDir();
  bind(dir, key, input);
  const { spawn, calls } = recordCalls(() => ({ stdout: '', exitCode: 0 }));
  const readRegistry = () => [];
  await expect(harness(dir, 'discord:missing', '/model', 'sonnet', CONFIG, { spawn, readRegistry })).rejects.toThrow('not-found');
  await expect(harness(dir, key, '/status', null, CONFIG, { spawn, readRegistry })).rejects.toThrow('invalid-command');
  await expect(harness(dir, key, '/doctor', null, CONFIG, { spawn, readRegistry })).rejects.toThrow('invalid-command');
  await expect(harness(dir, key, '/clear', null, CONFIG, { spawn, readRegistry })).rejects.toThrow('invalid-command');
  await expect(harness(dir, key, '/permission-mode', 'bypassPermissions', CONFIG, { spawn, readRegistry })).rejects.toThrow('invalid-command');
  await expect(harness(dir, key, '/model', 'sonnet', { ...CONFIG, permission_mode: 'bypassPermissions' }, { spawn, readRegistry })).rejects.toThrow('bypass-mode');
  expect(calls).toHaveLength(0);
});

// AGENT_DIR is applied last so an ambient one from the shell running the suite can
// never outrank the fixture dir and trip the state-dir pin; a caller that wants a
// mismatch sets AGENT_DIR in `env` explicitly.
async function cli(dir: string, args: string[], env?: typeof process.env) {
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../scripts/conversation.ts'), dir, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env, AGENT_DIR: env?.AGENT_DIR ?? dir } });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, code };
}

function fakeClaudePath(script: string): { PATH: string } {
  const shimDir = freshDir();
  const binDir = path.join(shimDir, 'bin');
  fs.mkdirSync(binDir);
  const claude = path.join(binDir, 'claude');
  fs.writeFileSync(claude, script);
  fs.chmodSync(claude, 0o755);
  return { PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
}

test('await-agent lists on the second registry read and times out when never listed', async () => {
  const dir = freshDir();
  const countFile = path.join(freshDir(), 'count');
  fs.writeFileSync(countFile, '0');
  const listed = fakeClaudePath(`#!/bin/sh
n=$(($(cat '${countFile}') + 1))
echo "$n" > '${countFile}'
if [ "$n" = 1 ]; then echo '[]'; else echo '[{"id":"abcd1234","sessionId":"abcd1234-sess","cwd":"/w"}]'; fi
`);
  expect(await cli(dir, ['await-agent', '--bg-id', 'abcd1234', '--timeout', '5'], listed)).toEqual({
    stdout: 'OK|abcd1234-sess|/w\n',
    code: 0,
  });
  const empty = fakeClaudePath('#!/bin/sh\necho \'[]\'\n');
  expect(await cli(dir, ['await-agent', '--bg-id', 'abcd1234', '--timeout', '1'], empty)).toEqual({
    stdout: 'TIMEOUT|abcd1234\n',
    code: 1,
  });
  expect(await cli(dir, ['await-agent', '--bg-id', 'nope'])).toEqual({
    stdout: 'ERROR|invalid-bg-id\n',
    code: 1,
  });
});

test('helper-status reads job detail from CLAUDE_CONFIG_DIR, not ~/.claude', async () => {
  const dir = freshDir();
  const configDir = freshDir();
  writeJob(path.join(configDir, 'jobs'), 'abcd1234', {
    state: 'running',
    detail: 'Reading foo.ts',
    tempo: 'working',
    updatedAt: '2026-09-17T12:00:00.000Z',
  });
  const stub = fakeClaudePath(`#!/bin/sh
echo '[{"id":"abcd1234","kind":"background","name":"conv-x","sessionId":"sess-1","state":"running"}]'
`);
  const result = await cli(dir, ['helper-status'], { ...stub, CLAUDE_CONFIG_DIR: configDir });
  expect(result.code).toBe(0);
  const rows = JSON.parse(result.stdout);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ name: 'conv-x', sessionId: 'sess-1', state: 'running', detail: 'Reading foo.ts', tempo: 'working' });
  expect(await cli(dir, ['helper-status', 'x'])).toEqual({ stdout: 'ERROR|invalid-options\n', code: 1 });
});

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
