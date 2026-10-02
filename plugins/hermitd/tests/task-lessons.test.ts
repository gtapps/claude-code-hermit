import { test, expect } from 'bun:test';
import { taskFixture } from './helpers/tasks';
import { decodeTask } from '../scripts/lib/tasks';

test('lesson appends each stdin line and leaves the task open', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open();
    await f.ok('lesson', [id], 'First lesson\nSecond lesson');
    const record = decodeTask(f.text(id));
    expect(record.status).toBe('open');
    const lessons = record.body.split('## Lessons\n')[1].split('\n## ')[0];
    expect(lessons).toContain('hermit: First lesson');
    expect(lessons).toContain('hermit: Second lesson');
  } finally { f.cleanup(); }
});
