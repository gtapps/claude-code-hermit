// Static pins for the pinned-root gate contract: triage and the judge must
// read every source from an Anchor: line, fail closed when blind, and never
// glob a relative `.hermit/` path. Callers must paste that line.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const read = (...p: string[]) => fs.readFileSync(path.join(PLUGIN_ROOT, ...p), 'utf8');

const triage = read('agents', 'proposal-triage.md');
const judge = read('agents', 'reflection-judge.md');
const proposalCreate = read('skills', 'proposal-create', 'SKILL.md');
const branches = read('skills', 'reflect', 'branches.md');
const reflectSkill = read('skills', 'reflect', 'SKILL.md');

describe('anchor contract pins', () => {
  for (const [label, body] of [
    ['proposal-triage.md', triage],
    ['reflection-judge.md', judge],
  ] as const) {
    test(`${label} requires Anchor:, GATE_BLIND, config.json and no relative hermit path`, () => {
      expect(body).toContain('Anchor:');
      expect(body).toContain('GATE_BLIND');
      expect(body).toContain('config.json');
      expect(body).not.toContain('.hermit/');
    });
  }

  test('proposal-triage.md greps the index, never PROP-*.md', () => {
    expect(triage).toContain('proposals-index.json');
    expect(triage).not.toContain('PROP-*.md');
  });

  for (const [label, body] of [
    ['proposal-create/SKILL.md', proposalCreate],
    ['reflect/branches.md', branches],
    ['reflect/SKILL.md', reflectSkill],
  ] as const) {
    test(`${label} carries Anchor:`, () => {
      expect(body).toContain('Anchor:');
    });
  }
});
