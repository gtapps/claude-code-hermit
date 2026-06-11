// WP7 tier 3: tests for src/simulate.ts — 1:1 port of tests/test_simulate.py
// (4 cases).

import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Severity, clearPolicyCaches } from '../src/policy';
import { evaluateYamlPolicy, simulateArtifact } from '../src/simulate';
import { cleanupTmp, makeHaConfig, makeHaRoot, writeArtifact } from './helpers';

afterEach(() => {
  cleanupTmp();
  clearPolicyCaches();
});

const ARTIFACT_YAML = `alias: Test
actions:
  - service: light.turn_on
    target:
      entity_id: light.kitchen_counter
  - service: cover.open_cover
    target:
      entity_id: cover.garage_door`;

const ALARM_YAML = `alias: Disarm
actions:
  - service: alarm_control_panel.alarm_disarm
    target:
      entity_id: alarm_control_panel.home`;

const LOCK_YAML = `alias: Unlock
actions:
  - service: lock.unlock
    target:
      entity_id: lock.front_door`;

test('simulation reports missing and sensitive entities', () => {
  const root = makeHaRoot({
    entity_index: {
      'light.kitchen_counter': { entity_id: 'light.kitchen_counter', state: 'off' },
    },
  });
  const artifact = writeArtifact(root, ARTIFACT_YAML, 'artifact.yaml');

  const result = simulateArtifact(root, artifact);

  expect(result.isValid).toBe(false);
  expect(result.missingEntities).toContain('cover.garage_door');
  expect(result.blockedReasons.some((reason) => reason.includes('cover.garage_door'))).toBe(true);
});

test('simulation valid under ask mode with sensitive entity', () => {
  const root = makeHaRoot({
    entity_index: {
      'alarm_control_panel.home': { entity_id: 'alarm_control_panel.home', state: 'armed_away' },
    },
  });
  writeFileSync(join(root, '.claude-code-hermit', 'config.json'), '{"ha_safety_mode": "ask"}');
  const artifact = writeArtifact(root, ALARM_YAML, 'disarm.yaml');

  const result = simulateArtifact(root, artifact);

  expect(result.isValid).toBe(true);
  expect(result.policyBlocked).toBe(false);
  expect(result.blockedReasons.some((r) => r.includes('alarm_control_panel.home'))).toBe(true);
});

test('simulation invalid under strict mode with sensitive entity', () => {
  const root = makeHaRoot({
    entity_index: {
      'lock.front_door': { entity_id: 'lock.front_door', state: 'locked' },
    },
  });
  const artifact = writeArtifact(root, LOCK_YAML, 'unlock.yaml');

  const result = simulateArtifact(root, artifact);

  expect(result.isValid).toBe(false);
  expect(result.policyBlocked).toBe(true);
});

test('evaluate_yaml_policy honors project safety mode', () => {
  const root = makeHaConfig('ask');
  const artifact = writeArtifact(root, ALARM_YAML, 'disarm.yaml');

  const [, , decision] = evaluateYamlPolicy(artifact, root);

  expect(decision.blocked).toBe(false);
  expect(decision.severity).toBe(Severity.ASK);
});
