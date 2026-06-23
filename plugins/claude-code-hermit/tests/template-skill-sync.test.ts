// Template-skill sync test. (bun test port of test-template-skill-sync.sh)
//
// Asserts every top-level key in state-templates/config.json.template appears
// somewhere in skills/hatch/SKILL.md. Hatch overlays operator choices onto the
// template; if a new field is added to the template but never referenced in
// hatch's text, Quick mode silently drops it from operator configs.
//
// Scope: monorepo-internal only. Verifies that two of OUR shipping files stay
// in sync with each other. Does NOT enforce a schema on operator-owned
// .claude-code-hermit/config.json — operators can add custom keys, remove
// fields, or hand-edit anytime. The test never reads operator state.
//
// Usage: bun test tests/template-skill-sync.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template');
const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md');
const SANDBOX_PROFILES_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'sandbox-profiles.json');
const DENY_PATTERNS_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'deny-patterns.json');
const WORKTREEINCLUDE_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'WORKTREEINCLUDE-APPEND.txt');

test('template file exists', () => {
  expect(fs.existsSync(TEMPLATE_PATH)).toBe(true);
});

test('skill file exists', () => {
  expect(fs.existsSync(SKILL_PATH)).toBe(true);
});

// Extract top-level keys from the template (bash used a python3 JSON walk).
let templateKeys: string[] = [];
try {
  templateKeys = Object.keys(JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8')));
} catch {
  // Leave empty — the guard test below fails loud.
}

test('could parse top-level keys from template', () => {
  expect(templateKeys.length).toBeGreaterThan(0);
});

const skillContent = fs.readFileSync(SKILL_PATH, 'utf-8');

// For each top-level key, assert it appears at least once in the skill text.
// We check for the bare key name — if the skill mentions it (in the overlay
// table, in prose, in code blocks), the key is "known" to hatch.
describe('hatch SKILL.md references every template key', () => {
  for (const key of templateKeys) {
    test(`skill references key '${key}' from template`, () => {
      expect(skillContent).toContain(key);
    });
  }
});

// -------------------------------------------------------
// Sandbox template files referenced in hatch/SKILL.md
// -------------------------------------------------------
describe('sandbox templates', () => {
  test('sandbox-profiles.json exists', () => {
    expect(fs.existsSync(SANDBOX_PROFILES_PATH)).toBe(true);
  });

  test('deny-patterns.json exists', () => {
    expect(fs.existsSync(DENY_PATTERNS_PATH)).toBe(true);
  });

  test('hatch/SKILL.md references sandbox-profiles.json', () => {
    expect(skillContent).toContain('sandbox-profiles.json');
  });

  test('hatch/SKILL.md references deny-patterns.json sandbox section', () => {
    expect(skillContent).toContain('deny-patterns.json');
  });

  test('deny-patterns.json has sandbox.filesystem.denyRead section', () => {
    const d = JSON.parse(fs.readFileSync(DENY_PATTERNS_PATH, 'utf-8'));
    expect(d).toHaveProperty('sandbox');
    expect(d.sandbox).toHaveProperty('filesystem');
    expect(d.sandbox.filesystem).toHaveProperty('denyRead');
  });
});

// -------------------------------------------------------
// .worktreeinclude template
// -------------------------------------------------------
describe('.worktreeinclude template', () => {
  test('WORKTREEINCLUDE-APPEND.txt exists', () => {
    expect(fs.existsSync(WORKTREEINCLUDE_PATH)).toBe(true);
  });

  test('hatch/SKILL.md references WORKTREEINCLUDE-APPEND.txt', () => {
    expect(skillContent).toContain('WORKTREEINCLUDE-APPEND.txt');
  });

  test('template only contains the two allowed paths (safety-invariant: no runtime state)', () => {
    const raw = fs.readFileSync(WORKTREEINCLUDE_PATH, 'utf-8');
    const effectiveLines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(effectiveLines).toEqual([
      '.claude-code-hermit/OPERATOR.md',
      '.claude-code-hermit/compiled/',
    ]);
  });
});

// -------------------------------------------------------
// apply-settings.ts HERMIT_ALLOW <-> hatch/SKILL.md Step 8 allow-list
// -------------------------------------------------------
describe('hatch allow-list sync', () => {
  const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'apply-settings.ts');

  function extractHermitAllow(): string[] {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf-8');
    const m = src.match(/const HERMIT_ALLOW\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) throw new Error('HERMIT_ALLOW not found in apply-settings.ts');
    return eval(m[1]) as string[];
  }

  function extractSkillAllow(): string[] {
    for (const block of skillContent.matchAll(/```json\n([\s\S]*?)```/g)) {
      try {
        const parsed = JSON.parse(block[1]);
        if (parsed?.permissions?.allow) return parsed.permissions.allow as string[];
      } catch {
        // non-JSON or unrelated JSON block — keep scanning
      }
    }
    throw new Error('Step 8 allow-list JSON block not found in hatch/SKILL.md');
  }

  test('HERMIT_ALLOW matches hatch/SKILL.md Step 8 allow-list', () => {
    expect(extractHermitAllow()).toEqual(extractSkillAllow());
  });
});

// -------------------------------------------------------
// Routine model defaults
// -------------------------------------------------------
describe('routine model defaults', () => {
  let routines: any[] = [];
  try {
    routines = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8')).routines || [];
  } catch {}

  test('daily-auto-close has model: haiku', () => {
    const entry = routines.find((r: any) => r.id === 'daily-auto-close');
    expect(entry).toBeTruthy();
    expect(entry.model).toBe('haiku');
  });

  test('no other default routine carries a model field', () => {
    const withModel = routines.filter((r: any) => r.id !== 'daily-auto-close' && r.model !== undefined);
    expect(withModel).toEqual([]);
  });
});
