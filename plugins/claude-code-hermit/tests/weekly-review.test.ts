// bun test for scripts/weekly-review.ts — deliverable enumeration and
// owner-language-safe frontmatter (delivered/open_loops_count fields).
// Usage: bun test tests/weekly-review.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';
import { readFileWithFrontmatter } from '../scripts/lib/frontmatter';

function makeHermitDir(): { hermitDir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-weekly-review-'));
  const hermitDir = path.join(root, '.claude-code-hermit');
  fs.mkdirSync(path.join(hermitDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'compiled'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  return { hermitDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function withHermitDir(fn: (hermitDir: string) => Promise<void>) {
  return async () => {
    const h = makeHermitDir();
    try { await fn(h.hermitDir); } finally { h.cleanup(); }
  };
}

function writeSessionReport(hermitDir: string, id: string, opts: {
  status?: string; operatorTurns?: number; artifacts?: string[];
}): void {
  const now = new Date().toISOString();
  const status = opts.status ?? 'completed';
  const operatorTurns = opts.operatorTurns ?? 0;
  const artifactsBody = (opts.artifacts ?? []).join('\n');
  const content = `---
id: ${id}
status: ${status}
date: ${now}
duration: 30m
cost_usd: 1.00
tokens: 1000
tags: []
proposals_created: []
task: "Test task"
escalation: balanced
operator_turns: ${operatorTurns}
closed_via: operator
---
# Session Report: ${id}

## Overview
Test task

## Completed
Did the thing.

## Artifacts
${artifactsBody}

## Blockers
`;
  fs.writeFileSync(path.join(hermitDir, 'sessions', `${id}-REPORT.md`), content);
}

function readReview(hermitDir: string): { fm: Record<string, any>; body: string } {
  const files = fs.readdirSync(path.join(hermitDir, 'compiled')).filter(f => f.startsWith('review-weekly-'));
  expect(files.length).toBe(1);
  const full = path.join(hermitDir, 'compiled', files[0]);
  const { fm, body } = readFileWithFrontmatter(full)!;
  return { fm, body };
}

describe('weekly-review.ts — deliverables', () => {
  test('enumerates ## Artifacts bullets into delivered/delivered_count', withHermitDir(async (hermitDir) => {
    writeSessionReport(hermitDir, 'S-001', {
      artifacts: ['- [[compiled/audit-foo-2026-07-09]] — investigated the login bug'],
    });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(fm.delivered_count).toBe('1');
    expect(fm.delivered).toEqual(['investigated the login bug']);
    expect(body).toContain('### Delivered');
    expect(body).toContain('investigated the login bug');
  }));

  test('falls back to the wikilink slug when a bullet has no annotation', withHermitDir(async (hermitDir) => {
    writeSessionReport(hermitDir, 'S-001', {
      artifacts: ['- [[compiled/audit-foo-2026-07-09]]'],
    });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm } = readReview(hermitDir);
    expect(fm.delivered).toEqual(['audit-foo-2026-07-09']);
  }));

  test('omits Delivered section and zeroes the count when no artifacts were produced', withHermitDir(async (hermitDir) => {
    writeSessionReport(hermitDir, 'S-001', { artifacts: [] });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(fm.delivered_count).toBe('0');
    expect(fm.delivered).toEqual([]);
    expect(body).not.toContain('### Delivered');
  }));

  test('neutralizes commas in annotations so the frontmatter array parser does not split mid-annotation', withHermitDir(async (hermitDir) => {
    writeSessionReport(hermitDir, 'S-001', {
      artifacts: ['- [[compiled/audit-foo-2026-07-09]] — investigated X, wrote Y'],
    });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm } = readReview(hermitDir);
    // One entry, not two — the comma must not have been read as an array separator.
    expect(fm.delivered.length).toBe(1);
    expect(fm.delivered[0]).toContain('investigated X; wrote Y');
  }));

  test('emits open_loops_count in frontmatter for the "Waiting on you" channel section', withHermitDir(async (hermitDir) => {
    writeSessionReport(hermitDir, 'S-001', { artifacts: [] });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm } = readReview(hermitDir);
    expect(fm.open_loops_count).toBe('0');
  }));
});

// -------------------------------------------------------------------------
// Usage section — usage-metrics.jsonl → "no tracked use" suggestions.
// Suggest-only: guarded so a young/missing ledger never reads as "unused".
// -------------------------------------------------------------------------

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function writeLedgerLines(hermitDir: string, lines: object[]): void {
  const p = path.join(hermitDir, 'state', 'usage-metrics.jsonl');
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function writeCompiledDoc(hermitDir: string, filename: string, fm: Record<string, string>): void {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  const content = `---\n${lines.join('\n')}\n---\nBody.\n`;
  fs.writeFileSync(path.join(hermitDir, 'compiled', filename), content);
}

describe('weekly-review.ts — Usage section', () => {
  test('old ledger + stale untouched doc — Usage section lists it', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' }]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(body).toContain('### Usage');
    expect(body).toContain('note-old-2026-01-01.md');
    expect(fm.usage_untouched_count).toBe('1');
  }));

  test('foundational-tagged doc is exempt from the Usage section', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' }]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', {
      type: 'note', created: daysAgoIso(100), tags: '[foundational]',
    });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
    expect(fm.usage_untouched_count).toBe('0');
  }));

  test('topic pages are exempt from the Usage section', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' }]);
    writeCompiledDoc(hermitDir, 'topic-rota.md', { type: 'topic', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
  }));

  test('a young ledger suppresses the Usage section even with a stale doc', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(5), kind: 'meta', event: 'ledger-start' }]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
    expect(fm.usage_untouched_count).toBe('0');
  }));

  test('no ledger at all — no Usage section', withHermitDir(async (hermitDir) => {
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
  }));

  test('a doc read within the staleness window is excluded even if old', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [
      { ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' },
      { ts: daysAgoIso(10), kind: 'compiled', name: 'note-old-2026-01-01', source: 'read' },
    ]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
  }));

  test('a dormant skill (no tracked use in 60+ days) is listed under Usage', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [
      { ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' },
      { ts: daysAgoIso(75), kind: 'skill', name: 'claude-code-hermit:migrate', source: 'skill-tool' },
    ]);
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(body).toContain('### Usage');
    expect(body).toContain('skill claude-code-hermit:migrate');
    expect(fm.usage_untouched_count).toBe('1');
  }));

  test('a recently-used skill is not listed as dormant', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [
      { ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' },
      { ts: daysAgoIso(5), kind: 'skill', name: 'claude-code-hermit:migrate', source: 'skill-tool' },
    ]);
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
  }));

  test('ledger compaction: collapses stale (>180d) duplicate events to the newest per name, keeps meta and recent events', withHermitDir(async (hermitDir) => {
    const tsNewestStale = daysAgoIso(190);
    writeLedgerLines(hermitDir, [
      { ts: daysAgoIso(300), kind: 'meta', event: 'ledger-start' },
      { ts: daysAgoIso(200), kind: 'skill', name: 'x:foo', source: 'skill-tool' },
      { ts: daysAgoIso(195), kind: 'skill', name: 'x:foo', source: 'skill-tool' },
      { ts: tsNewestStale, kind: 'skill', name: 'x:foo', source: 'skill-tool' },
      { ts: daysAgoIso(10), kind: 'skill', name: 'x:bar', source: 'skill-tool' },
    ]);
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const ledgerPath = path.join(hermitDir, 'state', 'usage-metrics.jsonl');
    const events = fs.readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(events.filter(e => e.kind === 'meta')).toHaveLength(1);
    const fooEvents = events.filter(e => e.name === 'x:foo');
    expect(fooEvents).toHaveLength(1);
    expect(fooEvents[0].ts).toBe(tsNewestStale);
    expect(events.some(e => e.name === 'x:bar')).toBe(true);
  }));
});
