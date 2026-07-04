// Unit tests for scripts/lib/cost-log.ts — in-process (pure fs, no HERMIT_DIR
// module-load cache like cost-tracker.ts, so direct import is safe here).
//
// Covers: by_week/by_month aggregation incl. a tz day/week/month boundary case,
// INDEX_VERSION-bump rebuild, week/month pruning, scanUnpricedModels.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateCostIndex, readCostIndex, scanUnpricedModels } from '../scripts/lib/cost-log';

function withTmpdir(fn: (dir: string) => void) {
  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-log-'));
    try { fn(dir); } finally { fs.rmSync(dir, { recursive: true }); }
  };
}

function writeLog(dir: string, entries: object[]): string {
  const logPath = path.join(dir, 'cost-log.jsonl');
  fs.writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return logPath;
}

const NY = 'America/New_York';

describe('updateCostIndex — by_week/by_month tz-aware aggregation', () => {
  test('a UTC-late-night entry buckets into the prior NY calendar day/week/month', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      // 2026-07-05T02:00:00Z = 2026-07-04T22:00:00 America/New_York (EDT, UTC-4)
      { timestamp: '2026-07-05T02:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    const idx = updateCostIndex(logPath, idxPath, NY);

    expect(Object.keys(idx.by_date)).toEqual(['2026-07-04']);
    expect(idx.by_week['2026-W27'].cost).toBe(1.0);
    expect(idx.by_month['2026-07'].cost).toBe(1.0);
  }));

  test('two entries in the same tz-local day/week/month accumulate into one bucket each', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T22:17:00Z', session_id: 's1', source: 'heartbeat', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.5 },
      { timestamp: '2026-07-05T02:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 50, estimated_cost_usd: 0.5 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    const idx = updateCostIndex(logPath, idxPath, NY);

    expect(Object.keys(idx.by_date)).toEqual(['2026-07-04']);
    expect(idx.by_date['2026-07-04'].cost).toBe(2);
    expect(idx.by_week['2026-W27'].cost).toBe(2);
    expect(idx.by_month['2026-07'].cost).toBe(2);
    expect(idx.total_cost_usd).toBe(2);
  }));

  test('default timezone (UTC) behaves as before when unspecified', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T22:17:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    const idx = updateCostIndex(logPath, idxPath); // no timezone arg -> defaults to UTC

    expect(Object.keys(idx.by_date)).toEqual(['2026-07-04']);
    expect(idx.by_week['2026-W27']).toBeDefined();
  }));

  test('incremental update (second call) only processes newly appended bytes', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T12:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    updateCostIndex(logPath, idxPath, 'UTC');

    fs.appendFileSync(logPath, JSON.stringify({
      timestamp: '2026-07-04T13:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 50, estimated_cost_usd: 0.5,
    }) + '\n');
    const idx = updateCostIndex(logPath, idxPath, 'UTC');

    expect(idx.by_date['2026-07-04'].cost).toBe(1.5);
    expect(idx.total_cost_usd).toBe(1.5);
  }));
});

describe('index version bump forces a rebuild', () => {
  test('a v2 (pre-PROP-016) index is discarded and rebuilt with by_week/by_month', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T12:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    // Simulate a stale v2 index (no by_week/by_month, different byte_offset).
    fs.writeFileSync(idxPath, JSON.stringify({
      version: 2, byte_offset: 0, total_cost_usd: 0, total_tokens: 0, total_sessions: 0,
      last_session_id: null, by_source: {}, by_date: {}, skipped_corrupt_lines: 0,
      updated_at: new Date(0).toISOString(),
    }));

    const idx = updateCostIndex(logPath, idxPath, 'UTC');

    expect(idx.version).toBe(3);
    expect(idx.by_week).toBeDefined();
    expect(idx.by_month).toBeDefined();
    expect(idx.total_cost_usd).toBe(1.0);
  }));

  test('readCostIndex returns null for a stale v2 file (forces caller rebuild)', withTmpdir((dir) => {
    const idxPath = path.join(dir, 'cost-index.json');
    fs.writeFileSync(idxPath, JSON.stringify({ version: 2, by_date: {} }));
    expect(readCostIndex(idxPath)).toBeNull();
  }));
});

describe('week/month pruning', () => {
  test('by_week and by_month entries older than retention are dropped', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      // Far in the past — well outside both retention windows.
      { timestamp: '2020-01-01T12:00:00Z', session_id: 's0', source: 'other', model: 'sonnet', total_tokens: 10, estimated_cost_usd: 0.1 },
      { timestamp: '2026-07-04T12:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    const idx = updateCostIndex(logPath, idxPath, 'UTC');

    // Old bucket pruned from by_date/by_week/by_month...
    expect(idx.by_date['2020-01-01']).toBeUndefined();
    expect(Object.keys(idx.by_week).some(w => w.startsWith('2020'))).toBe(false);
    expect(idx.by_month['2020-01']).toBeUndefined();
    // ...but total_cost_usd (all-time) still includes it.
    expect(idx.total_cost_usd).toBeCloseTo(1.1, 5);
  }));
});

describe('scanUnpricedModels', () => {
  test('counts only lines flagged model_unpriced:true within the date window', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T12:00:00Z', model: 'sonnet', source: 'other', estimated_cost_usd: 1.0, model_unpriced: true },
      { timestamp: '2026-07-04T13:00:00Z', model: 'sonnet', source: 'other', estimated_cost_usd: 2.0, model_unpriced: false },
      { timestamp: '2026-06-01T00:00:00Z', model: 'sonnet', source: 'other', estimated_cost_usd: 5.0, model_unpriced: true }, // outside window
    ]);
    const result = scanUnpricedModels(logPath, '2026-07-01', 'UTC');
    expect(result.count).toBe(1);
    expect(result.cost).toBe(1.0);
  }));

  test('returns zero on an absent log file', () => {
    const result = scanUnpricedModels('/nonexistent/path/cost-log.jsonl', '2026-01-01');
    expect(result).toEqual({ count: 0, cost: 0 });
  });
});
