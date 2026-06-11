// WP7 tier 3: tests for src/boot.ts — 1:1 port of tests/test_boot.py
// (17 cases).
//
// pytest fixture mapping:
//   - tmp_path -> tmpPath (helpers.ts)
//   - patch("...probe_home_assistant_url", return_value=True) -> a fetch stub
//     that returns 200 (single-URL mode never actually probes)
//   - patch(..., side_effect=[False, True]) -> a fetch stub keyed by URL
//   - HomeAssistantClient(load_config(...)) raising -> the direct constructor
//     (config assertion runs before URL selection)
//
// _write_launcher is vestigial in the Python suite (command_prefix resolves
// against the real plugin root, which always has bin/ha-agent-lab) — dropped.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import {
  bootStatus,
  commandPrefix,
  operatorMdPath,
  readLanguage,
  saveBootPreferences,
  writeLanguage,
} from '../src/boot';
import { loadConfig } from '../src/config';
import { HomeAssistantClient, HomeAssistantError, selectHomeAssistantUrl } from '../src/ha-api';
import { cleanupTmp, tmpPath } from './helpers';

const ENV_KEYS = [
  'HOMEASSISTANT_URL',
  'HOMEASSISTANT_LOCAL_URL',
  'HOMEASSISTANT_REMOTE_URL',
  'HOMEASSISTANT_TOKEN',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  cleanupTmp();
});

const okFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

test('language roundtrip', () => {
  const tmp = tmpPath();
  writeLanguage(tmp, 'pt-PT');
  expect(readLanguage(tmp)).toBe('pt-PT');
  expect(operatorMdPath(tmp)).toBe(join(tmp, '.claude-code-hermit', 'OPERATOR.md'));
});

test('write_language creates OPERATOR.md with HA section', () => {
  const tmp = tmpPath();
  writeLanguage(tmp, 'en');
  const text = readFileSync(operatorMdPath(tmp), 'utf8');
  expect(text).toContain('# Operator Context');
  expect(text).toContain('## HA hermit');
  expect(text).toContain('- Language: en');
});

test('write_language appends section when OPERATOR.md exists without HA section', () => {
  const tmp = tmpPath();
  const operatorMd = operatorMdPath(tmp);
  mkdirSync(dirname(operatorMd), { recursive: true });
  writeFileSync(operatorMd, '# Operator Context\n\n## Other plugin\n\n- Foo: bar\n', 'utf8');

  writeLanguage(tmp, 'en');

  const text = readFileSync(operatorMd, 'utf8');
  expect(text).toContain('## Other plugin');
  expect(text).toContain('- Foo: bar');
  expect(text).toContain('## HA hermit');
  expect(text).toContain('- Language: en');
});

test('write_language appends line under existing HA section', () => {
  const tmp = tmpPath();
  const operatorMd = operatorMdPath(tmp);
  mkdirSync(dirname(operatorMd), { recursive: true });
  writeFileSync(operatorMd, '# Operator Context\n\n## HA hermit\n\n- Some other preference: x\n', 'utf8');

  writeLanguage(tmp, 'pt-PT');

  const text = readFileSync(operatorMd, 'utf8');
  expect(text).toContain('- Language: pt-PT');
  expect(text).toContain('- Some other preference: x');
});

test('write_language replaces existing language line', () => {
  const tmp = tmpPath();
  writeLanguage(tmp, 'en');
  writeLanguage(tmp, 'pt-PT');
  const text = readFileSync(operatorMdPath(tmp), 'utf8');
  expect(text.split('- Language:').length - 1).toBe(1);
  expect(text.split('## HA hermit').length - 1).toBe(1);
  expect(text).toContain('- Language: pt-PT');
  expect(text).not.toContain('- Language: en');
});

test('write_language ignores language line in other section', () => {
  const tmp = tmpPath();
  const operatorMd = operatorMdPath(tmp);
  mkdirSync(dirname(operatorMd), { recursive: true });
  writeFileSync(
    operatorMd,
    '# Operator Context\n\n## Other plugin\n\n- Language: not-a-locale\n\n## HA hermit\n\n- Language: en\n',
    'utf8',
  );

  writeLanguage(tmp, 'pt-PT');

  const text = readFileSync(operatorMd, 'utf8');
  expect(text).toContain('- Language: not-a-locale');
  expect(text).toContain('- Language: pt-PT');
  expect(text).not.toContain('- Language: en');
  expect(readLanguage(tmp)).toBe('pt-PT');
});

test('boot preferences store operator context', () => {
  const tmp = tmpPath();
  saveBootPreferences(tmp, {
    language: 'en',
    localUrl: 'http://ha.local:8123',
    remoteUrl: 'https://ha.example.com',
    token: 'secret-token',
  });
  const config = loadConfig(tmp);
  expect(config.haLocalUrl).toBe('http://ha.local:8123');
  expect(config.haRemoteUrl).toBe('https://ha.example.com');
  expect(config.haToken).toBe('secret-token');
  expect(readLanguage(tmp)).toBe('en');
});

test('boot status detects missing context', async () => {
  const tmp = tmpPath();
  writeLanguage(tmp, 'en');
  const config = loadConfig(tmp);
  const status = await bootStatus(config, { probe: false });
  expect(status.language).toBe('en');
  expect(status.needs_context_refresh).toBe(true);
  expect(status.context_exists).toBe(false);
});

test('boot status reports missing required setup', async () => {
  const tmp = tmpPath();
  const status = await bootStatus(loadConfig(tmp), { probe: false });
  const fields = new Set(status.setup_hints.map((item) => item.field));
  expect(fields).toContain('Language');
  expect(fields).toContain('HOMEASSISTANT_URL');
  expect(fields).toContain('HOMEASSISTANT_TOKEN');
  expect(status.command_prefix.endsWith('/bin/ha-agent-lab')).toBe(true);
  expect(status.can_refresh_context).toBe(false);
});

test('command_prefix returns absolute plugin launcher', () => {
  const prefix = commandPrefix();
  expect(prefix.endsWith('/bin/ha-agent-lab')).toBe(true);
  expect(isAbsolute(prefix)).toBe(true);
  expect(existsSync(prefix)).toBe(true);
});

test('boot status exposes single-pass setup checklist', async () => {
  const tmp = tmpPath();
  const status = await bootStatus(loadConfig(tmp), { probe: false });
  const checklist = Object.fromEntries(status.setup_checklist.map((item) => [item.field, item]));
  expect(checklist['Language']!.status).toBe('missing');
  expect(checklist['Language']!.location).toBe('.claude-code-hermit/OPERATOR.md');
  expect(checklist['Home Assistant endpoint']!.status).toBe('missing');
  expect(checklist['HOMEASSISTANT_TOKEN']!.status).toBe('missing');
  expect(checklist['Context snapshot']!.status).toBe('missing');
  expect(checklist['HOMEASSISTANT_REMOTE_URL']!.status).toBe('optional');
});

test('client reports exact missing configuration', () => {
  const tmp = tmpPath();
  let message = '';
  try {
    new HomeAssistantClient(loadConfig(tmp), 'http://unused', 'test');
  } catch (exc) {
    expect(exc).toBeInstanceOf(HomeAssistantError);
    message = (exc as HomeAssistantError).message;
  }
  expect(message).toContain('HOMEASSISTANT_URL');
  expect(message).toContain('HOMEASSISTANT_TOKEN');
  expect(message).toContain('./bin/ha-agent-lab boot status --probe');
});

test('client distinguishes missing token from missing endpoint', () => {
  const tmp = tmpPath();
  saveBootPreferences(tmp, { localUrl: 'http://ha.local:8123' });

  let message = '';
  try {
    new HomeAssistantClient(loadConfig(tmp), 'http://unused', 'test');
  } catch (exc) {
    expect(exc).toBeInstanceOf(HomeAssistantError);
    message = (exc as HomeAssistantError).message;
  }
  expect(message).toContain('HOMEASSISTANT_TOKEN');
  expect(message).not.toContain('HOMEASSISTANT_URL');
});

test('boot preferences store url', () => {
  const tmp = tmpPath();
  saveBootPreferences(tmp, { url: 'https://myha.nabu.casa' });
  const config = loadConfig(tmp);
  expect(config.haUrl).toBe('https://myha.nabu.casa');
  expect(config.hasHaEndpoint).toBe(true);
  expect(config.primaryUrl()).toBe('https://myha.nabu.casa');
});

test('select url single mode', async () => {
  const tmp = tmpPath();
  saveBootPreferences(tmp, { url: 'https://myha.nabu.casa', token: 'tok' });
  const config = loadConfig(tmp);
  const [url, source] = await selectHomeAssistantUrl(config, okFetch);
  expect(url).toBe('https://myha.nabu.casa');
  expect(source).toBe('single');
});

test('select url backcompat local url', async () => {
  const tmp = tmpPath();
  saveBootPreferences(tmp, { localUrl: 'http://ha.local:8123', token: 'tok' });
  const config = loadConfig(tmp);
  const [url, source] = await selectHomeAssistantUrl(config, okFetch);
  expect(url).toBe('http://ha.local:8123');
  expect(source).toBe('single');
});

test('select url dual mode falls back to remote', async () => {
  const tmp = tmpPath();
  saveBootPreferences(tmp, {
    localUrl: 'http://ha.local:8123',
    remoteUrl: 'https://ha.remote.com',
    token: 'tok',
  });
  const config = loadConfig(tmp);
  // probe side_effect=[False, True]: local unreachable, remote reachable
  const dualFetch = (async (url: string | URL | Request) => {
    if (String(url).startsWith('http://ha.local:8123')) throw new Error('unreachable');
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const [url, source] = await selectHomeAssistantUrl(config, dualFetch);
  expect(url).toBe('https://ha.remote.com');
  expect(source).toBe('remote');
});
