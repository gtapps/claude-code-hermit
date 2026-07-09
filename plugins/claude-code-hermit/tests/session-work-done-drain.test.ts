// Regression: the session work-done flow drains a queued NEXT-TASK.md
// immediately on task completion (balanced/autonomous), instead of waiting
// for the next heartbeat tick (#541).
//
// Prose-contract test — asserts ordering and escalation branching are still
// described. Mirrors the style in proposal-act-accept-flow.test.ts.
//
// Usage: bun test tests/session-work-done-drain.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'session', 'SKILL.md');
const skill = fs.readFileSync(SKILL_PATH, 'utf-8');

describe('session work-done NEXT-TASK drain', () => {
  test('skill file exists', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true);
  });

  test('step 8 checks NEXT-TASK.md and escalation after the idle transition', () => {
    expect(skill).toContain('NEXT-TASK.md');
    expect(skill).toContain('escalation');
  });

  test('balanced/autonomous auto-starts the queued task as the terminal action', () => {
    expect(skill).toContain('balanced` or `autonomous`');
    expect(skill).toContain('Starting on [NEXT-TASK.md summary] next');
    expect(skill).toContain('terminal action');
  });

  test('drain invokes session-start without --task (so it consumes NEXT-TASK itself)', () => {
    expect(skill).toMatch(/invoke `\/claude-code-hermit:session-start`.*consumes `NEXT-TASK\.md`/s);
  });

  test('autonomous re-runs the work-done flow on the drained task (no bare notify)', () => {
    expect(skill).toContain('re-run this Work-done flow');
  });

  test('conservative escalation does not auto-start and does not write runtime.json', () => {
    expect(skill).toContain('conservative` with a task queued');
    expect(skill).toContain('do not write to `runtime.json` from this flow');
  });

  test('step 7b (compaction marker) is unconditional regardless of the drain branch', () => {
    expect(skill).toContain('Run this step unchanged regardless of step 8');
  });

  test('step 7b names the watchdog as the primary marker reaper (accurate for conservative branch)', () => {
    expect(skill).toContain('maybeContextCompact');
  });

  test('conservative queued branch omits the misleading "Ready for what\'s next" tail', () => {
    expect(skill).toContain('only when no task is queued');
  });
});
