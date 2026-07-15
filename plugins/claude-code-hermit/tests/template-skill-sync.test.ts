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
// Nested artifacts.* keys — the top-level-key check above only asserts
// `artifacts` itself appears in hatch/SKILL.md (satisfied since it's a
// template-only field), which does NOT catch a nested key like `proposals`
// or `weekly_review` going unreferenced anywhere an operator would find it.
// -------------------------------------------------------
describe('nested artifacts.* keys are referenced in operator-facing docs', () => {
  const HERMIT_SETTINGS_PATH = path.join(PLUGIN_ROOT, 'skills', 'hermit-settings', 'SKILL.md');
  const ARTIFACTS_DOC_PATH = path.join(PLUGIN_ROOT, 'docs', 'artifacts.md');

  let artifactsKeys: string[] = [];
  try {
    const tmpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));
    artifactsKeys = Object.keys(tmpl.artifacts ?? {});
  } catch {
    // Leave empty — the guard test below fails loud.
  }

  test('could parse artifacts keys from template', () => {
    expect(artifactsKeys.length).toBeGreaterThan(0);
  });

  const hermitSettingsContent = fs.readFileSync(HERMIT_SETTINGS_PATH, 'utf-8');
  const artifactsDocContent = fs.readFileSync(ARTIFACTS_DOC_PATH, 'utf-8');

  for (const key of artifactsKeys) {
    test(`config.artifacts.${key} is referenced in hermit-settings/SKILL.md`, () => {
      expect(hermitSettingsContent).toContain(`artifacts.${key}`);
    });

    test(`config.artifacts.${key} is referenced in docs/artifacts.md`, () => {
      expect(artifactsDocContent).toContain(`artifacts.${key}`);
    });
  }
});

// -------------------------------------------------------
// Deny-patterns template file referenced in hatch/SKILL.md
// -------------------------------------------------------
describe('deny-patterns template', () => {
  test('deny-patterns.json exists', () => {
    expect(fs.existsSync(DENY_PATTERNS_PATH)).toBe(true);
  });

  test('hatch/SKILL.md references deny-patterns.json', () => {
    expect(skillContent).toContain('deny-patterns.json');
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

  test('doctor has model: haiku', () => {
    const entry = routines.find((r: any) => r.id === 'doctor');
    expect(entry).toBeTruthy();
    expect(entry.model).toBe('haiku');
  });

  test('no other default routine carries a model field', () => {
    const ALLOWED_WITH_MODEL = new Set(['daily-auto-close', 'doctor']);
    const withModel = routines.filter((r: any) => !ALLOWED_WITH_MODEL.has(r.id) && r.model !== undefined);
    expect(withModel).toEqual([]);
  });
});
