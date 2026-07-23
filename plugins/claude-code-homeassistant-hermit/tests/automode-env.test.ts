import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { tmpPath, cleanupTmp } from './helpers';

const SCRIPT = path.join(import.meta.dir, '..', 'scripts', 'automode-env.ts');

afterAll(cleanupTmp);
const freshDir = () => tmpPath('ha-automode-env-');

function run(target: string, projectDir: string): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(['bun', SCRIPT, target], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe('automode-env.ts', () => {
  test('seeds an autoMode.environment entry from HOMEASSISTANT_URL in .env', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '.env'), 'HOMEASSISTANT_URL=http://homeassistant.local:8123\n');
    const target = path.join(dir, '.claude', 'settings.local.json');
    const r = run(target, dir);
    expect(r.exitCode).toBe(0);
    const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(settings.autoMode.environment[0]).toBe('$defaults');
    expect(settings.autoMode.environment.some((e: string) => e.includes('homeassistant.local:8123'))).toBe(true);
  });

  test('no HA URL configured — SKIP, no file written', () => {
    const dir = freshDir();
    const target = path.join(dir, '.claude', 'settings.local.json');
    const r = run(target, dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('SKIP');
    expect(fs.existsSync(target)).toBe(false);
  });

  test('is idempotent', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '.env'), 'HOMEASSISTANT_URL=http://homeassistant.local:8123\n');
    const target = path.join(dir, '.claude', 'settings.local.json');
    run(target, dir);
    const first = JSON.parse(fs.readFileSync(target, 'utf8'));
    run(target, dir);
    const second = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(second).toEqual(first);
  });

  test('refuses a target not named settings.local.json', () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const target = path.join(dir, '.claude', 'settings.json');
    fs.writeFileSync(target, '{}');
    const r = run(target, dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('settings.local.json');
  });

  test('never touches sibling keys', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '.env'), 'HOMEASSISTANT_URL=http://homeassistant.local:8123\n');
    const target = path.join(dir, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ permissions: { allow: ['Bash(./bin/ha-agent-lab *)'] } }));
    run(target, dir);
    const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(settings.permissions.allow).toEqual(['Bash(./bin/ha-agent-lab *)']);
  });
});
