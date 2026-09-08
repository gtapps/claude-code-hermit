// hatch-options.json contract test. (bun test port of test-hatch-options-contract.sh)
//
// Asserts:
// 1. state-templates/GITIGNORE-APPEND.txt contains the new local-file entries.
// 2. Skills that still open hatch-options.json themselves reference the same
//    canonical path AND the "target" field name — catching a path typo or a
//    field rename in one reader but not the others.
// 3. Skills that delegate to scripts/domain-hatch.ts route through it and do
//    NOT carry a second copy of the precedence rules or the stamp schema.
//
// Domain-plugin hatches are covered by tests/cross-plugin/, not here: that
// suite discovers them from the filesystem instead of a hardcoded list, which
// is how feed-hermit went untested in the sibling checks this file used to do.
//
// Scope: monorepo-internal. Reads OUR shipping files only.
//
// Usage: bun test tests/hatch-options-contract.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';
import { PROTECTED_FILES } from '../scripts/settings-gate';

const CANONICAL_PATH = '.claude-code-hermit/state/hatch-options.json';
const TARGET_KEY = '"target"';

describe('GITIGNORE-APPEND.txt', () => {
  const gitignorePath = path.join(PLUGIN_ROOT, 'state-templates', 'GITIGNORE-APPEND.txt');

  test('GITIGNORE-APPEND.txt exists', () => {
    expect(fs.existsSync(gitignorePath)).toBe(true);
  });

  const lines = fs.readFileSync(gitignorePath, 'utf-8').split('\n');

  test('GITIGNORE-APPEND.txt lists CLAUDE.local.md', () => {
    expect(lines).toContain('CLAUDE.local.md');
  });

  test('GITIGNORE-APPEND.txt lists .claude/settings.local.json', () => {
    expect(lines).toContain('.claude/settings.local.json');
  });

  // Derived from the settings gate's own list rather than spelled out here:
  // a file sensitive enough to need a native prompt on edit is sensitive
  // enough not to be committed, and claude-settings.json carries an operator
  // `env` block. RESIDENT.md and claude-settings.json both shipped unignored,
  // the second time a new hermit-dir file missed this template, so the check
  // now tracks the list instead of the two names that happened to be missing.
  test('GITIGNORE-APPEND.txt lists every settings-gate protected file', () => {
    for (const name of PROTECTED_FILES) {
      expect(lines).toContain(`.claude-code-hermit/${name}`);
    }
  });
});

// Plain readers: these skills still open the file themselves, so they must keep
// naming the canonical path and the field.
const DIRECT_READERS = [
  'skills/docker-setup/SKILL.md',
];

for (const rel of DIRECT_READERS) {
  describe(rel, () => {
    const file = path.join(PLUGIN_ROOT, rel);

    test(`${rel} exists`, () => {
      expect(fs.existsSync(file)).toBe(true);
    });

    const content = fs.readFileSync(file, 'utf-8');

    test(`${rel} references ${CANONICAL_PATH}`, () => {
      expect(content).toContain(CANONICAL_PATH);
    });

    test(`${rel} references ${TARGET_KEY} field`, () => {
      expect(content).toContain(TARGET_KEY);
    });
  });
}

// Delegating consumers: hatch and hermit-evolve no longer resolve or stamp the
// target themselves — scripts/domain-hatch.ts owns it, so both must route
// through it and neither may carry a second copy of the rules. A skill that
// re-inlines the precedence prose here is the drift this test exists to catch.
const DELEGATORS: Array<{ rel: string; verb: string }> = [
  { rel: 'skills/hatch/SKILL.md', verb: 'ensure-target' },
  // hermit-evolve's hatch-options read lives in reference.md (step 1), read only
  // by the evolve-runner subagent — SKILL.md is a thin routing stub.
  { rel: 'skills/hermit-evolve/reference.md', verb: 'preflight' },
];

for (const { rel, verb } of DELEGATORS) {
  describe(rel, () => {
    const file = path.join(PLUGIN_ROOT, rel);

    test(`${rel} exists`, () => {
      expect(fs.existsSync(file)).toBe(true);
    });

    const content = fs.readFileSync(file, 'utf-8');

    test(`${rel} invokes domain-hatch.ts ${verb}`, () => {
      expect(content).toContain('domain-hatch.ts');
      expect(content).toContain(verb);
    });

    test(`${rel} does not restate the scope-precedence rules`, () => {
      expect(content).not.toMatch(/precedence[\s\S]{0,80}`?local`?[\s\S]{0,40}`?project`?[\s\S]{0,40}`?user`?/);
    });

    test(`${rel} does not restate the five-field stamp schema`, () => {
      expect(content).not.toMatch(/"stamped_by":\s*"/);
    });
  });
}
