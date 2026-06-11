// Structural lint for the /domain-brainstorm skill — 1:1 port of
// tests/test_domain_brainstorm_skill.py (16 cases).
// Grep-level checks against the skill markdown. No runtime skill execution.
// Guards:
//   - 5-gate structure (Gate 0..4)
//   - contract references (Evidence Source, category, metrics emit with
//     per-plugin skill name)
//   - boundary: suppression artifacts appear under a suppression framing,
//     not as idea sources

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const skillText = readFileSync(
  join(PLUGIN_ROOT, 'skills', 'domain-brainstorm', 'SKILL.md'),
  'utf8',
);
const EXPECTED_GATES = 5;

const parts = skillText.split('---');
const skillBody = parts.length >= 3 ? parts.slice(2).join('---') : '';

function frontmatter(): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of (parts[1] ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon !== -1) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fields;
}

// --- File and frontmatter ---

test('skill file has frontmatter', () => {
  expect(parts.length >= 3).toBe(true);
});

test('frontmatter has name', () => {
  expect(frontmatter().name).toBe('domain-brainstorm');
});

test('frontmatter has description', () => {
  const desc = frontmatter().description ?? '';
  expect(desc.length).toBeGreaterThan(20);
});

// --- Gate structure ---

test('gate count', () => {
  const gates = skillBody.match(/^### Gate \d+ —/gm) ?? [];
  expect(gates.length).toBe(EXPECTED_GATES);
});

test('gate 0 present', () => {
  expect(/^### Gate 0 —/m.test(skillBody)).toBe(true);
});

test('gate 4 present', () => {
  expect(/^### Gate 4 —/m.test(skillBody)).toBe(true);
});

// --- Contract references ---

test('evidence source capability-brainstorm', () => {
  expect(skillBody).toContain('Evidence Source: capability-brainstorm');
});

test('category improvement', () => {
  expect(skillBody).toContain('category: improvement');
});

test('metrics emit type', () => {
  expect(skillBody).toContain('brainstorm-emit');
});

test('metrics emit skill value', () => {
  // Must use the HA-specific skill name so brainstorm-emit rows stay
  // attributable to this plugin if other brainstorm skills ever share
  // proposal-metrics.jsonl.
  expect(skillBody).toContain('ha-domain-brainstorm');
});

test('prefix automation-gap', () => {
  expect(skillBody).toContain('[automation-gap]');
});

test('prefix coverage-asymmetry', () => {
  expect(skillBody).toContain('[coverage-asymmetry]');
});

test('prefix unbuilt-intent', () => {
  expect(skillBody).toContain('[unbuilt-intent]');
});

// --- Boundary guard: suppression framing ---
// Gate 0 legitimately reads integration-health-degraded-domains.json and
// pattern-analysis as SUPPRESSION FILTERS. The assertion is positive (they
// appear in a suppression context), not negative (absence of a term).

test('integration-health appears in suppression context', () => {
  expect(skillBody).toContain('integration-health-degraded-domains.json');
  const idx = skillBody.indexOf('integration-health-degraded-domains.json');
  const window = skillBody.slice(Math.max(0, idx - 300), idx + 300).toLowerCase();
  expect(
    ['suppress', 'skip', 'exclude', 'filter'].some((kw) => window.includes(kw)),
  ).toBe(true);
});

test('no proposal-create call in gate 0', () => {
  // Gate 0 must not invoke proposal-create — that belongs to Gate 2.
  const gate0Match = /### Gate 0 —([\s\S]+?)### Gate 1 —/.exec(skillBody);
  expect(gate0Match).not.toBeNull();
  expect(gate0Match![1]).not.toContain('proposal-create');
});
