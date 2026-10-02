import { test, expect } from 'bun:test';
import { taskFixture } from './helpers/tasks';

test('a guild thread resolves from its record, before and after the worker handoff', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open(['--owner', 'resident', '--conversation', 'discord:thread1', '--card', JSON.stringify({ chat_id: 'thread1', message_id: 'card1' })]);
    let list = await f.ok('list', ['--conversation', 'discord:thread1', '--open', '--json']);
    expect(list.rows.map((r: any) => r.id)).toEqual([id]);
    expect(list.rows[0].owner).toBe('resident');
    await f.ok('note', [id, '--owner', 'worker:a1b2c3d4e5f6a7b8c'], '');
    list = await f.ok('list', ['--conversation', 'discord:thread1', '--open', '--json']);
    expect(list.rows[0].owner).toBe('worker:a1b2c3d4e5f6a7b8c');
  } finally { f.cleanup(); }
});
