import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run';
import { getPath, setPath, togglePath } from '../scripts/settings-edit';

const tmpdirs: string[] = [];
function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-settings-edit-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpdirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function seedConfig(dir: string, config: any): string {
  const hermit = path.join(dir, '.claude-code-hermit');
  fs.mkdirSync(hermit, { recursive: true });
  const file = path.join(hermit, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return file;
}

function readConfig(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// --- Pure helper unit tests ---

describe('getPath / setPath / togglePath', () => {
  test('getPath returns whole object when path omitted', () => {
    const obj = { a: 1, b: { c: 2 } };
    expect(getPath(obj)).toEqual(obj);
  });

  test('getPath resolves nested dotted paths', () => {
    const obj = { quality_gate: { tier: 'balanced' }, heartbeat: { stale_threshold: '2h' } };
    expect(getPath(obj, 'quality_gate.tier')).toBe('balanced');
    expect(getPath(obj, 'heartbeat.stale_threshold')).toBe('2h');
  });

  test('getPath returns undefined for missing paths without throwing', () => {
    expect(getPath({ a: 1 }, 'b.c.d')).toBeUndefined();
  });

  test('setPath creates parent objects and preserves siblings', () => {
    const obj: any = { agent_name: 'Atlas', reflection: { other: true } };
    setPath(obj, 'reflection.graduation_min_sessions', 2);
    expect(obj).toEqual({ agent_name: 'Atlas', reflection: { other: true, graduation_min_sessions: 2 } });
    setPath(obj, 'quality_gate.tier', 'quality');
    expect(obj.quality_gate).toEqual({ tier: 'quality' });
    expect(obj.agent_name).toBe('Atlas');
  });

  test('togglePath: absent → true, then flips', () => {
    const obj: any = {};
    togglePath(obj, 'remote');
    expect(obj.remote).toBe(true);
    togglePath(obj, 'remote');
    expect(obj.remote).toBe(false);
  });

  test('togglePath throws on non-boolean current value', () => {
    expect(() => togglePath({ remote: 'yes' }, 'remote')).toThrow();
  });
});

// --- CLI integration tests (subprocess) ---

describe('settings-edit.ts CLI', () => {
  test('get with no path prints the whole config', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Atlas', remote: true });
    const r = await runScript('settings-edit.ts', { args: [file, 'get'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ agent_name: 'Atlas', remote: true });
  });

  test('get with a dotted path prints the leaf value', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { quality_gate: { tier: 'balanced' } });
    const r = await runScript('settings-edit.ts', { args: [file, 'get', 'quality_gate.tier'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toBe('balanced');
  });

  test('set a scalar leaf, preserving siblings', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Atlas', language: 'pt', escalation: 'balanced' });
    const r = await runScript('settings-edit.ts', { args: [file, 'set', 'escalation', 'autonomous'] });
    expect(r.exitCode).toBe(0);
    expect(readConfig(file)).toEqual({ agent_name: 'Atlas', language: 'pt', escalation: 'autonomous' });
  });

  test('set JSON-parses booleans and numbers', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { remote: false });
    await runScript('settings-edit.ts', { args: [file, 'set', 'remote', 'true'] });
    expect(readConfig(file).remote).toBe(true);
    await runScript('settings-edit.ts', { args: [file, 'set', 'reflection.graduation_min_sessions', '2'] });
    expect(readConfig(file).reflection.graduation_min_sessions).toBe(2);
  });

  test('set treats an unparseable value as a raw string', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, {});
    await runScript('settings-edit.ts', { args: [file, 'set', 'timezone', 'Europe/Lisbon'] });
    expect(readConfig(file).timezone).toBe('Europe/Lisbon');
  });

  test('set with "none" or "clear" writes null', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { sign_off: 'Atlas out.' });
    await runScript('settings-edit.ts', { args: [file, 'set', 'sign_off', 'none'] });
    expect(readConfig(file).sign_off).toBeNull();
    await runScript('settings-edit.ts', { args: [file, 'set', 'sign_off', 'clear'] });
    expect(readConfig(file).sign_off).toBeNull();
  });

  test('set writes the literal string "default" (not null) — for permission_mode', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { permission_mode: 'auto' });
    await runScript('settings-edit.ts', { args: [file, 'set', 'permission_mode', 'default'] });
    // "default" is a real Claude Code permission_mode enum value, distinct from null.
    expect(readConfig(file).permission_mode).toBe('default');
  });

  test('set creates nested parents when absent', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Atlas' });
    await runScript('settings-edit.ts', { args: [file, 'set', 'quality_gate.tier', 'quality'] });
    const out = readConfig(file);
    expect(out.quality_gate).toEqual({ tier: 'quality' });
    expect(out.agent_name).toBe('Atlas');
  });

  test('toggle flips a boolean and defaults absent → true', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { remote: true });
    await runScript('settings-edit.ts', { args: [file, 'toggle', 'remote'] });
    expect(readConfig(file).remote).toBe(false);
    await runScript('settings-edit.ts', { args: [file, 'toggle', 'push_notifications'] });
    expect(readConfig(file).push_notifications).toBe(true);
  });

  test('toggle refuses a non-boolean value, leaves file unchanged', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { remote: 'yes' });
    const r = await runScript('settings-edit.ts', { args: [file, 'toggle', 'remote'] });
    expect(r.exitCode).not.toBe(0);
    expect(readConfig(file)).toEqual({ remote: 'yes' });
  });

  test('refuses to overwrite a malformed config.json', async () => {
    const dir = freshDir();
    const hermit = path.join(dir, '.claude-code-hermit');
    fs.mkdirSync(hermit, { recursive: true });
    const file = path.join(hermit, 'config.json');
    const malformed = '{ not valid json !!';
    fs.writeFileSync(file, malformed);
    const r = await runScript('settings-edit.ts', { args: [file, 'set', 'agent_name', 'x'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('Refusing to overwrite');
    expect(fs.readFileSync(file, 'utf8')).toBe(malformed);
  });

  test('unknown op exits non-zero', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, {});
    const r = await runScript('settings-edit.ts', { args: [file, 'frobnicate', 'x'] });
    expect(r.exitCode).not.toBe(0);
  });
});
