// Structural lint for the /hatch skill (target-aware routing + schema
// stamping) — 1:1 port of tests/test_hatch_skill.py (27 cases).
// Grep-level checks against the skill markdown. No runtime skill execution.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const skillText = readFileSync(join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md'), 'utf8');

test('references hatch-options.json', () => {
  expect(skillText).toContain('hatch-options.json');
});

test('reads target field from hatch-options.json', () => {
  expect(/hatch-options\.json[\s\S]{0,80}["`]target["`]/.test(skillText)).toBe(true);
});

test('local target routes to CLAUDE.local.md', () => {
  expect(/["`]local["`][\s\S]{0,80}target_file = CLAUDE\.local\.md/.test(skillText)).toBe(true);
});

test('committed target routes to CLAUDE.md', () => {
  expect(/["`]committed["`][\s\S]{0,120}target_file = CLAUDE\.md/.test(skillText)).toBe(true);
});

test('schema stamps target field', () => {
  expect(/"target":\s*"/.test(skillText)).toBe(true);
});

test('schema stamps core_install_scope field', () => {
  expect(/"core_install_scope":\s*"/.test(skillText)).toBe(true);
});

test('schema stamps stamped_at field', () => {
  expect(/"stamped_at":\s*"/.test(skillText)).toBe(true);
});

test('schema stamps stamped_by field', () => {
  expect(/"stamped_by":\s*"claude-code-homeassistant-hermit:hatch"/.test(skillText)).toBe(true);
});

test('schema stamps version field', () => {
  expect(/"version":\s*"/.test(skillText)).toBe(true);
});

test('detects core_install_scope from plugin list', () => {
  expect(/core_install_scope[\s\S]{0,120}claude plugin list --json/.test(skillText)).toBe(true);
});

test('documents project-to-committed scope mapping', () => {
  expect(/`project`[^\n]{0,20}`committed`/.test(skillText)).toBe(true);
});

test('documents local/user/null-to-local scope mapping', () => {
  expect(/`local`\/`user`\/`null`[^\n]{0,40}`local`/.test(skillText)).toBe(true);
});

test('stamped version source is _hermit_versions', () => {
  // Pin the version-comparison source so a future prose edit can't silently
  // change where "stamped version" reads from.
  expect(skillText).toContain('_hermit_versions["claude-code-homeassistant-hermit"]');
});

test('skips on stamped version match', () => {
  expect(/stamped version equals plugin version[\s\S]{0,40}skip/.test(skillText)).toBe(true);
});

test('handles absent stamped version', () => {
  // Realistic upgrade case: block exists but was appended before stamping
  // was reliable. Must NOT fall into an undefined branch.
  expect(
    /stamped version null[\s\S]{0,80}stale/.test(skillText) ||
      /stamped version (absent|null)/.test(skillText),
  ).toBe(true);
});

test('marker replacement specifies closing marker', () => {
  expect(skillText).toContain('<!-- /claude-code-homeassistant-hermit: Home Assistant Workflow -->');
});

test('delegates stray-block migration to hermit-evolve', () => {
  expect(/hermit-evolve[\s\S]{0,20}Step 7/.test(skillText)).toBe(true);
});

// --- Knowledge-schema extension (Step 7.6) ---

test('has knowledge-schema extension step', () => {
  expect(skillText).toContain('Knowledge-schema extension');
});

test('knowledge-schema idempotency sentinel', () => {
  // The sentinel must appear as the actual typed bullet in the appended block,
  // not just as a backtick-quoted example in the prose description.
  expect(skillText).toContain('- analysis: HA pattern analysis');
});

test('knowledge-schema declares context', () => {
  expect(skillText).toContain('- context:');
});

test('knowledge-schema declares brief', () => {
  expect(skillText).toContain('- brief:');
});

test('knowledge-schema declares presence-report', () => {
  expect(skillText).toContain('- presence-report:');
});

test('knowledge-schema declares audit', () => {
  expect(skillText).toContain('- audit:');
});

test('knowledge-schema declares simulation', () => {
  expect(skillText).toContain('- simulation:');
});

test('knowledge-schema declares apply', () => {
  expect(skillText).toContain('- apply:');
});

test('knowledge-schema declares remove', () => {
  expect(skillText).toContain('- remove:');
});

test('knowledge-schema extension uses Edit tool', () => {
  expect(skillText).toContain('Use Edit to make the changes.');
});

test('knowledge-schema final report line', () => {
  expect(skillText).toContain('knowledge-schema.md: HA types added');
});
