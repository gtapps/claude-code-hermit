import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { conversationHistory, dbExists, logMessage } from '../scripts/lib/channel-log';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('conversation-history-');
afterAll(cleanup);

test('history selects the newest rows across both directions in chronological order', () => {
  const dir = freshDir();
  const rows = [
    { ts: '2026-09-12T10:03:00Z', direction: 'out', sender: 'helper', text: 'result' },
    { ts: '2026-09-12T10:01:00Z', direction: 'in', sender: 'alice', text: 'task' },
    { ts: '2026-09-12T10:02:00Z', direction: 'out', sender: 'helper', text: 'working' },
    { ts: '2026-09-12T10:02:00Z', direction: 'in', sender: 'bob', text: 'steering' },
  ] as const;
  for (const row of rows) expect(logMessage(dir, { source: 'discord', chat_id: 'thread', ...row }).ok).toBe(true);
  logMessage(dir, { source: 'discord', chat_id: 'other', ...rows[0], text: 'another chat' });
  logMessage(dir, { source: 'telegram', chat_id: 'thread', ...rows[0], text: 'another source' });
  expect(conversationHistory(dir, 'discord', 'thread', { limit: 3 })).toEqual([rows[2], rows[3], rows[0]]);
  expect(conversationHistory(dir, 'discord', 'thread', { limit: 0 })).toEqual([]);
});

test('missing, disabled, and unreadable logs return an empty history', () => {
  const dir = freshDir();
  expect(conversationHistory(dir, 'discord', 'thread', { limit: 10 })).toEqual([]);
  expect(dbExists(dir)).toBe(false);
  logMessage(dir, { source: 'discord', chat_id: 'thread', direction: 'in', text: 'old message' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ knowledge: { channel_log_enabled: false } }));
  expect(conversationHistory(dir, 'discord', 'thread', { limit: 10 })).toEqual([]);
  const broken = freshDir();
  fs.mkdirSync(path.join(broken, 'state'));
  fs.writeFileSync(path.join(broken, 'state', 'channel-log.sqlite'), 'not a database');
  expect(conversationHistory(broken, 'discord', 'thread', { limit: 10 })).toEqual([]);
});
