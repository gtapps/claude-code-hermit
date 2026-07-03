import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run';

const tmpdirs: string[] = [];
function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-channel-env-'));
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

describe('apply-settings.ts channel-env', () => {
  test('sets <CHANNEL>_STATE_DIR in the env block', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {});
    const r = await runScript('apply-settings.ts', {
      args: [file, 'channel-env', 'DISCORD', '/abs/state/discord'],
    });
    expect(r.exitCode).toBe(0);
    expect(readSettings(file).env.DISCORD_STATE_DIR).toBe('/abs/state/discord');
  });

  test('strips any stale *_BOT_TOKEN keys from env', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {
      env: {
        DISCORD_BOT_TOKEN: 'leaked-token',
        TELEGRAM_BOT_TOKEN: 'another-leak',
        MAX_THINKING_TOKENS: '10000',
      },
    });
    const r = await runScript('apply-settings.ts', {
      args: [file, 'channel-env', 'DISCORD', '/abs/state/discord'],
    });
    expect(r.exitCode).toBe(0);
    const env = readSettings(file).env;
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.DISCORD_STATE_DIR).toBe('/abs/state/discord');
    // A non-token env key is preserved.
    expect(env.MAX_THINKING_TOKENS).toBe('10000');
  });

  test('preserves other settings keys and existing STATE_DIR entries', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {
      permissions: { allow: ['Bash(git status:*)'] },
      env: { TELEGRAM_STATE_DIR: '/abs/state/telegram' },
    });
    const r = await runScript('apply-settings.ts', {
      args: [file, 'channel-env', 'DISCORD', '/abs/state/discord'],
    });
    expect(r.exitCode).toBe(0);
    const out = readSettings(file);
    expect(out.permissions).toEqual({ allow: ['Bash(git status:*)'] });
    expect(out.env.TELEGRAM_STATE_DIR).toBe('/abs/state/telegram');
    expect(out.env.DISCORD_STATE_DIR).toBe('/abs/state/discord');
  });

  test('creates settings file with just env when none exists', async () => {
    const dir = freshDir();
    const file = path.join(dir, '.claude', 'settings.local.json');
    const r = await runScript('apply-settings.ts', {
      args: [file, 'channel-env', 'TELEGRAM', '/abs/state/telegram'],
    });
    expect(r.exitCode).toBe(0);
    expect(readSettings(file).env.TELEGRAM_STATE_DIR).toBe('/abs/state/telegram');
  });

  test('requires channel and state dir arguments', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {});
    const r = await runScript('apply-settings.ts', { args: [file, 'channel-env', 'DISCORD'] });
    expect(r.exitCode).not.toBe(0);
  });

  test('refuses to overwrite a malformed settings file', async () => {
    const dir = freshDir();
    const claude = path.join(dir, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    const file = path.join(claude, 'settings.local.json');
    const malformed = '{ not valid json !!';
    fs.writeFileSync(file, malformed);
    const r = await runScript('apply-settings.ts', {
      args: [file, 'channel-env', 'DISCORD', '/abs/state/discord'],
    });
    expect(r.exitCode).not.toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(malformed);
  });
});
