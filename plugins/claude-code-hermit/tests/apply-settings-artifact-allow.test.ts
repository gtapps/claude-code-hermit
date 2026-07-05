import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run';

const tmpdirs: string[] = [];
function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-artifact-allow-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpdirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

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
