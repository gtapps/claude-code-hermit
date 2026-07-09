// precompact-stamp.test.ts — PreCompact hook: stamps SHELL.md's Progress Log with a
// breadcrumb before Claude Code compacts context, and only ever on a genuine PreCompact
// payload with a recognized trigger. See scripts/precompact-stamp.ts and
// scripts/lib/progress-log.ts.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runScript } from './helpers/run';

let hermitDir: string;
let shellPath: string;

beforeEach(() => {
  hermitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-precompact-'));
  fs.mkdirSync(path.join(hermitDir, 'sessions'), { recursive: true });
  shellPath = path.join(hermitDir, 'sessions', 'SHELL.md');
  fs.writeFileSync(shellPath, '## Progress Log\n', 'utf-8');
  fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({ timezone: 'UTC' }), 'utf-8');
});

afterEach(() => {
  fs.rmSync(hermitDir, { recursive: true, force: true });
});

async function runHook(stdin: string) {
  return runScript('precompact-stamp.ts', { stdin, env: { AGENT_DIR: hermitDir } });
}

describe('precompact-stamp: valid PreCompact payloads', () => {
  test('trigger:"auto" writes a breadcrumb, empty stdout, exit 0', async () => {
    const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    const shell = fs.readFileSync(shellPath, 'utf-8');
    expect(shell).toContain('context compacted (auto)');
    expect(shell).toContain('arc may have unfinished work');
  });

  test('trigger:"manual" writes a breadcrumb, empty stdout, exit 0', async () => {
    const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'manual' }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    const shell = fs.readFileSync(shellPath, 'utf-8');
    expect(shell).toContain('context compacted (manual)');
  });
});

describe('precompact-stamp: no-op on anything that is not a genuine PreCompact payload', () => {
  test('malformed stdin: no write, no stdout, exit 0', async () => {
    const before = fs.readFileSync(shellPath, 'utf-8');
    const result = await runHook('not json{{{');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.readFileSync(shellPath, 'utf-8')).toBe(before);
  });

  test('empty stdin: no write, no stdout, exit 0', async () => {
    const before = fs.readFileSync(shellPath, 'utf-8');
    const result = await runHook('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.readFileSync(shellPath, 'utf-8')).toBe(before);
  });

  test('wrong hook_event_name: no write', async () => {
    const before = fs.readFileSync(shellPath, 'utf-8');
    const result = await runHook(JSON.stringify({ hook_event_name: 'SessionStart', trigger: 'auto' }));
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(shellPath, 'utf-8')).toBe(before);
  });

  test('invalid trigger value: no write', async () => {
    const before = fs.readFileSync(shellPath, 'utf-8');
    const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'bogus' }));
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(shellPath, 'utf-8')).toBe(before);
  });

  test('missing trigger: no write', async () => {
    const before = fs.readFileSync(shellPath, 'utf-8');
    const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact' }));
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(shellPath, 'utf-8')).toBe(before);
  });
});

describe('precompact-stamp: fail-open', () => {
  test('unwritable SHELL.md target does not crash the hook (still exit 0, no stdout)', async () => {
    // Point AGENT_DIR at a hermit dir whose sessions/SHELL.md path is actually a directory —
    // an unwritable-as-a-file target — and confirm the hook still exits cleanly.
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-precompact-bad-'));
    fs.mkdirSync(path.join(badDir, 'sessions', 'SHELL.md'), { recursive: true }); // SHELL.md is a directory, not a file
    fs.writeFileSync(path.join(badDir, 'config.json'), JSON.stringify({ timezone: 'UTC' }), 'utf-8');
    try {
      const result = await runScript('precompact-stamp.ts', {
        stdin: JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' }),
        env: { AGENT_DIR: badDir },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });
});
