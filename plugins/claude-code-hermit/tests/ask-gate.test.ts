// Contract tests for scripts/ask-gate.ts — the PreToolUse binding gate on
// AskUserQuestion for always-on channel-primary sessions. Exercised as a
// subprocess (stdin in, exit code out), the same boundary Claude Code sees.
// Probe-verified deny-steering behavior:
// compiled/spike-ask-gate-probe-2026-07-05.md.
//
// Usage: bun test tests/ask-gate.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const ELIGIBLE_CHANNELS = {
  primary: 'telegram',
  telegram: { dm_channel_id: '12345', allowed_users: ['u1'] },
};

function setConfig(dir: string, over: Partial<Record<string, unknown>> = {}) {
  write(hermit(dir, 'config.json'), JSON.stringify({
    always_on: true,
    channels: ELIGIBLE_CHANNELS,
    ...over,
  }));
}

const ASK_PAYLOAD = { tool_name: 'AskUserQuestion', tool_input: { questions: [] } };

const run = (payload: object, dir: string) =>
  runScript('ask-gate.ts', { stdin: JSON.stringify(payload), cwd: dir });

describe('ask-gate', () => {
  test('always_on + eligible channel — deny with redirect reason', withDir(async (dir) => {
    setConfig(dir);
    const r = await run(ASK_PAYLOAD, dir);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('channel reply tool');
    expect(r.stderr).toContain('micro-proposals.json');
  }));

  test('always_on: false — untouched even with channels configured', withDir(async (dir) => {
    setConfig(dir, { always_on: false });
    const r = await run(ASK_PAYLOAD, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('always_on: true, no channels — allow (no redirect target)', withDir(async (dir) => {
    setConfig(dir, { channels: {} });
    const r = await run(ASK_PAYLOAD, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('always_on: true, channel ineligible (empty allowed_users) — allow', withDir(async (dir) => {
    setConfig(dir, {
      channels: { primary: 'telegram', telegram: { dm_channel_id: '12345', allowed_users: [] } },
    });
    const r = await run(ASK_PAYLOAD, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('ask_gate: false — explicit escape hatch, allow', withDir(async (dir) => {
    setConfig(dir, { ask_gate: false });
    const r = await run(ASK_PAYLOAD, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('non-AskUserQuestion tool — allow', withDir(async (dir) => {
    setConfig(dir);
    const r = await run({ tool_name: 'Bash', tool_input: { command: 'ls' } }, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('missing config.json — fail-open, allow', withDir(async (dir) => {
    fs.rmSync(hermit(dir, 'config.json'), { force: true });
    const r = await run(ASK_PAYLOAD, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('corrupt config.json — fail-open, allow', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{not json');
    const r = await run(ASK_PAYLOAD, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('empty stdin — fail-open, allow', withDir(async (dir) => {
    setConfig(dir);
    const r = await runScript('ask-gate.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  test('malformed JSON stdin — fail-open, allow', withDir(async (dir) => {
    setConfig(dir);
    const r = await runScript('ask-gate.ts', { stdin: '{broken', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  test('missing tool_name — fail-open, allow', withDir(async (dir) => {
    setConfig(dir);
    const r = await run({ tool_input: {} }, dir);
    expect(r.exitCode).toBe(0);
  }));
});
