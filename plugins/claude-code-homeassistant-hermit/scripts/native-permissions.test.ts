import { test, expect, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
function run(root: string, args: string[] = [], target = 'settings.local.json') {
  return Bun.spawnSync(['bun', script, join(root, '.claude', target), ...args]);
}
test.each(['settings.json', 'settings.local.json'])('install into %s preserves operator settings and is repeatable', (target) => {
  const root = fixture(), file = join(root, '.claude', target);
  writeFileSync(file, JSON.stringify({ env: { KEEP: 'yes' }, permissions: { allow: ['Read(public)'], deny: [rules[0], 'Bash(custom *)'], ask: ['Read(private)'] } }));
  const result = run(root, [], target);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`Existing denies remain: ${rules[0]}`);
  const once = readFileSync(file, 'utf8'), data = JSON.parse(once);
  expect(data.env.KEEP).toBe('yes'); expect(data.permissions.deny).toEqual([rules[0], 'Bash(custom *)']);
  expect(data.permissions.allow).toEqual(['Read(public)']);
  expect(data.permissions.ask).toContain('Read(private)');
  for (const rule of rules) expect(data.permissions.ask).toContain(rule);
  expect(run(root, [], target).exitCode).toBe(0); expect(readFileSync(file, 'utf8')).toBe(once);
  expect(existsSync(join(root, '.claude-code-hermit/state'))).toBe(false);
  expect(existsSync(join(root, '.claude-code-hermit/config.json'))).toBe(false);
});
test.each([['--migrate'], ['--unknown'], ['extra'], [''], ['--migrate', 'extra']].map(args => ({ args })))('extra arguments fail without writes: $args', ({ args }) => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  expect(run(root, args).exitCode).not.toBe(0);
  expect(existsSync(file)).toBe(false);
  const original = '{}';
  writeFileSync(file, original);
  const config = join(root, '.claude-code-hermit/config.json');
  const strict = '{"ha_safety_mode":"strict"}';
  writeFileSync(config, strict);
  expect(run(root, args).exitCode).not.toBe(0);
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(readFileSync(config, 'utf8')).toBe(strict);
  expect(existsSync(join(root, '.claude-code-hermit/state'))).toBe(false);
});
test.each(['{bad', '[]', '{"permissions":null}', '{"permissions":{"ask":"bad"}}', '{"permissions":{"deny":[1]}}'])('invalid settings are not overwritten: %s', (original) => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  writeFileSync(file, original);
  expect(run(root).exitCode).not.toBe(0); expect(readFileSync(file, 'utf8')).toBe(original);
});

test('ordinary upgrades preserve safety configuration and other scopes', () => {
  const root = fixture();
  const files = {
    '.claude/settings.json': '{"permissions":{"deny":["Bash(*)"]}}',
    '.claude-code-hermit/config.json': '{"ha_safety_mode":"strict","operator_value":7}',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  expect(run(root).exitCode).toBe(0);
  for (const [name, content] of Object.entries(files)) expect(readFileSync(join(root, name), 'utf8')).toBe(content);
});

test('unrelated malformed files are not read', () => {
  const root = fixture();
  const files = ['.claude/settings.json', '.claude-code-hermit/config.json'];
  for (const file of files) writeFileSync(join(root, file), '{bad');
  expect(run(root).exitCode).toBe(0);
  for (const file of files) expect(readFileSync(join(root, file), 'utf8')).toBe('{bad');
});
