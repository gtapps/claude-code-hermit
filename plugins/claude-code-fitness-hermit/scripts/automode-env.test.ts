// Tests for automode-env.ts — run with: bun scripts/automode-env.test.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dir, 'automode-env.ts');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-automode-env-'));
}

function run(target: string): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(['bun', SCRIPT, target]);
  return { exitCode: r.exitCode ?? 0, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

console.log('\nautomode-env.ts:');

{
  const dir = freshDir();
  const target = path.join(dir, '.claude', 'settings.local.json');
  const r = run(target);
  const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
  ok('seeds a strava.com entry on an empty settings.local.json', r.exitCode === 0);
  ok('array starts with $defaults', settings.autoMode.environment[0] === '$defaults');
  ok('entry mentions www.strava.com', settings.autoMode.environment.some((e: string) => e.includes('www.strava.com')));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = freshDir();
  const target = path.join(dir, '.claude', 'settings.local.json');
  run(target);
  const first = fs.readFileSync(target, 'utf8');
  run(target);
  const second = fs.readFileSync(target, 'utf8');
  ok('is idempotent', first === second);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const target = path.join(dir, '.claude', 'settings.json');
  fs.writeFileSync(target, '{}');
  const r = run(target);
  ok('refuses a target not named settings.local.json', r.exitCode === 1 && r.stderr.includes('settings.local.json'));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = freshDir();
  const target = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ permissions: { allow: ['Bash(bun *fitness-lab.ts*)'] } }));
  run(target);
  const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
  ok(
    'never touches sibling keys',
    JSON.stringify(settings.permissions.allow) === JSON.stringify(['Bash(bun *fitness-lab.ts*)']),
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
