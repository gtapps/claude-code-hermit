// Regression: session-start --task must not silently overwrite an in_progress
// or waiting session's live Task with an unrelated task (#541).
//
// Prose-contract test — asserts the skill text still describes the collision
// guard, defer-to-NEXT-TASK behavior, and same-task passthrough. Mirrors the
// style in proposal-act-accept-flow.test.ts.
//
// Usage: bun test tests/session-start-collision-guard.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'session-start', 'SKILL.md');
const skill = fs.readFileSync(SKILL_PATH, 'utf-8');

describe('session-start --task collision guard', () => {
  test('skill file exists', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true);
  });

  test('collision guard section present', () => {
    expect(skill).toContain('Collision guard');
  });

  test('guard triggers on both in_progress and waiting', () => {
    expect(skill).toContain('`in_progress` or `waiting`');
  });

  test('guard defines task-text comparison directly (not via proposal-act)', () => {
    expect(skill).toContain('first non-comment, non-empty line');
    expect(skill).toContain('Awaiting next task');
  });

  test('collision defers to NEXT-TASK.md instead of overwriting Task', () => {
    expect(skill).toContain('Do **not** overwrite `## Task`');
    expect(skill).toContain('Defer');
    expect(skill).toContain('NEXT-TASK.md');
  });

  test('existing NEXT-TASK.md is not clobbered on a second collision', () => {
    expect(skill).toMatch(/already exists.*do \*\*not\*\* overwrite it/s);
  });

  test('collision logs to Findings and Progress Log, then notifies and aborts', () => {
    expect(skill).toContain('## Findings');
    expect(skill).toContain('## Progress Log');
    expect(skill).toContain('Abort the start');
  });

  test('same task (post-trim match) proceeds unchanged, not a collision', () => {
    expect(skill).toMatch(/Equal \(post-trim\).*not\*\* a collision/s);
  });

  test('--task adopts the task verbatim so same-task comparison stays valid', () => {
    expect(skill).toContain('write it **verbatim**');
  });

  test('--task path skips step 9 resume prompt (no interactive stall on same-task re-entry)', () => {
    expect(skill).toContain('resume prompt (step 9');
  });

  test('recovery waiting_reason archives-as-partial instead of deferring the fresh task', () => {
    expect(skill).toContain('recovery `waiting_reason`');
    expect(skill).toContain('archive as partial, start fresh');
  });

  test('step 6 autonomous drain auto-accepts and only deletes after adoption', () => {
    expect(skill).toContain('Autonomous drain');
    expect(skill).toContain('Never delete a queued task that was not started');
  });
});
