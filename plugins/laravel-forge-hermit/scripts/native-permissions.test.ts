import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const script = join(import.meta.dir, 'native-permissions.ts');
const rules: string[] = JSON.parse(readFileSync(join(import.meta.dir, '../state-templates/native-permissions.json'), 'utf8')).ask;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-permissions-')); dirs.push(root);
  mkdirSync(join(root, '.claude')); mkdirSync(join(root, '.claude-code-hermit'));
  return root;
}
function run(root: string) {
  return Bun.spawnSync(['bun', script, join(root, '.claude/settings.local.json')]);
}
test('install preserves unrelated settings and denies; repeated seeding is stable', () => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  writeFileSync(file, JSON.stringify({ env: { KEEP: 'yes' }, permissions: { deny: ['Bash(custom *)'], ask: ['Read(private)'] } }));
  expect(run(root).exitCode).toBe(0);
  const once = readFileSync(file, 'utf8'), data = JSON.parse(once);
  expect(data.env.KEEP).toBe('yes'); expect(data.permissions.deny).toEqual(['Bash(custom *)']);
  for (const rule of rules) expect(data.permissions.ask).toContain(rule);
  expect(run(root).exitCode).toBe(0); expect(readFileSync(file, 'utf8')).toBe(once);
});
test('installation preserves other settings scopes, configuration, and old markers', () => {
  const root = fixture();
  const shared = join(root, '.claude/settings.json');
  const config = join(root, '.claude-code-hermit/config.json');
  const marker = join(root, '.claude-code-hermit/state/laravel-forge-hermit-native-permissions-v1.json');
  mkdirSync(join(root, '.claude-code-hermit/state'));
  writeFileSync(shared, JSON.stringify({ permissions: { deny: rules } }));
  writeFileSync(config, '{"custom":7}');
  writeFileSync(marker, '{"version":1}');
  const originals = [shared, config, marker].map(file => readFileSync(file, 'utf8'));
  expect(run(root).exitCode).toBe(0);
  expect(run(root).exitCode).toBe(0);
  expect([shared, config, marker].map(file => readFileSync(file, 'utf8'))).toEqual(originals);
});
test('fresh installation does not create a migration marker and reports target denies', () => {
  const root = fixture();
  const file = join(root, '.claude/settings.local.json');
  writeFileSync(file, JSON.stringify({ permissions: { deny: rules } }));
  const result = run(root);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('Existing denies remain:');
  expect(JSON.parse(readFileSync(file, 'utf8')).permissions.deny).toEqual(rules);
  expect(existsSync(join(root, '.claude-code-hermit/state'))).toBe(false);
});
test('malformed permission arrays are not overwritten', () => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  const original = '{"permissions":{"ask":"bad"}}'; writeFileSync(file, original);
  expect(run(root).exitCode).not.toBe(0); expect(readFileSync(file, 'utf8')).toBe(original);
});
