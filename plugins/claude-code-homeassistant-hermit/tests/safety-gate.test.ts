// WP8: tests for hooks/mcp-safety-gate.ts — 1:1 port of
// tests/test_safety_hook.py (13 cases), run against the TS gate.
//
// pytest fixture mapping: make_ha_config -> makeHaConfig from helpers.ts
// (cwd-based config root, same as the conftest tmp_path fixture).

import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import { join } from 'node:path';

import { cleanupTmp, makeHaConfig } from './helpers';

const HOOK = join(import.meta.dir, '..', 'hooks', 'mcp-safety-gate.ts');

afterAll(cleanupTmp);

function run(payload: unknown, cwd?: string) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = Bun.spawnSync([process.execPath, HOOK], {
    stdin: Buffer.from(data, 'utf8'),
    cwd,
  });
  return { returncode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

test('sensitive entity is blocked', () => {
  const result = run({ tool_input: { entity_id: 'lock.front_door' } });
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain('lock.front_door');
});

test('alarm entity is blocked', () => {
  const result = run({ tool_input: { entity_id: 'alarm_control_panel.home' } });
  expect(result.returncode).toBe(2);
});

test('safe entity is allowed', () => {
  const result = run({ tool_input: { entity_id: 'light.living_room' } });
  expect(result.returncode).toBe(0);
});

test('target dict sensitive entity is blocked', () => {
  const result = run({ tool_input: { target: { entity_id: 'lock.garage' } } });
  expect(result.returncode).toBe(2);
});

test('target dict safe entity is allowed', () => {
  const result = run({ tool_input: { target: { entity_id: 'fan.bedroom' } } });
  expect(result.returncode).toBe(0);
});

test('list of entities blocks if any sensitive', () => {
  const result = run({ tool_input: { entity_id: ['light.kitchen', 'lock.front_door'] } });
  expect(result.returncode).toBe(2);
});

test('no entities is blocked', () => {
  // Fail-closed: no resolvable entity_ids means we cannot verify safety.
  const result = run({ tool_input: {} });
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain('Cannot verify target safety');
});

test('malformed json is blocked', () => {
  const result = run('not-json');
  expect(result.returncode).toBe(2);
});

test('missing tool_input is blocked', () => {
  // Fail-closed: missing tool_input also yields no entity IDs.
  const result = run({});
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain('Cannot verify target safety');
});

test('alarm prompts operator in ask mode', () => {
  const root = makeHaConfig('ask');
  const result = run({ tool_input: { entity_id: 'alarm_control_panel.home' } }, root);
  expect(result.returncode).toBe(0);
  const out = JSON.parse(result.stdout);
  expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain('alarm_control_panel.home');
});

test('lock prompts operator in ask mode', () => {
  const root = makeHaConfig('ask');
  const result = run({ tool_input: { entity_id: 'lock.front_door' } }, root);
  expect(result.returncode).toBe(0);
  const out = JSON.parse(result.stdout);
  expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain('lock.front_door');
});

test('no entities blocked in ask mode', () => {
  // Fail-closed branch stays exit 2 even in ask mode — dial only relaxes domain checks.
  const root = makeHaConfig('ask');
  const result = run({ tool_input: {} }, root);
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain('Cannot verify target safety');
});

test('safe entity in ask mode passes silently', () => {
  // Non-sensitive entities still exit 0 with no stdout output under ask mode.
  const root = makeHaConfig('ask');
  const result = run({ tool_input: { entity_id: 'light.living_room' } }, root);
  expect(result.returncode).toBe(0);
  expect(result.stdout).toBe('');
});

test('internal I/O error during policy load fails CLOSED (exit 2), never 1', () => {
  // A directory at <root>/.env passes loadEnvFile's existsSync guard and makes
  // readFileSync throw EISDIR — the deterministic stand-in for EACCES/TOCTOU
  // faults. Uncaught, bun would exit 1, which Claude Code treats as
  // non-blocking: the exact fail-open class this gate exists to prevent.
  const root = makeHaConfig('strict');
  fs.mkdirSync(join(root, '.env'));
  const result = run({ tool_input: { entity_id: 'lock.front_door' } }, root);
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain('internal error');
});

test('block path with stderr unwritable still exits 2, not 1 (fail() write cannot fail open)', () => {
  // Close fd 2 before exec, then feed a block-triggering payload. fail()'s
  // writeSync(2) throws EBADF; if that escaped, bun would exit 1 = fail-open.
  // The guarded write must still exit 2.
  const root = makeHaConfig('strict');
  const payload = JSON.stringify({ tool_input: { entity_id: 'lock.front_door' } });
  const r = Bun.spawnSync(['bash', '-c', `exec 2>&-; exec '${process.execPath}' '${HOOK}'`], {
    stdin: Buffer.from(payload, 'utf8'),
    cwd: root,
  });
  expect(r.exitCode).toBe(2);
});

test('safe concrete entity_id alongside an area_id selector is blocked (unresolvable fan-out)', () => {
  const root = makeHaConfig('strict');
  const result = run({ tool_input: { entity_id: 'light.kitchen', area_id: 'garage' } }, root);
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain('Cannot verify target safety');
});

test('uppercase sensitive domain is blocked (case-insensitive match)', () => {
  const result = run({ tool_input: { entity_id: 'LOCK.front_door' } });
  expect(result.returncode).toBe(2);
});

test('malformed entity_id with empty domain is blocked, not allowed', () => {
  const result = run({ tool_input: { entity_id: '.lock' } });
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain('Cannot verify target safety');
});

