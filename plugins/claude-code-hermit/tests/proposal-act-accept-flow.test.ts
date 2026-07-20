// Regression: proposal-act Accept Flow lists all three implementation options.
// (bun test port of test-proposal-act-accept-flow.sh)
//
// Guards against losing any branch or the description tweak in a future edit.
//
// Usage: bun test tests/proposal-act-accept-flow.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'proposal-act', 'SKILL.md');
const TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'PROPOSAL.md.template');

const skill = fs.readFileSync(SKILL_PATH, 'utf-8');

// Lines strictly between the opening --- and the second --- (awk '/^---$/{c++; next} c==1').
function frontmatterOf(content: string): string {
  const out: string[] = [];
  let fences = 0;
  for (const line of content.split('\n')) {
    if (line === '---') { fences++; continue; }
    if (fences === 1) out.push(line);
  }
  return out.join('\n');
}

describe('proposal-act accept flow', () => {
  test('skill file exists', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true);
  });

  // All three options present in the Accept Flow body.
  test("'Start implementing now' option present", () => {
    expect(skill).toContain('Start implementing now');
  });

  test("'Start implementing now' marked as default", () => {
    expect(skill).toContain('default, typical answer');
  });

  test("'Create a session task' option present", () => {
    expect(skill).toContain('Create a session task');
  });

  test("'I'll handle it manually' option present", () => {
    expect(skill).toContain("I'll handle it manually");
  });

  // Falsification gate: must run before any session transition (guards against the
  // orphaned-step regression where session-state branches jumped straight to (e)).
  test("falsification gate present in 'Start implementing now'", () => {
    expect(skill).toContain('Falsification gate (runs first');
  });

  test('falsification gate emits REJECT/PROCEED verdict', () => {
    expect(skill).toContain('REJECT');
    expect(skill).toContain('PROCEED');
  });

  // Quality-gate (e.5) tier-branched + NEXT-TASK template assertions.
  // Guards against losing the tier branching, judge invocation, or NEXT-TASK gating.
  test('step (e.5) references quality_gate.tier (not enabled)', () => {
    expect(skill).toContain('quality_gate.tier');
  });

  test('step (e.5) decides the balanced branch inline (no quality-gate-judge subagent)', () => {
    expect(skill).toContain('decide RUN vs SKIP **inline**');
    expect(skill).toContain('Bias toward RUN when uncertain');
    expect(skill).not.toContain('quality-gate-judge');
  });

  test('step (e.5) has explicit budget branch (skip)', () => {
    expect(skill).toMatch(/budget.*(skip|never)/);
  });

  test('step (e.5) has explicit quality branch (always run /claude-code-hermit:simplify)', () => {
    expect(skill).toMatch(
      /quality.*(invoke|run).*\/claude-code-hermit:simplify|\/claude-code-hermit:simplify.*quality/,
    );
  });

  test('NEXT-TASK.md gating references tier != budget', () => {
    expect(skill).toMatch(/tier.*budget|budget.*tier/);
  });

  test('/claude-code-hermit:simplify focus argument pattern preserved', () => {
    expect(skill).toContain('/claude-code-hermit:simplify focus on PROP-NNN implementation');
  });

  test('NEXT-TASK template /claude-code-hermit:simplify bullet present', () => {
    expect(skill).toContain('Run /claude-code-hermit:simplify on the touched files');
  });
});

// PROP-017: channel-safe approvals. Guards the Step-0 marker, the 3-option
// channel-tagged branch on step 4, and the --answer re-entry path.
describe('PROP-017 channel-safe approvals', () => {
  test('Step 0 channel-reply marker present', () => {
    expect(skill).toContain('Step 0 — Channel reply');
  });

  test('step 4 channel branch queues the three option labels', () => {
    expect(skill).toContain('"implement now"');
    expect(skill).toContain('"session task"');
    expect(skill).toContain('"manual"');
  });

  test('channel re-entry section present', () => {
    expect(skill).toContain('--answer');
    expect(skill).toContain('Channel re-entry');
  });

  test('MP entry carries an on_resolve invocation with the {answer} placeholder', () => {
    expect(skill).toContain('on_resolve');
    expect(skill).toContain('{answer}');
  });
});

// Frontmatter description specifically (between the opening --- and the second ---).
test("frontmatter description mentions 'start implementing now'", () => {
  expect(frontmatterOf(skill)).toMatch(/^description:.*start implementing now/m);
});

// Step 2's success_signal bullet: capture and validation.
// Guards that the step exists, references eval-success-signal.ts, and never blocks accept.
// (Folded from a standalone numbered step 3c into step 2's "determine what to
// set" bullet list when the accept flow consolidated onto proposal.ts patch —
// same behavior, new anchor.)
describe('step 3c: success_signal', () => {
  test('step 3c: success_signal step present', () => {
    expect(skill).toContain('`success_signal` (optional)');
  });

  test('step 3c: references eval-success-signal.ts', () => {
    expect(skill).toContain('eval-success-signal.ts');
  });

  test('step 3c: never blocks accept', () => {
    expect(skill).toContain('Never block accept');
  });

  test('step 3c: warns on invalid predicate (logs to SHELL.md Findings)', () => {
    expect(skill).toContain('success_signal ignored');
  });
});

// PROPOSAL.md.template: success_signal field present.
describe('PROPOSAL.md.template', () => {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  test('PROPOSAL.md.template: success_signal frontmatter key present', () => {
    expect(template).toContain('success_signal:');
  });

  test('PROPOSAL.md.template: Success Signal section present', () => {
    expect(template).toContain('## Success Signal');
  });
});
