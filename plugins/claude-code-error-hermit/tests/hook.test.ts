// Structural and behavioral tests for write-confirm-gate.ts
// Run with: bun test tests/hook.test.ts

import { test, expect, describe } from 'bun:test';
import { spawnSync } from 'child_process';
import path from 'node:path';

const HOOK = path.join(import.meta.dir, '..', 'hooks', 'write-confirm-gate.ts');

function runHook(payload: unknown): { exitCode: number; stderr: string } {
  const result = spawnSync('bun', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { exitCode: result.status ?? -1, stderr: result.stderr ?? '' };
}

const cmd = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

describe('write-confirm-gate: pass-through cases', () => {
  test('non-Bash tool always passes', () => {
    expect(runHook({ tool_name: 'Read', tool_input: { file_path: '/x' } }).exitCode).toBe(0);
  });

  test('Bash call not involving error-api.ts passes', () => {
    expect(runHook(cmd('ls -la')).exitCode).toBe(0);
  });

  test('error-api.ts check passes', () => {
    expect(runHook(cmd('bun /plugin/scripts/error-api.ts check')).exitCode).toBe(0);
  });

  test('error-api.ts issues passes', () => {
    expect(runHook(cmd('bun /plugin/scripts/error-api.ts issues --json')).exitCode).toBe(0);
  });

  test('error-api.ts latest-event passes (read-only)', () => {
    expect(runHook(cmd('bun /plugin/scripts/error-api.ts latest-event 1001 --json')).exitCode).toBe(0);
  });
});

describe('write-confirm-gate: blocked cases', () => {
  test('resolve without --confirm is blocked', () => {
    const r = runHook(cmd('bun /plugin/scripts/error-api.ts resolve 1001'));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--confirm');
  });

  test('mute without --confirm is blocked', () => {
    const r = runHook(cmd('bun /plugin/scripts/error-api.ts mute 1001'));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--confirm');
  });

  test('a --confirm substring (--confirm-later) does NOT satisfy the gate', () => {
    expect(runHook(cmd('bun /plugin/scripts/error-api.ts resolve 1001 --confirm-later')).exitCode).toBe(2);
  });
});

describe('write-confirm-gate: allowed write cases', () => {
  test('resolve with --confirm passes', () => {
    expect(runHook(cmd('bun /plugin/scripts/error-api.ts resolve 1001 --confirm')).exitCode).toBe(0);
  });

  test('mute with --confirm anywhere in args passes', () => {
    expect(runHook(cmd('bun /plugin/scripts/error-api.ts mute 1001 --json --confirm')).exitCode).toBe(0);
  });

  test('${CLAUDE_PLUGIN_ROOT} literal path resolve without --confirm is blocked', () => {
    expect(runHook(cmd('bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts resolve 1001')).exitCode).toBe(2);
  });
});

describe('write-confirm-gate: fail-open on bad input', () => {
  test('malformed JSON input passes through', () => {
    const r = spawnSync('bun', [HOOK], { input: 'not json', encoding: 'utf8', timeout: 5000 });
    expect(r.status).toBe(0);
  });

  test('empty stdin passes through', () => {
    const r = spawnSync('bun', [HOOK], { input: '', encoding: 'utf8', timeout: 5000 });
    expect(r.status).toBe(0);
  });
});
