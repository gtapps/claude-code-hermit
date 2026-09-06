import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readPendingCommand, writePendingCommand } from '../scripts/lib/harness-command';
import { runScript } from './helpers/run';
import { withDir } from './helpers/workdir';

const runtime = { runtime_mode: 'headless', tmux_session: 'hermit-test' };
function seed(dir: string, value = runtime): string {
  const root = path.join(dir, '.claude-code-hermit');
  fs.writeFileSync(path.join(root, 'state/runtime.json'), JSON.stringify(value));
  return root;
}

for (const args of [['--model', 'sonnet', '--effort', 'low'], ['--model', 'future-model'], ['--effort', 'low']]) {
  test(`arms ${args.join(' ')}, replacing the singleton`, withDir(async (dir) => {
    const root = seed(dir);
    writePendingCommand(root, { command: '/clear', arg: null, by: 'old', requested_at: new Date().toISOString() });
    const result = await runScript('arm-harness-switch.ts', { cwd: dir, args: [root, ...args] });
    expect(result.exitCode).toBe(0);
    const pending = readPendingCommand(root)!;
    expect(pending.by).toBe('terminal');
    expect(pending.command).toBe(args[0] === '--model' ? '/model' : '/effort');
    expect(pending.arg).toBe(args[1]);
    expect(pending.then).toEqual(args.length === 4 ? { command: '/effort', arg: 'low' } : undefined);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout).toContain('At the next idle');
  }));
}

for (const [label, value, args] of [
  ['interactive', { ...runtime, runtime_mode: 'interactive' }, ['--model', 'sonnet']],
  ['no pane', { ...runtime, tmux_session: '' }, ['--effort', 'low']],
  ['bad arg', runtime, ['--model', 'sonnet\n/clear']],
  ['missing flags', runtime, []],
  ['missing value', runtime, ['--model']],
  ['unknown flag', runtime, ['--other', 'low']],
  ['missing runtime', null, ['--model', 'sonnet']],
] as const) {
  test(`refuses ${label}`, withDir(async (dir) => {
    const root = value ? seed(dir, value) : path.join(dir, '.claude-code-hermit');
    const result = await runScript('arm-harness-switch.ts', { cwd: dir, args: [root, ...args] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(readPendingCommand(root)).toBeNull();
  }));
}
