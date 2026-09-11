// Knowledge-placement static consistency test.
//
// The placement rule (settled operator knowledge gets one authoritative home)
// spans six prose surfaces: the CLAUDE-APPEND trigger, reflect's step-3b matcher
// and branch routing, the eval-runner ownership signal, and the judge/triage
// gate exceptions. These pins hold the vocabulary consistent across them — a
// rename or trim on one surface that orphans the others fails here instead of
// silently breaking the pipeline. Same style as recurrence-gate-matrix.test.ts:
// prose-pinning is the house norm for skill/agent text (script behavior gets
// subprocess tests; see tests/scripts.test.ts `observations.ts observe`).

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const read = (...p: string[]) => fs.readFileSync(path.join(PLUGIN_ROOT, ...p), 'utf8');

const append = read('state-templates', 'CLAUDE-APPEND.md');
const reflectSkill = read('skills', 'reflect', 'SKILL.md');
const branches = read('skills', 'reflect', 'branches.md');
const reference = read('skills', 'reflect', 'reference.md');
const judge = read('agents', 'reflection-judge.md');
const triage = read('agents', 'proposal-triage.md');
const proposalCreate = read('skills', 'proposal-create', 'SKILL.md');

describe('CLAUDE-APPEND placement trigger', () => {
  const pins = [
    'Settled knowledge gets one authoritative home',
    // The exact fallback-row call form — written outside any skill context, so
    // the always-loaded block is its only carrier. That is also why it routes
    // through bin/hermit-run: `${CLAUDE_PLUGIN_ROOT}` is substituted at skill
    // load and never in the operator's CLAUDE.md, so the plugin-cache spelling
    // left the model hand-deriving a path here.
    'hermit-run observations observe .claude-code-hermit skill-preference-applied',
    'skill-preference:<skill>',
    // A hermit-proposed behavior the operator accepts is settled the same way;
    // the write-before-confirm order is what keeps it from dying at the next
    // daily clear as an unwritten promise.
    'standing behavior you proposed: write it to its home first',
    'Never confirm a standing rule you have not written',
    'Never write settled content into OPERATOR.md',
  ];
  for (const p of pins) {
    test(`contains: ${p}`, () => {
      expect(append.includes(p)).toBe(true);
    });
  }
});

describe('reflect routing (step 3b + branches)', () => {
  test('step 3b dispatches skill-preference labels', () => {
    expect(reflectSkill.includes('skill-preference:<name>')).toBe(true);
  });

  // The promotion rules — the unknown-session sentinel, the session threshold, the
  // graduation cursor, and dropping applied-preference telemetry — are
  // `observations.ts graduate`'s, pinned in tests/observations-graduate.test.ts.
  // The skill's remaining share is calling it and stamping the cursor afterwards.
  test('step 3b promotes through the observations verb and still stamps the cursor', () => {
    expect(reflectSkill.includes('observations.ts graduate .claude-code-hermit')).toBe(true);
    expect(reflectSkill.includes('--graduation-cursor')).toBe(true);
  });

  test('branches.md carries the skill-preference routing section', () => {
    expect(branches.includes('## `skill-preference:*` routing')).toBe(true);
    expect(branches.includes('telemetry of settlements already applied')).toBe(true);
  });

  test('skill-preference branches on whether the skill exists, never on its class', () => {
    // an override does not shadow the plugin skill it overrides: both appear in the
    // available-skills list (probed), so a class test here can never separate them.
    // Existence is the question reflect can answer; proposal-act resolves the class at
    // accept, against the filesystem and list as they are then.
    expect(branches.includes('- **A skill named `<name>` exists**')).toBe(true);
    expect(branches.includes('`proposal-act` resolves the class once at accept')).toBe(true);
    expect(branches.includes('installed plugin skill')).toBe(false);
  });

  test('skill-preference keeps an unreadable list out of both established branches', () => {
    // no `skill_listing` is re-injected after a compaction, so an absent list is unknown,
    // not empty. Emitting `## Skill Improvement` there would let a `<name>` that is an
    // output slug reach accept as an authoring instruction and create a skill at that
    // name, bypassing the Preference ladder's extend-before-create rule.
    expect(branches.includes('- **Neither is established**')).toBe(true);
    expect(branches.includes('asserting neither that a skill owns the output nor that none does')).toBe(true);
    expect(branches.includes('Never a `## Skill Improvement` here')).toBe(true);
  });

  test('Tier 2/3 recurrence baseline names the ledger-graduation exception', () => {
    expect(branches.includes('satisfy recurrence via the `Artifact: state/observations.jsonl` rule')).toBe(true);
  });

  test('evidence-integrity invariant names settled-memory as the sanctioned exception', () => {
    expect(branches.includes('Evidence Source: settled-memory')).toBe(true);
  });
});

describe('eval-runner ownership signal', () => {
  test('reference.md Step 3 carries the signal with its two emit-nothing guards', () => {
    expect(reference.includes('**Ownership signal:**')).toBe(true);
    expect(reference.includes('"settled-memory"')).toBe(true);
    expect(reference.includes('pointer-form memories')).toBe(true);
    expect(reference.slice(reference.indexOf('**Ownership signal:**'), reference.indexOf('## Return Value'))).toContain('[role');
  });
});

describe('gate handling of settled-memory candidates', () => {
  test('judge dispatches the class with a mandatory quote check', () => {
    expect(judge.includes('Evidence Source: settled-memory')).toBe(true);
    expect(judge.includes('quoted endpoint not found in cited memory file')).toBe(true);
    expect(judge.includes('ACCEPT (settled-memory): <title>')).toBe(true);
  });

  test('triage skips recurrence for the class and carries the consolidation exception', () => {
    expect(triage.includes('settled-memory')).toBe(true);
    expect(triage.includes('**Consolidation exception:**')).toBe(true);
    // the exception must end by deferring, never by unconditionally suppressing
    expect(triage.includes('apply the normal Step 1.5 test')).toBe(true);
  });

  test('triage 1.5 exempts consolidation candidates from covered-by-memory', () => {
    expect(triage.includes('the memory records the decision; the candidate targets where the operative content lives')).toBe(true);
  });
});

describe('proposal-create Do-NOT list routes the class correctly', () => {
  test('style preferences go to memory, relocation is a valid proposal, OPERATOR.md is not a destination', () => {
    expect(proposalCreate.includes('valid consolidation proposal')).toBe(true);
    expect(proposalCreate.includes('never propose OPERATOR.md as a destination')).toBe(true);
  });
});
