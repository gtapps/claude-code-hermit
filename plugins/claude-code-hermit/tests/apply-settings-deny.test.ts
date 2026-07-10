import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run';

const tmpdirs: string[] = [];
function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-deny-'));
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

// Regression for the deny-pattern normalization pass: `deny minimal` merges
// state-templates/deny-patterns.json's `default` array verbatim into the
// native settings.json permissions.deny array — this is the portable half of
// the fix, reaching Claude Code's own deny engine (not just the runtime hook).
describe('apply-settings.ts deny', () => {
  test('deny minimal merges the new rm flag-order/path-prefixed patterns', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {});
    const r = await runScript('apply-settings.ts', { args: [file, 'deny', 'minimal'] });
    expect(r.exitCode).toBe(0);
    const deny = readSettings(file).permissions.deny;
    for (const pattern of [
      'Bash(rm -rf *)',
      'Bash(rm -fr *)',
      'Bash(rm -r -f *)',
      'Bash(rm -f -r *)',
      'Bash(*/rm -rf *)',
      'Bash(*/rm -fr *)',
      'Bash(*/rm -r -f *)',
      'Bash(*/rm -f -r *)',
    ]) {
      expect(deny).toContain(pattern);
    }
  });

  test('deny minimal is additive and idempotent — running twice does not duplicate', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, { permissions: { deny: ['Bash(some-other-tool*)'] } });
    await runScript('apply-settings.ts', { args: [file, 'deny', 'minimal'] });
    await runScript('apply-settings.ts', { args: [file, 'deny', 'minimal'] });
    const deny = readSettings(file).permissions.deny;
    expect(deny).toContain('Bash(some-other-tool*)');
    expect(deny.filter((p: string) => p === 'Bash(rm -fr *)').length).toBe(1);
  });
});
