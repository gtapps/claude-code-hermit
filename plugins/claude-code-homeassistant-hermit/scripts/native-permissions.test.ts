import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
function run(root: string, migrate = false) {
  return Bun.spawnSync(['bun', script, join(root, '.claude/settings.local.json'), ...(migrate ? ['--migrate'] : [])]);
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
test('migration flips ha_safety_mode once and validates all files before writing', () => {
  const root = fixture(), local = join(root, '.claude/settings.local.json'), shared = join(root, '.claude/settings.json');
  writeFileSync(local, '{}'); writeFileSync(shared, '{bad');
  expect(run(root, true).exitCode).not.toBe(0); expect(readFileSync(local, 'utf8')).toBe('{}');
  writeFileSync(shared, JSON.stringify({ permissions: { deny: [...rules, 'Bash(custom *)'] } }));
  writeFileSync(join(root, '.claude-code-hermit/config.json'), JSON.stringify({ ha_safety_mode: 'strict', custom: 7 }));
  expect(run(root).exitCode).toBe(0); // a plain hatch install must not consume the one-time migration
  expect(run(root, true).exitCode).toBe(0);
  const data = JSON.parse(readFileSync(shared, 'utf8'));
  expect(data.permissions.deny).toContain('Bash(custom *)');
  const before = readFileSync(local, 'utf8'); expect(run(root, true).exitCode).toBe(0); expect(readFileSync(local, 'utf8')).toBe(before);
  {
    const configFile = join(root, '.claude-code-hermit/config.json');
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ ha_safety_mode: 'ask', custom: 7 });
    writeFileSync(configFile, '{"ha_safety_mode":"strict"}');
    expect(run(root, true).exitCode).toBe(0); expect(JSON.parse(readFileSync(configFile, 'utf8')).ha_safety_mode).toBe('strict');
  }
});
test('malformed permission arrays are not overwritten', () => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  const original = '{"permissions":{"ask":"bad"}}'; writeFileSync(file, original);
  expect(run(root).exitCode).not.toBe(0); expect(readFileSync(file, 'utf8')).toBe(original);
});

test('ordinary upgrades preserve safety configuration, other scopes, and existing migration markers', () => {
  const root = fixture();
  const files = {
    '.claude/settings.json': '{"permissions":{"deny":["Bash(*)"]}}',
    '.claude-code-hermit/config.json': '{"ha_safety_mode":"strict","operator_value":7}',
    '.claude-code-hermit/state/claude-code-homeassistant-hermit-native-permissions-v1.json': '{"operator_marker":true}',
  };
  mkdirSync(join(root, '.claude-code-hermit/state'), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  expect(run(root).exitCode).toBe(0);
  for (const [name, content] of Object.entries(files)) expect(readFileSync(join(root, name), 'utf8')).toBe(content);
});
