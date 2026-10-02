// Structural lint for the /hatch skill, HA-specific checks only. The shared
// domain-hatch protocol (verbs, stamping, markers, no restated core rules) is
// asserted for every domain plugin by the repo-root cross-plugin contract test
// (tests/cross-plugin/domain-hatch.contract.test.ts) — nothing here may
// duplicate it. Grep-level checks against the skill markdown. No runtime skill
// execution.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const skillText = readFileSync(join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md'), 'utf8');

test('defers version-driven block refresh to hermit-evolve', () => {
  // The old hatch re-rendered the block whenever the stamped version differed.
  // hermit-evolve owns that now; hatch appends when absent and skips otherwise.
  expect(/Refreshing an existing block on a version bump is `hermit-evolve`'s job/.test(skillText)).toBe(
    true,
  );
});

test('delegates stray-block migration to hermit-evolve', () => {
  expect(/hermit-evolve[\s\S]{0,20}Step 7/.test(skillText)).toBe(true);
});

// --- Knowledge-schema extension (Step 6.6) ---

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
