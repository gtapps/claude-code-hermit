// hatch-options.json contract test. (bun test port of test-hatch-options-contract.sh)
//
// Asserts:
// 1. state-templates/GITIGNORE-APPEND.txt contains the new local-file entries.
// 2. Every consumer of hatch-options.json references the same canonical path
//    AND the "target" field name. Catches regressions like a typo in a path
//    (.claude-code-hermit/state/hatch-options.json) or renaming the field
//    in one consumer without updating the others.
//
// Scope: monorepo-internal. Reads two of OUR shipping files and the
// sibling dev-hermit skill.
//
// Usage: bun test tests/hatch-options-contract.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

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
});

// Producer + readers in core.
const CORE_CONSUMERS = [
  'skills/hatch/SKILL.md',
  // hermit-evolve's hatch-options read lives in reference.md (step 1), read only
  // by the evolve-runner subagent — SKILL.md is a thin routing stub.
  'skills/hermit-evolve/reference.md',
  'skills/docker-setup/SKILL.md',
  'skills/migrate/SKILL.md',
];

for (const rel of CORE_CONSUMERS) {
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

// Sibling plugin: dev-hermit's hatch reads the same state file.
describe('dev-hermit:hatch', () => {
  const devHatch = path.join(PLUGIN_ROOT, '..', 'claude-code-dev-hermit', 'skills', 'hatch', 'SKILL.md');

  test('dev-hermit:hatch skill exists', () => {
    expect(fs.existsSync(devHatch)).toBe(true);
  });

  const content = fs.readFileSync(devHatch, 'utf-8');

  test(`dev-hermit:hatch references ${CANONICAL_PATH}`, () => {
    expect(content).toContain(CANONICAL_PATH);
  });

  test(`dev-hermit:hatch references ${TARGET_KEY} field`, () => {
    expect(content).toContain(TARGET_KEY);
  });
});
