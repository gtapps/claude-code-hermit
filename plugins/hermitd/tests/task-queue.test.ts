import { test, expect } from 'bun:test';
import { taskFixture } from './helpers/tasks';

test('only runnable resident records queue and close/cancel hands off the next one', async () => {
  const f = taskFixture();
  try {
    const a = await f.open();
    const b = await f.open();
    await f.ok('block', [a.id, '--waiting-on', 'operator', '--status-line', 'Waiting', '--next', 'Review']);
    const c = await f.open();
    const list = await f.ok('list', ['--open', '--owner', 'resident', '--limit', '2', '--json']);
    expect(list.rows[0].listing).not.toContain('queued');
    expect(list.rows[1].listing).not.toContain('queued');
    expect(list.omitted).toBe(1);
    expect(await f.ok('cancel', [a.id, '--actor', 'operator', '--reason-stdin'], 'Withdrawn')).toMatchObject({ next_queued: { id: b.id } });
    await f.ok('block', [b.id, '--result-stdin'], 'Ready');
    expect(await f.ok('close', [b.id, '--by', 'confirmed', '--actor', 'operator', '--result-rev', '1', '--reason-stdin'], 'Accepted')).toMatchObject({ next_queued: { id: c.id } });
  } finally { f.cleanup(); }
});
