import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';

const read = (name: string) => fs.readFileSync(path.join(PLUGIN_ROOT, name), 'utf8');
const skill = read('skills/resident-start/SKILL.md');

describe('resident startup', () => {
  test('readiness inventories execution and open records without selecting work', () => {
    expect(skill).toContain('state/execution.json');
    expect(skill).toContain('task.ts list .hermit --open');
    expect(skill).toContain('does not open, close, cancel or select a task');
    expect(skill).toContain('In always-on mode never ask for a task');
    expect(skill).not.toContain('--task');
    expect(skill).not.toContain('session-archive.ts');
    expect(skill).not.toContain('SHELL.md');
  });
  test('recovery preserves commitments and distinguishes context refresh from boot', () => {
    for (const token of ['unclean_shutdown', 'dead_process', 'orphaned_process', 'context_cleared', 'watchdog_restart_reason']) expect(skill).toContain(token);
    expect(skill).toContain('Preserve records and pending results');
    expect(skill).toContain('On a context refresh keep surviving monitors');
  });
  test('launch default and injected-prompt classification use resident-start', () => {
    expect(read('scripts/hermitd-start.ts')).toContain("config.boot_skill || '/hermitd:resident-start'");
    expect(read('scripts/record-operator-action.ts')).toContain("'/hermitd:resident-start'");
    for (const name of ['session', 'session-start']) expect(fs.existsSync(path.join(PLUGIN_ROOT, 'skills', name))).toBe(false);
  });
  test('launch and shutdown no longer assign lifecycle session_state', () => {
    for (const file of ['hermitd-start.ts', 'hermitd-stop.ts']) {
      const code = read('scripts/' + file);
      expect(code).not.toMatch(/session_state\s*[:=]\s*['"]/);
    }
  });
});
