import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allocateTaskShares, updateCostIndex, rebuildCostIndex, SOURCE_ATTRIBUTION_VERSION } from '../scripts/lib/cost-log';

const asOf = new Date('2026-09-16T12:00:00Z');
const shared = { timestamp: '2026-09-16T02:00:00Z', bucket: 'tasks', task_ids: ['T-a', 'T-b'], estimated_cost_usd: 3, total_tokens: 101 };
function fixture(run: (log: string, index: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cost-index-'));
  try { run(path.join(dir, 'cost.jsonl'), path.join(dir, 'index.json')); }
  finally { fs.rmSync(dir, { recursive: true }); }
}

test('two task shares conserve cost and fractional tokens', () => {
  const shares = allocateTaskShares(shared);
  expect(shares).toEqual([{ task_id: 'T-a', cost: 1.5, tokens: 50.5 }, { task_id: 'T-b', cost: 1.5, tokens: 50.5 }]);
  expect(shares.reduce((n, s) => n + s.cost, 0)).toBe(3);
  expect(shares.reduce((n, s) => n + s.tokens, 0)).toBe(101);
  expect(allocateTaskShares({ ...shared, bucket: 'duties' })).toEqual([]);
});

test('incremental task accumulation equals rebuilding and uses local dates', () => fixture((log, index) => {
  fs.writeFileSync(log, JSON.stringify(shared) + '\n');
  updateCostIndex(log, index, 'America/New_York', asOf);
  fs.appendFileSync(log, JSON.stringify({ ...shared, task_ids: undefined, task_id: 'T-a' }) + '\n');
  const incremental = updateCostIndex(log, index, 'America/New_York', asOf);
  const rebuilt = rebuildCostIndex(log, index, 'America/New_York', asOf);
  expect(incremental.by_task).toEqual(rebuilt.by_task);
  expect(incremental.by_task['T-a']['2026-09-15']).toEqual({ cost: 4.5, tokens: 151.5 });
  expect(incremental.total_cost_usd).toBe(rebuilt.total_cost_usd);
  expect(incremental.total_tokens).toBe(rebuilt.total_tokens);
}));

test('task shares plus conversation and duties partition a window total', () => fixture((log, index) => {
  const rows = [shared, { ...shared, bucket: 'conversation', estimated_cost_usd: 2, total_tokens: 20 }, { ...shared, bucket: 'duties', estimated_cost_usd: 4, total_tokens: 40 }];
  fs.writeFileSync(log, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const result = updateCostIndex(log, index, 'UTC', asOf);
  const buckets = Object.values(result.by_task).flatMap(dates => Object.values(dates as Record<string, { cost: number; tokens: number }>));
  expect(buckets.reduce((n, b) => n + b.cost, 0) + 6).toBe(result.total_cost_usd);
  expect(buckets.reduce((n, b) => n + b.tokens, 0) + 60).toBe(result.total_tokens);
}));

test('v3 indexes rebuild and expired task dates prune even without appended rows', () => fixture((log, index) => {
  fs.writeFileSync(log, JSON.stringify(shared) + '\n');
  fs.writeFileSync(index, JSON.stringify({ version: 3, byte_offset: fs.statSync(log).size, timezone: 'UTC' }));
  const current = updateCostIndex(log, index, 'UTC', asOf);
  expect(current.version).toBe(4);
  expect(current.by_task['T-a']).toBeDefined();
  expect(SOURCE_ATTRIBUTION_VERSION).toBe(2);
  const expired = updateCostIndex(log, index, 'UTC', new Date('2027-01-01T12:00:00Z'));
  expect(expired.by_task).toEqual({});
  expect(expired.total_cost_usd).toBe(3);
}));
