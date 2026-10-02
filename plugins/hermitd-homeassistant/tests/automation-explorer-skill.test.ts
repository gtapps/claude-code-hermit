// Structural lint for the /ha-automation-explorer skill — 1:1 port of
// tests/test_automation_explorer_skill.py (3 cases).
// Grep-level checks against the skill markdown. Guards the no-redundancy
// contract with ha-analyze-patterns (Mode 3 must consume silence_summary,
// not re-derive from fetch-history).

import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const SKILL = join(PLUGIN_ROOT, 'skills', 'ha-automation-explorer', 'SKILL.md');

test('skill file exists', () => {
  expect(existsSync(SKILL)).toBe(true);
});

test('references get-automation-config', () => {
  expect(readFileSync(SKILL, 'utf8')).toContain('get-automation-config');
});

test('references silence_summary', () => {
  expect(readFileSync(SKILL, 'utf8')).toContain('silence_summary');
});
