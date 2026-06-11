// WP8: tests for hooks/mcp-safety-gate.ts — 1:1 port of
// tests/test_safety_hook.py (13 cases), run against the TS gate.
//
// pytest fixture mapping: make_ha_config -> makeHaConfig from helpers.ts
// (cwd-based config root, same as the conftest tmp_path fixture).

import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { cleanupTmp, makeHaConfig } from './helpers';

const HOOK = join(import.meta.dir, '..', 'hooks', 'mcp-safety-gate.ts');

afterEach(cleanupTmp);

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
