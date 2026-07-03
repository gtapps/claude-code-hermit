// Guards the token-efficiency trim of the HA CLAUDE-APPEND block.
//
// The block is injected into every hatched operator project's CLAUDE.md and is
// re-paid on every session load and subagent dispatch. The skills/subagents/CLI
// catalogs that used to live here duplicated content already carried by each
// SKILL.md/agent description and by `ha-agent-lab --help`, so they were removed
// in favor of a self-advertise pointer + docs/cli-reference.md. This test keeps
// the catalogs from creeping back and ensures the CLI reference doc exists.

import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_ROOT = join(import.meta.dir, '..');
const APPEND = readFileSync(join(PLUGIN_ROOT, 'state-templates', 'CLAUDE-APPEND.md'), 'utf8');

test('HA APPEND carries no skills/subagents/tool catalog tables', () => {
  expect(/^\|\s*Skill\s*\|/m.test(APPEND)).toBe(false);
  expect(/^\|\s*Agent\s*\|/m.test(APPEND)).toBe(false);
  expect(/^\|\s*Tool\s*\|/m.test(APPEND)).toBe(false);
});

test('HA APPEND self-advertises instead of cataloging', () => {
  expect(APPEND.includes('self-advertise through their own SKILL.md')).toBe(true);
  expect(APPEND.includes('ha-boot')).toBe(true);
});

test('HA APPEND points to the relocated CLI reference, which exists', () => {
  expect(APPEND.includes('docs/cli-reference.md')).toBe(true);
  expect(existsSync(join(PLUGIN_ROOT, 'docs', 'cli-reference.md'))).toBe(true);
});

test('HA APPEND stays under the post-trim ceiling', () => {
  // Pre-trim was 9,565 B; trimmed to ~5,076 B.
  expect(Buffer.byteLength(APPEND, 'utf8')).toBeLessThanOrEqual(5500);
});
