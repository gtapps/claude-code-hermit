// Contract tests for scripts/usage-track.ts — the PostToolUse hook that feeds
// state/usage-metrics.jsonl for weekly-review's "no tracked use" suggestions.
// Exercised as a subprocess (stdin in, exit code/ledger-file out), the same
// boundary Claude Code sees. Event shapes match the live probe (2026-07-10,
// CC v2.1.206): Skill tool_input is {"skill":"<namespaced-name>"}.
//
// Usage: bun test tests/usage-track.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const ledgerPath = (dir: string) => hermit(dir, 'state', 'usage-metrics.jsonl');

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

function readLedgerEvents(dir: string): any[] {
  if (!fs.existsSync(ledgerPath(dir))) return [];
  return fs.readFileSync(ledgerPath(dir), 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

const run = (payload: object, dir: string) =>
  runScript('usage-track.ts', { stdin: JSON.stringify(payload), cwd: dir });

describe('usage-track', () => {
  test('Skill tool invocation — appends a meta line and a skill event', withDir(async (dir) => {
    const r = await run({ tool_name: 'Skill', tool_input: { skill: 'usage-probe:probe-skill' } }, dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    const events = readLedgerEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'meta', event: 'ledger-start' });
    expect(events[1]).toMatchObject({ kind: 'skill', name: 'usage-probe:probe-skill', source: 'skill-tool' });
  }));

  test('Read of a compiled/ artifact (absolute path) — appends a compiled event', withDir(async (dir) => {
    const filePath = hermit(dir, 'compiled', 'note-x-2026-01-01.md');
    const r = await run({ tool_name: 'Read', tool_input: { file_path: filePath } }, dir);
    expect(r.exitCode).toBe(0);
    const events = readLedgerEvents(dir);
    expect(events.at(-1)).toMatchObject({ kind: 'compiled', name: 'note-x-2026-01-01', source: 'read' });
  }));

  test('Read of a compiled/ artifact (relative path) — appends a compiled event', withDir(async (dir) => {
    const r = await run({ tool_name: 'Read', tool_input: { file_path: '.claude-code-hermit/compiled/note-y.md' } }, dir);
    expect(r.exitCode).toBe(0);
    const events = readLedgerEvents(dir);
    expect(events.at(-1)).toMatchObject({ kind: 'compiled', name: 'note-y', source: 'read' });
  }));

  test('Read of a non-compiled path — no event, no ledger file', withDir(async (dir) => {
    const r = await run({ tool_name: 'Read', tool_input: { file_path: '/src/foo.ts' } }, dir);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(ledgerPath(dir))).toBe(false);
  }));

  test('Read inside compiled/.archive/ — no event', withDir(async (dir) => {
    const filePath = hermit(dir, 'compiled', '.archive', 'old.md');
    const r = await run({ tool_name: 'Read', tool_input: { file_path: filePath } }, dir);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(ledgerPath(dir))).toBe(false);
  }));

  test('Read of a non-.md file inside compiled/ — no event', withDir(async (dir) => {
    const filePath = hermit(dir, 'compiled', 'notes.txt');
    const r = await run({ tool_name: 'Read', tool_input: { file_path: filePath } }, dir);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(ledgerPath(dir))).toBe(false);
  }));

  test('non-matching tool (Edit) — no event', withDir(async (dir) => {
    const r = await run({ tool_name: 'Edit', tool_input: { file_path: hermit(dir, 'compiled', 'note.md') } }, dir);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(ledgerPath(dir))).toBe(false);
  }));

  test('Skill tool_input missing skill field — no event', withDir(async (dir) => {
    const r = await run({ tool_name: 'Skill', tool_input: {} }, dir);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(ledgerPath(dir))).toBe(false);
  }));

  test('malformed stdin — exit 0, no ledger file', withDir(async (dir) => {
    const r = await runScript('usage-track.ts', { stdin: '{broken', cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(ledgerPath(dir))).toBe(false);
  }));

  test('empty stdin — exit 0, no ledger file', withDir(async (dir) => {
    const r = await runScript('usage-track.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(ledgerPath(dir))).toBe(false);
  }));

  test('two sequential appends — one meta line, two events', withDir(async (dir) => {
    await run({ tool_name: 'Skill', tool_input: { skill: 'a:one' } }, dir);
    await run({ tool_name: 'Skill', tool_input: { skill: 'a:two' } }, dir);
    const events = readLedgerEvents(dir);
    expect(events.filter(e => e.kind === 'meta')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'skill')).toHaveLength(2);
  }));
});
