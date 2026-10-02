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

const BRANCHES_PATH = path.join(PLUGIN_ROOT, 'skills', 'proposal-act', 'branches.md');

// The accept options and channel re-entry live in
// branches.md (the rare-branch procedures file); assert against the combined
// surface, and against `front` alone for what must survive a compaction cut.
const front = fs.readFileSync(SKILL_PATH, 'utf-8');
const branches = fs.readFileSync(BRANCHES_PATH, 'utf-8');
const skill = front + '\n' + branches;

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

  test("'Queue a task' option present", () => {
    expect(skill).toContain('Queue a task');
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

  // Settings-edit steer: these now guard that the skill *asks* a direct
  // settings write (the native ask is the approval) rather than routing through
  // the bundled update-config skill. Anchored per site, because the in-main step
  // and the dispatched-subagent prompt each need their own copy — a bare
  // occurrence count passes when both copies land in the same place.
  const lineContaining = (needle: string) =>
    skill.split('\n').find((l) => l.includes(needle)) ?? '';

  test('falsification gate invocation includes proposal references', () => {
    const line = lineContaining('Invoke with the proposal');
    expect(line).toContain('## References');
  });

  test('queued task always re-verifies the proposal against the current tree', () => {
    const line = lineContaining('re-verify its ## References');
    expect(line).toContain('**(always, first step)**');
    expect(line).toContain('.hermit/proposals/PROP-NNN-*.md');
    expect(line).toContain('current tree');
    expect(line).toContain('implement nothing');
  });

  // The re-verify bullet only gates anything if it precedes the derived
  // implementation steps in the queued plan — as step 4 it would run after the
  // edits it is supposed to prevent.
  test('queued plan puts the re-verify bullet at step 1, before the derived steps', () => {
    expect(skill).toContain('1. [the (always, first step) re-verify bullet from above]');
    expect(skill).toContain('2. [Step derived from Proposed Solution]');
  });

  test('settings-edit steer is present in step (e)', () => {
    const line = lineContaining('e. Implement the proposal.');
    expect(line).toContain("native ask is the operator's approval");
    expect(line).toContain('update-config');
  });

  test('settings-edit steer is present in the dispatch prompt', () => {
    const line = lineContaining('> 2. Do the edits');
    expect(line).toContain("native ask is the operator's approval");
    expect(line).toContain('update-config');
  });

  // The ask only fires on a tool write to the hatch-resolved target: a shell
  // redirect, or a guessed committed file on a local-scope install, walks past it.
  test('settings-edit steer resolves the hatch target and requires a tool write', () => {
    expect(skill).toContain('hatch-options.json');
    expect(skill).toContain('never a shell redirect');
  });

  // Quality-gate (e.5) delegation + queued record assertions.
  // The rubric used to be prose here and in the dispatched-subagent prompt, and
  // the two copies diverged; these now guard that the skill *asks* the verb
  // rather than deciding, on every path. Rubric behavior itself is covered by
  // tests/proposal-quality-gate.test.ts.
  test('step (e.5) delegates to the quality-gate verb', () => {
    expect(skill).toContain('proposal.ts quality-gate');
    expect(skill).toContain('--files-json');
  });

  test('step (e.5) no longer decides the balanced branch inline', () => {
    expect(skill).not.toContain('decide RUN vs SKIP **inline**');
    expect(skill).not.toContain('Bias toward RUN when uncertain');
    expect(skill).not.toContain('quality-gate-judge');
  });

  test('step (e.5) acts on the verdict, not on a tier it resolved itself', () => {
    expect(skill).toMatch(/`SKIP`.*no cleanup/);
    expect(skill).toMatch(/`RUN`.*\/simplify/);
  });

  test('queued record gating still keys on tier != budget', () => {
    expect(skill).toMatch(/tier.*budget|budget.*tier/);
  });

  test('/simplify receives the implementation target', () => {
    expect(skill).toContain('/simplify path/a path/b');
  });

  test('cleanup outcomes have no custom totals dependency', () => {
    expect(skill).toContain('simplify <cleanup outcome>');
    expect(skill).not.toContain('totals line');
    expect(skill).toContain('Wait for completion and briefly summarize the cleanup result');
    expect(skill).toContain('/simplify with its focus_files as the target');
  });

  test('queued record defers the gate call to the future session', () => {
    // The queued path cannot run the verb at queue time — no implementation has
    // happened yet, so there is no diff to classify. It hands the call forward.
    expect(skill).toContain('Copy `proposal-quality-gate` (Commands) into the note as an absolute command');
    expect(skill).toContain('On "action":"RUN"');
  });

  test('--no-artifacts is documented under Dashboard Refresh', () => {
    const dash = skill.split('## Dashboard Refresh')[1]?.split('## ')[0] ?? '';
    expect(dash).toContain('--no-artifacts');
  });
});

// PROP-017: channel-safe approvals. Guards the Step-0 marker, the 3-option
// channel-tagged branch on step 4, and the --answer re-entry path.
describe('PROP-017 channel-safe approvals', () => {
  test('Step 0 channel-reply marker present', () => {
    expect(front).toContain('Step 0 — Channel reply');
  });

  test('step 4 channel branch queues the three option labels', () => {
    expect(front).toContain('"implement now"');
    expect(front).toContain('"queued task"');
    expect(front).toContain('"manual"');
  });

  test('channel re-entry skips steps 1-3a before the accept flow runs', () => {
    const accept = front.slice(front.indexOf('## Accept Flow'), front.indexOf('\n1. Resolve the proposal file'));
    expect(accept).toContain('--answer');
    expect(accept).toContain('skip steps 1-3a entirely');
    expect(branches).toContain('\n## Channel re-entry (`--answer`)\n');
  });

  test('step 4 carries --no-artifacts into on_resolve at queue time', () => {
    expect(front).toContain('--answer {answer} --no-artifacts');
  });

  test('MP entry carries an on_resolve invocation with the {answer} placeholder', () => {
    expect(front).toContain('on_resolve');
    expect(front).toContain('{answer}');
  });
});

// Frontmatter description specifically (between the opening --- and the second ---).
test("frontmatter description mentions 'start implementing now'", () => {
  expect(frontmatterOf(front)).toMatch(/^description:.*start implementing now/m);
});

// Step 2's success_signal bullet: capture and validation.
// Guards that the step exists, references the success-signal verb, and never blocks accept.
// (Folded from a standalone numbered step 3c into step 2's "determine what to
// set" bullet list when the accept flow consolidated onto proposal.ts patch —
// same behavior, new anchor.)
describe('step 3c: success_signal', () => {
  test('step 3c: success_signal step present', () => {
    expect(skill).toContain('`success_signal` (optional)');
  });

  test('step 3c: references the success-signal verb', () => {
    expect(skill).toContain('proposal.ts success-signal');
  });

  test('step 3c: never blocks accept', () => {
    expect(skill).toContain('Never block accept');
  });

  test('step 3c: warns on invalid predicate', () => {
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

// SKILL.md is what every invocation pays for and what survives a compaction
// cut; each branch it dispatches to must exist under the name it uses.
describe('proposal-act branches.md dispatch', () => {
  const SECTIONS = [
    'Start implementing now',
    'Queue a task',
    'Channel re-entry (`--answer`)',
  ];

  for (const section of SECTIONS) {
    test(`SKILL.md points at branches.md § ${section} and the section exists`, () => {
      expect(front).toContain(`branches.md § ${section}`);
      expect(branches).toContain(`\n## ${section}\n`);
    });
  }

  test('defer, dismiss and resolve stay inline in SKILL.md', () => {
    for (const flow of ['Defer Flow', 'Dismiss Flow', 'Resolve Flow']) {
      expect(front).toContain(`\n## ${flow}\n`);
      expect(branches).not.toContain(`## ${flow}`);
    }
  });

  test('front page keeps the option labels the micro-proposal queue needs', () => {
    expect(front).toContain('"Start implementing now"');
    expect(front).toContain('"Queue a task"');
    expect(front).toContain("I'll handle it manually");
  });
});
