// Structural lint for the /ha-setup-house skill.
// Grep-level checks against the skill markdown. No runtime skill execution.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const skillPath = join(PLUGIN_ROOT, 'skills', 'ha-setup-house', 'SKILL.md');
const skillText = readFileSync(skillPath, 'utf8');

test('has valid frontmatter name', () => {
  expect(skillText).toContain('name: ha-setup-house');
});

test('has description', () => {
  expect(/^description: .+/m.test(skillText)).toBe(true);
});

test('references list-areas', () => {
  expect(skillText).toContain('ha list-areas');
});

test('references list-entities --registry', () => {
  expect(skillText).toContain('ha list-entities --registry');
});

test('references list-devices', () => {
  expect(skillText).toContain('ha list-devices');
});

test('references list-helpers', () => {
  expect(skillText).toContain('ha list-helpers');
});

test('references create-area', () => {
  expect(skillText).toContain('ha create-area');
});

test('references set-entity-area', () => {
  expect(skillText).toContain('ha set-entity-area');
});

test('references set-device-area', () => {
  expect(skillText).toContain('ha set-device-area');
});

test('references create-helper', () => {
  expect(skillText).toContain('ha create-helper');
});

test('references all 8 helper types', () => {
  const types = ['input_boolean', 'input_number', 'input_text', 'input_select', 'input_datetime', 'timer', 'counter', 'schedule'];
  for (const t of types) {
    expect(skillText).toContain(t);
  }
});

test('delegates automation scaffolding to ha-build-automation', () => {
  expect(skillText).toContain('ha-build-automation');
});

test('references refresh-context after changes', () => {
  expect(skillText).toContain('ha refresh-context');
});

test('documents ha_safety_mode gating', () => {
  expect(skillText).toContain('ha_safety_mode');
});

test('documents --confirm flag for writes', () => {
  expect(skillText).toContain('--confirm');
});

test('documents blocked/requires_confirm result handling', () => {
  expect(skillText).toContain('requires_confirm');
  expect(skillText).toContain('blocked');
});

test('hatch skill references ha-setup-house', () => {
  const hatchText = readFileSync(join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md'), 'utf8');
  expect(hatchText).toContain('ha-setup-house');
});
