// Structural and behavioral tests for write-confirm-gate.ts
// Run with: bun test tests/hook.test.ts

import { test, expect, describe } from 'bun:test';
import { spawnSync } from 'child_process';
import path from 'node:path';

const HOOK = path.join(import.meta.dir, '..', 'hooks', 'write-confirm-gate.ts');

function runHook(payload: unknown): { exitCode: number; stderr: string; stdout: string } {
  const input = JSON.stringify(payload);
  const result = spawnSync('bun', [HOOK], {
    input,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

describe('write-confirm-gate: pass-through cases', () => {
  test('non-Bash tool always passes', () => {
    const r = runHook({ tool_name: 'Read', tool_input: { file_path: '/some/file' } });
    expect(r.exitCode).toBe(0);
  });

  test('Bash call not involving forge.php passes', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    expect(r.exitCode).toBe(0);
  });

  test('forge.php servers (read command) passes', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php servers' } });
    expect(r.exitCode).toBe(0);
  });

  test('forge.php check passes', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php check' } });
    expect(r.exitCode).toBe(0);
  });

  test('preview-deploy passes (read-only)', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php preview-deploy prod-web myapp.com' } });
    expect(r.exitCode).toBe(0);
  });

  test('preview-reboot passes (read-only)', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php preview-reboot prod-web' } });
    expect(r.exitCode).toBe(0);
  });

  test('failed-deploys passes', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php failed-deploys --json' } });
    expect(r.exitCode).toBe(0);
  });

  test('deploy-status passes (read-only poll, not a write)', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php deploy-status 12 34 8821' } });
    expect(r.exitCode).toBe(0);
  });

  test('call method passes', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'echo \'["s1"]\' | php /plugin/php/forge.php call servers' } });
    expect(r.exitCode).toBe(0);
  });
});

describe('write-confirm-gate: blocked cases', () => {
  test('deploy without --confirm is blocked', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php deploy prod-web myapp.com' } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--confirm');
  });

  test('deploy with an unknown trailing flag but no --confirm is blocked', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php deploy prod-web myapp.com --json' } });
    expect(r.exitCode).toBe(2);
  });

  test('server-reboot without --confirm is blocked', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php server-reboot prod-web' } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--confirm');
  });

  test('a --confirm substring (e.g. --confirm-later) does NOT satisfy the gate', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php deploy prod-web myapp.com --confirm-later' } });
    expect(r.exitCode).toBe(2);
  });
});

describe('write-confirm-gate: allowed write cases', () => {
  test('deploy with --confirm passes', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php deploy prod-web myapp.com --confirm' } });
    expect(r.exitCode).toBe(0);
  });

  test('deploy with --confirm anywhere in the args passes', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php deploy prod-web myapp.com --json --confirm' } });
    expect(r.exitCode).toBe(0);
  });

  test('server-reboot with --confirm passes', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php /plugin/php/forge.php server-reboot prod-web --confirm' } });
    expect(r.exitCode).toBe(0);
  });
});

describe('write-confirm-gate: env-var prefix + path variants', () => {
  test('env-var prefix before php does not confuse tokenization', () => {
    // The subcommand is still after forge.php
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'FORGE_ORG=myorg php /plugin/php/forge.php deploy srv site' } });
    expect(r.exitCode).toBe(2);
  });

  test('${CLAUDE_PLUGIN_ROOT} as literal in command is handled (plugin-dir mode)', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy srv site' } });
    expect(r.exitCode).toBe(2);
  });

  test('${CLAUDE_PLUGIN_ROOT} deploy with --confirm passes', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy srv site --confirm' } });
    expect(r.exitCode).toBe(0);
  });
});

describe('write-confirm-gate: fail-open on bad input', () => {
  // A hook must never block Claude Code on a parse glitch — unparseable or
  // empty stdin passes through; the authoritative in-PHP --confirm gate remains.
  test('malformed JSON input passes through', () => {
    const result = spawnSync('bun', [HOOK], {
      input: 'not json',
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
  });

  test('empty stdin passes through', () => {
    const result = spawnSync('bun', [HOOK], {
      input: '',
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
  });
});
