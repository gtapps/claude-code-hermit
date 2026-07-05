// Contract tests for scripts/pause-keyword.ts — the deterministic
// pause/resume/snooze keyword writer (PROP-015). A UserPromptSubmit hook:
// writes state/pause.json directly from an inbound <channel> envelope,
// before any model turn. Exercised as a subprocess (stdin in, exit code/
// stdout out), the boundary Claude Code sees.
//
// Usage: bun test tests/pause-keyword.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { isPaused } from '../scripts/lib/pause';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    // Default config: the operator's DM is chat_id "1" (matching the test envelopes).
    // With no allowed_users set, that DM is the trusted controller — the allowlist
    // tests below overwrite this config with their own.
    write(hermit(wd.dir, 'config.json'), '{"channels":{"discord":{"dm_channel_id":"1"}}}');
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const run = (prompt: string, dir: string) =>
  runScript('pause-keyword.ts', { stdin: JSON.stringify({ prompt }), cwd: dir });

describe('pause-keyword', () => {
  test('"pause" from the operator DM (no allowlist, chat_id matches dm_channel_id) — sets flag, exit 0', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">pause</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('paused');
    const status = isPaused(hermit(dir));
    expect(status.paused).toBe(true);
    expect(status.until).toBeNull();
    expect(status.by).toBe('U1');
  }));

  // #3 fix: with no allowlist, a sender from a DIFFERENT chat than the operator's
  // DM can no longer freeze the hermit (previously accept-all let anyone stop it).
  test('no allowlist, message from a non-DM chat — silent no-op (cannot freeze)', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="99" user="STRANGER">stop</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('"stop" is a synonym for "pause"', withDir(async (dir) => {
    await run('<channel source="discord" chat_id="1" user="U1">stop</channel>', dir);
    expect(isPaused(hermit(dir)).paused).toBe(true);
  }));

  test('"resume" clears an existing pause', withDir(async (dir) => {
    await run('<channel source="discord" chat_id="1" user="U1">pause</channel>', dir);
    expect(isPaused(hermit(dir)).paused).toBe(true);
    const r = await run('<channel source="discord" chat_id="1" user="U1">resume</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('resumed');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('"snooze 2h" pauses with a future paused_until', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">snooze 2h</channel>', dir);
    expect(r.exitCode).toBe(0);
    const status = isPaused(hermit(dir));
    expect(status.paused).toBe(true);
    expect(status.until).not.toBeNull();
    expect(new Date(status.until as string).getTime()).toBeGreaterThan(Date.now());
  }));

  test('"snooze bogus" — unparseable duration, no state change, hint on stdout', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">snooze bogus</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Could not parse');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('unauthorized sender (allowlist configured, sender not listed) — silent no-op', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":["ALLOWED_ID"]}}}');
    const r = await run('<channel source="discord" chat_id="1" user="INTRUDER">pause</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('allowlist configured, sender listed — acts', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":["ALLOWED_ID"]}}}');
    const r = await run('<channel source="discord" chat_id="1" user="ALLOWED_ID">pause</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(isPaused(hermit(dir)).paused).toBe(true);
  }));

  test('allowed_users=[] lockdown — silent no-op even with a user id', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":[]}}}');
    const r = await run('<channel source="discord" chat_id="1" user="ANYONE">pause</channel>', dir);
    expect(r.stdout.trim()).toBe('');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('no user attribute, allowlist configured — rejected (unverifiable identity)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":["ALLOWED_ID"]}}}');
    const r = await run('<channel source="discord" chat_id="1">pause</channel>', dir);
    expect(r.stdout.trim()).toBe('');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('ordinary conversational text — no accidental trigger', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">please pause and think about this</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('no envelope — no-op', withDir(async (dir) => {
    const r = await run('hello world', dir);
    expect(r.stdout.trim()).toBe('');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('empty stdin — fail-open, exit 0', withDir(async (dir) => {
    const r = await runScript('pause-keyword.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  test('malformed JSON stdin — fail-open, exit 0', withDir(async (dir) => {
    const r = await runScript('pause-keyword.ts', { stdin: '{broken', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  test('adversarial control char in user id is sanitized in the acknowledgement', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1\n2">pause</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('\n2');
  }));
});
