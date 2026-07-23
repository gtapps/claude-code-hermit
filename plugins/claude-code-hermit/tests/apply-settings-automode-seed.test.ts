import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-automode-seed-');
afterAll(cleanup);

function seedFile(dir: string, name: string, settings: any): string {
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, name);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

function readSettings(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('apply-settings.ts automode-seed', () => {
  test('creates autoMode.allow and autoMode.environment with $defaults on an empty settings.local.json', async () => {
    const dir = freshDir();
    const file = seedFile(dir, 'settings.local.json', {});
    const r = await runScript('apply-settings.ts', { args: [file, 'automode-seed'] });
    expect(r.exitCode).toBe(0);
    const settings = readSettings(file);
    expect(settings.autoMode.allow[0]).toBe('$defaults');
    expect(settings.autoMode.allow.length).toBe(2);
    expect(settings.autoMode.allow[1]).toContain('Operator policy, set at hatch');
    expect(settings.autoMode.environment[0]).toBe('$defaults');
    expect(settings.autoMode.environment.length).toBe(3);
  });

  test('is idempotent — running twice does not duplicate entries', async () => {
    const dir = freshDir();
    const file = seedFile(dir, 'settings.local.json', {});
    await runScript('apply-settings.ts', { args: [file, 'automode-seed'] });
    const first = readSettings(file);
    await runScript('apply-settings.ts', { args: [file, 'automode-seed'] });
    const second = readSettings(file);
    expect(second).toEqual(first);
  });

  test('does not inject $defaults into a pre-existing allow array that lacks it', async () => {
    const dir = freshDir();
    const file = seedFile(dir, 'settings.local.json', { autoMode: { allow: ['custom rule'] } });
    const r = await runScript('apply-settings.ts', { args: [file, 'automode-seed'] });
    expect(r.exitCode).toBe(0);
    const settings = readSettings(file);
    expect(settings.autoMode.allow[0]).toBe('custom rule');
    expect(settings.autoMode.allow).not.toContain('$defaults');
    expect(settings.autoMode.allow.some((e: string) => e.includes('Operator policy, set at hatch'))).toBe(true);
  });

  test('never touches sibling keys (permissions, env, autoMode.soft_deny)', async () => {
    const dir = freshDir();
    const file = seedFile(dir, 'settings.local.json', {
      permissions: { allow: ['Bash(git status:*)'] },
      env: { FOO: 'bar' },
      autoMode: { soft_deny: ['$defaults', 'custom soft deny'] },
    });
    const r = await runScript('apply-settings.ts', { args: [file, 'automode-seed'] });
    expect(r.exitCode).toBe(0);
    const settings = readSettings(file);
    expect(settings.permissions.allow).toEqual(['Bash(git status:*)']);
    expect(settings.env.FOO).toBe('bar');
    expect(settings.autoMode.soft_deny).toEqual(['$defaults', 'custom soft deny']);
  });

  test('refuses a target that is not named settings.local.json', async () => {
    const dir = freshDir();
    const file = seedFile(dir, 'settings.json', {});
    const before = readSettings(file);
    const r = await runScript('apply-settings.ts', { args: [file, 'automode-seed'] });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('settings.local.json');
    expect(readSettings(file)).toEqual(before);
  });
});
