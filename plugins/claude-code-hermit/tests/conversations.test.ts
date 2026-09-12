import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
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

async function cli(dir: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../scripts/conversation.ts'), dir, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, code };
}

test('CLI output and two concurrent updates both land', async () => {
  const dir = freshDir();
  expect(await cli(dir, 'bind', key, '--session-name', input.session_name, '--session-id', input.session_id, '--worktree', input.worktree)).toEqual({ stdout: `OK|${key}\n`, code: 0 });
  const results = await Promise.all([
    cli(dir, 'update', key, '--generation', '+1', '--muted', 'true'),
    cli(dir, 'update', key, '--generation', '+1', '--status', 'idle'),
  ]);
  expect(results.every(r => r.code === 0)).toBe(true);
  expect(JSON.parse((await cli(dir, 'lookup', key)).stdout)).toMatchObject({ generation: 3, muted: true, status: 'idle' });
  expect(await cli(dir, 'lookup', 'discord:missing')).toEqual({ stdout: 'ERROR|not-found\n', code: 1 });
  expect(await cli(dir, 'update', key, '--status', 'invalid')).toEqual({ stdout: 'ERROR|invalid-status\n', code: 1 });
  expect(fs.existsSync(path.join(dir, 'state', 'conversations.json.lock'))).toBe(false);
});
