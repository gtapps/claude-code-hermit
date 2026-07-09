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

// Write .claude-code-hermit/state/runtime.json (the opened_at source in window mode).
function seedRuntime(dir: string, data: object): string {
  const stateDir = path.join(dir, '.claude-code-hermit', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const runtimePath = path.join(stateDir, 'runtime.json');
  fs.writeFileSync(runtimePath, JSON.stringify(data));
  return runtimePath;
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

// -------------------------------------------------------
// Window-delta mode: opened_at present (via runtime.json or --opened-at override) sums
// every cost-log row in [opened_at, closed_at] regardless of session_id — cost-log rows
// are tagged with the transcript UUID, never the logical S-NNN, so an exact-id match
// against S-NNN always misses (see the module docstring). See PR-6 in
// .claude-code-hermit/compiled/audit-live-harness-token-efficiency-2026-07-09.md.
// -------------------------------------------------------

describe('session-cost.ts: window-delta mode', () => {
  test('sums rows within [opened_at, closed_at], ignoring session_id, boundaries inclusive', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2026-06-01T09:59:00Z', session_id: 'uuid-1', estimated_cost_usd: 0.50, total_tokens: 5000, source: 'other' }, // before window
      { timestamp: '2026-06-01T10:00:00Z', session_id: 'uuid-1', estimated_cost_usd: 0.10, total_tokens: 1000, source: 'other' }, // == opened_at (inclusive)
      { timestamp: '2026-06-01T10:30:00Z', session_id: 'uuid-1', estimated_cost_usd: 0.20, total_tokens: 2000, source: 'channel:discord' }, // inside
      { timestamp: '2026-06-01T11:00:00Z', session_id: 'uuid-1', estimated_cost_usd: 0.30, total_tokens: 3000, source: 'other' }, // == closed_at (inclusive)
      { timestamp: '2026-06-01T11:00:01Z', session_id: 'uuid-1', estimated_cost_usd: 0.99, total_tokens: 9999, source: 'other' }, // after window
    ]);
    const r = await runScript('session-cost.ts', {
      args: ['S-XXX', '--opened-at', '2026-06-01T10:00:00Z', '--closed-at', '2026-06-01T11:00:00Z'],
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBeCloseTo(0.60, 4);
    expect(out.tokens).toBe(6000);
  }));

  test('reads opened_at from runtime.json when no --opened-at override is given', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2026-06-01T09:00:00Z', session_id: 'uuid-1', estimated_cost_usd: 1.00, total_tokens: 1000, source: 'other' }, // before opened_at
      { timestamp: '2026-06-01T10:30:00Z', session_id: 'uuid-1', estimated_cost_usd: 0.50, total_tokens: 500, source: 'other' },  // after opened_at
    ]);
    seedRuntime(dir, { opened_at: '2026-06-01T10:00:00Z' });
    const r = await runScript('session-cost.ts', { args: ['S-XXX'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBeCloseTo(0.50, 4);
    expect(out.tokens).toBe(500);
  }));

  test('two arcs sharing one transcript UUID — window query sums only the requested arc', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2026-06-01T09:00:00Z', session_id: 'uuid-shared', estimated_cost_usd: 0.10, total_tokens: 100, source: 'other' }, // arc 1
      { timestamp: '2026-06-01T09:05:00Z', session_id: 'uuid-shared', estimated_cost_usd: 0.20, total_tokens: 200, source: 'other' }, // arc 1
      { timestamp: '2026-06-01T14:00:00Z', session_id: 'uuid-shared', estimated_cost_usd: 0.30, total_tokens: 300, source: 'other' }, // arc 2
    ]);
    const r = await runScript('session-cost.ts', {
      args: ['S-YYY', '--opened-at', '2026-06-01T13:00:00Z', '--closed-at', '2026-06-01T15:00:00Z'],
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBeCloseTo(0.30, 4);
    expect(out.tokens).toBe(300);
  }));

  test('runtime.json present without opened_at falls back to session_id sum', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2026-06-01T10:00:00Z', session_id: 'S-001', estimated_cost_usd: 0.1234, total_tokens: 10000, source: 'other' },
      { timestamp: '2026-06-01T11:00:00Z', session_id: 'S-002', estimated_cost_usd: 0.9999, total_tokens: 99999, source: 'other' },
    ]);
    seedRuntime(dir, { session_state: 'in_progress' }); // no opened_at key
    const r = await runScript('session-cost.ts', { args: ['S-001'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBeCloseTo(0.1234, 4);
    expect(out.tokens).toBe(10000);
  }));

  test('unparseable opened_at falls back to session_id sum, never throws', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2026-06-01T10:00:00Z', session_id: 'S-001', estimated_cost_usd: 0.5, total_tokens: 500, source: 'other' },
    ]);
    seedRuntime(dir, { opened_at: 'not-a-date' });
    const r = await runScript('session-cost.ts', { args: ['S-001'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBeCloseTo(0.5, 4);
    expect(out.tokens).toBe(500);
  }));

  test('local-offset --opened-at compares correctly against UTC-Z row timestamps', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2026-06-01T09:00:00.000Z', session_id: 'uuid-1', estimated_cost_usd: 0.10, total_tokens: 100, source: 'other' }, // before
      { timestamp: '2026-06-01T10:30:00.000Z', session_id: 'uuid-1', estimated_cost_usd: 0.20, total_tokens: 200, source: 'other' }, // after
    ]);
    // 2026-06-01T12:00:00+02:00 == 2026-06-01T10:00:00Z
    const r = await runScript('session-cost.ts', {
      args: ['S-XXX', '--opened-at', '2026-06-01T12:00:00+0200'],
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBeCloseTo(0.20, 4);
    expect(out.tokens).toBe(200);
  }));

  test('missing/absent cost-log in window mode fails open to zeros', withTmpdir(async (dir) => {
    // no cost-log seeded
    const r = await runScript('session-cost.ts', {
      args: ['S-XXX', '--opened-at', '2026-06-01T10:00:00Z'],
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBe(0);
    expect(out.tokens).toBe(0);
  }));

  test('closed_at from runtime.json bounds the window end (arc closed after idle)', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2026-06-01T10:30:00Z', session_id: 'uuid-1', estimated_cost_usd: 0.20, total_tokens: 200, source: 'other' }, // inside the closed arc
      { timestamp: '2026-06-01T14:00:00Z', session_id: 'uuid-1', estimated_cost_usd: 0.99, total_tokens: 999, source: 'routine:reflect' }, // autonomous, after closed_at → excluded
    ]);
    seedRuntime(dir, { opened_at: '2026-06-01T10:00:00Z', closed_at: '2026-06-01T11:00:00Z' });
    const r = await runScript('session-cost.ts', { args: ['S-XXX'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBeCloseTo(0.20, 4);
    expect(out.tokens).toBe(200);
  }));

  test('malformed --closed-at falls back to now, not a silent zero window', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2026-06-01T10:30:00Z', session_id: 'uuid-1', estimated_cost_usd: 0.20, total_tokens: 200, source: 'other' }, // inside [opened, now]
    ]);
    // Unparseable --closed-at previously → closedMs NaN → `ts <= NaN` false for every row → false 0.
    const r = await runScript('session-cost.ts', {
      args: ['S-XXX', '--opened-at', '2026-06-01T10:00:00Z', '--closed-at', 'not-a-date'],
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.cost_usd).toBeCloseTo(0.20, 4);
    expect(out.tokens).toBe(200);
  }));
});
