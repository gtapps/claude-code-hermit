import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-artifact-allow-');
afterAll(cleanup);

function seedSettings(dir: string, settings: any): string {
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, 'settings.local.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

function readSettings(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('apply-settings.ts artifact-allow', () => {
  test('adds Artifact to permissions.allow on an empty settings file', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {});
    const r = await runScript('apply-settings.ts', { args: [file, 'artifact-allow'] });
    expect(r.exitCode).toBe(0);
    expect(readSettings(file).permissions.allow).toEqual(['Artifact']);
  });

  test('merges additively — existing allow entries are preserved', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, { permissions: { allow: ['Bash(git status:*)'] } });
    const r = await runScript('apply-settings.ts', { args: [file, 'artifact-allow'] });
    expect(r.exitCode).toBe(0);
    expect(readSettings(file).permissions.allow).toEqual(['Bash(git status:*)', 'Artifact']);
  });

  test('is idempotent — running twice does not duplicate the entry', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {});
    await runScript('apply-settings.ts', { args: [file, 'artifact-allow'] });
    await runScript('apply-settings.ts', { args: [file, 'artifact-allow'] });
    expect(readSettings(file).permissions.allow).toEqual(['Artifact']);
  });

  test('never touches permissions.deny or other sibling keys', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, { permissions: { deny: ['Bash(rm -rf*)'] }, env: { FOO: 'bar' } });
    const r = await runScript('apply-settings.ts', { args: [file, 'artifact-allow'] });
    expect(r.exitCode).toBe(0);
    const settings = readSettings(file);
    expect(settings.permissions.deny).toEqual(['Bash(rm -rf*)']);
    expect(settings.permissions.allow).toEqual(['Artifact']);
    expect(settings.env.FOO).toBe('bar');
  });
});
