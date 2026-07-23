// WP7 tier 1: tests for src/policy.ts — 1:1 port of tests/test_policy.py
// (22 cases).
//
// CLI-layer notes (cli.py is a later tier):
//   - test_policy_check_cli_entity / test_policy_check_cli_sensitive_entity
//     exercised `ha policy-check` end to end; here they pin the same
//     observable contract — checkEntity's JSON shape and the sensitive flag
//     that _handle_policy_check maps to the exit code.
//   - test_policy_check_cli_yaml_file needs simulate.collect_references
//     (tier 2) — ported as test.todo.
//
// pytest fixture mapping: make_ha_config -> makeHaConfig helper,
// monkeypatch.chdir -> process.chdir with afterEach restore.

// Whole file runs serial: process.chdir + clearPolicyCaches() mutate global
// process state that per-test dirs cannot isolate under --concurrent.
import { afterEach, expect, test as bunTest } from 'bun:test';
const test = bunTest.serial;
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Severity,
  canReloadDomain,
  checkEntity,
  classifyEntity,
  clearPolicyCaches,
  evaluateReferences,
  gateStructuralMutation,
  isSensitiveEntity,
  safetyMode,
} from '../src/policy';

const ORIGINAL_CWD = process.cwd();
const tmpDirs: string[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ha-policy-test-'));
  tmpDirs.push(dir);
  return dir;
}

function makeHaConfig(mode: string): string {
  const root = tmpPath();
  const cfgDir = join(root, '.claude-code-hermit');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.json'), `{"ha_safety_mode": "${mode}"}`);
  return root;
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  clearPolicyCaches();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('sensitive entity detection', () => {
  expect(isSensitiveEntity('lock.front_door')).toBe(true);
  expect(isSensitiveEntity('alarm_control_panel.home')).toBe(true);
  expect(isSensitiveEntity('cover.garage_door')).toBe(false);
  expect(isSensitiveEntity('light.kitchen_counter')).toBe(false);
});

test('policy blocks sensitive references', () => {
  const decision = evaluateReferences(
    ['light.kitchen', 'alarm_control_panel.home'],
    ['light.turn_on', 'lock.unlock'],
  );
  expect(decision.blocked).toBe(true);
  expect(decision.reasons).toHaveLength(2);
});

test('reload allowlist', () => {
  expect(canReloadDomain('automation')).toBe(true);
  expect(canReloadDomain('light')).toBe(false);
});

test('check_entity sensitive', () => {
  const result = checkEntity('lock.front_door');
  expect(result.sensitive).toBe(true);
  expect(result.entity_id).toBe('lock.front_door');
  expect(result.reasons.length).toBeGreaterThan(0);
});

test('check_entity safe', () => {
  const result = checkEntity('light.kitchen');
  expect(result.sensitive).toBe(false);
  expect(result.reasons).toEqual([]);
});

test('policy-check JSON contract for a safe entity (CLI port pending)', () => {
  const result = checkEntity('light.kitchen');
  expect(JSON.stringify(result, null, 2)).toContain('"sensitive": false');
  expect(result.sensitive).toBe(false); // cli.py maps this to exit code 0
});

test('policy-check JSON contract for a sensitive entity (CLI port pending)', () => {
  const result = checkEntity('lock.front_door');
  expect(JSON.stringify(result, null, 2)).toContain('"sensitive": true');
  expect(result.sensitive).toBe(true); // cli.py maps this to exit code 1
});

test('safe entity override', () => {
  const root = tmpPath();
  writeFileSync(join(root, '.env'), 'HA_SAFE_ENTITIES=lock.test_door,cover.main_gate\n');
  process.chdir(root);
  expect(isSensitiveEntity('lock.test_door')).toBe(false);
  expect(isSensitiveEntity('cover.main_gate')).toBe(false);
  expect(isSensitiveEntity('lock.other_door')).toBe(true); // no regression on unlisted entities
});

test('extra sensitive domain', () => {
  const root = tmpPath();
  writeFileSync(join(root, '.env'), 'HA_EXTRA_SENSITIVE_DOMAINS=vacuum\n');
  process.chdir(root);
  expect(isSensitiveEntity('vacuum.roomba')).toBe(true);
  expect(isSensitiveEntity('light.kitchen')).toBe(false); // no regression
});

test('safety mode defaults to strict', () => {
  expect(safetyMode(tmpPath())).toBe('strict');
});

test('safety mode reads ask from config', () => {
  expect(safetyMode(makeHaConfig('ask'))).toBe('ask');
});

test('safety mode invalid value defaults to strict', () => {
  expect(safetyMode(makeHaConfig('bogus'))).toBe('strict');
});

test('safety mode permissive no longer valid', () => {
  // `permissive` was removed in favour of two-tier strict/ask. Falls back to strict.
  expect(safetyMode(makeHaConfig('permissive'))).toBe('strict');
});

test('gate blocks structural mutation under strict (default)', () => {
  const gate = gateStructuralMutation(tmpPath());
  expect(gate.allowed).toBe(false);
  expect(gate.requiresConfirm).toBe(false);
  expect(gate.mode).toBe('strict');
  expect(gate.reason).toContain('proposal');
});

test('gate under ask requires confirmation', () => {
  const root = makeHaConfig('ask');
  const unconfirmed = gateStructuralMutation(root, false);
  expect(unconfirmed.allowed).toBe(false);
  expect(unconfirmed.requiresConfirm).toBe(true);
  const confirmed = gateStructuralMutation(root, true);
  expect(confirmed.allowed).toBe(true);
  expect(confirmed.requiresConfirm).toBe(false);
});

test('classify strict blocks sensitive', () => {
  const root = makeHaConfig('strict');
  const [sev, reasons] = classifyEntity('alarm_control_panel.home', root);
  expect(sev).toBe(Severity.BLOCK);
  expect(reasons.length).toBeGreaterThan(0);
});

test('classify ask returns ask severity', () => {
  const root = makeHaConfig('ask');
  const [sev, reasons] = classifyEntity('alarm_control_panel.home', root);
  expect(sev).toBe(Severity.ASK);
  expect(reasons.length).toBeGreaterThan(0);
});

test('safe entity allowlist wins over strict', () => {
  const root = makeHaConfig('strict');
  writeFileSync(join(root, '.env'), 'HA_SAFE_ENTITIES=alarm_control_panel.home\n');
  process.chdir(root);
  const [sev] = classifyEntity('alarm_control_panel.home', root);
  expect(sev).toBe(Severity.ALLOW);
});

test('evaluate_references severity field', () => {
  const root = makeHaConfig('ask');
  const decision = evaluateReferences(['alarm_control_panel.home'], [], root);
  expect(decision.severity).toBe(Severity.ASK);
  expect(decision.blocked).toBe(false);
});

test('check_entity includes severity', () => {
  const result = checkEntity('light.kitchen');
  expect(result).toHaveProperty('severity');
  expect(result.severity).toBe('allow');
});

bunTest.todo('policy-check CLI on a YAML file (needs simulate.collect_references — tier 2)', () => {
  throw new Error('cli.py policy-check and simulate.collect_references are not ported yet');
});
