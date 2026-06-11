// Tests for scripts/session-cost.ts: per-session cost summation from cost-log.jsonl.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';

function withTmpdir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-session-cost-'));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  };
}

// Write a minimal cost-log.jsonl with entries for two different sessions.
function seedCostLog(dir: string, entries: object[]): string {
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const logPath = path.join(claudeDir, 'cost-log.jsonl');
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(logPath, lines);
  return logPath;
}

describe('session-cost.ts', () => {
  test('sums cost and tokens for the target session_id only', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2026-06-01T10:00:00Z', session_id: 'S-001', estimated_cost_usd: 0.1234, total_tokens: 10000, source: 'other', model: 'sonnet' },
      { timestamp: '2026-06-01T10:05:00Z', session_id: 'S-001', estimated_cost_usd: 0.0500, total_tokens: 5000, source: 'heartbeat', model: 'sonnet' },
      { timestamp: '2026-06-01T11:00:00Z', session_id: 'S-002', estimated_cost_usd: 0.9999, total_tokens: 99999, source: 'other', model: 'sonnet' },
    ]);

    const r = await runScript('session-cost.ts', {
      args: ['S-001'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBeCloseTo(0.1734, 4);
    expect(out.tokens).toBe(15000);
  }));

  test('returns zeros for unknown session_id', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2026-06-01T10:00:00Z', session_id: 'S-001', estimated_cost_usd: 0.5, total_tokens: 50000, source: 'other', model: 'sonnet' },
    ]);

    const r = await runScript('session-cost.ts', {
      args: ['S-999'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBe(0);
    expect(out.tokens).toBe(0);
  }));

  test('returns zeros when cost-log is absent', withTmpdir(async (dir) => {
    // no cost-log seeded
    const r = await runScript('session-cost.ts', {
      args: ['S-001'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBe(0);
    expect(out.tokens).toBe(0);
  }));

  test('skips schema-marker lines (no session_id match)', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { schema: 2, timestamp: '2026-06-01T09:00:00Z', note: 'schema upgrade marker' },
      { timestamp: '2026-06-01T10:00:00Z', session_id: 'S-001', estimated_cost_usd: 0.25, total_tokens: 25000, source: 'other', model: 'sonnet' },
    ]);

    const r = await runScript('session-cost.ts', {
      args: ['S-001'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBe(0.25);
    expect(out.tokens).toBe(25000);
  }));
});
