// WP7 tier 1: tests for src/config.ts — 1:1 port of tests/test_config.py
// (5 cases), plus .env-parser parity cases for the manual dotenv port.
//
// pytest fixture mapping: tmp_path -> mkdtempSync, monkeypatch.setenv/delenv
// -> save/restore process.env, `_load_policy_overrides.cache_clear()` ->
// clearPolicyCaches().

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, parseEnvText, saveEnvFile } from '../src/config';
import { Severity, classifyEntity, clearPolicyCaches } from '../src/policy';

const tmpDirs: string[] = [];
const savedEnv = process.env.HOMEASSISTANT_URL;

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ha-config-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (savedEnv === undefined) delete process.env.HOMEASSISTANT_URL;
  else process.env.HOMEASSISTANT_URL = savedEnv;
  clearPolicyCaches();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('env var priority over env file', () => {
  const root = tmpPath();
  saveEnvFile(root, { HOMEASSISTANT_URL: 'http://from-file:8123' });
  process.env.HOMEASSISTANT_URL = 'http://from-env:8123';
  const config = loadConfig(root);
  expect(config.haUrl).toBe('http://from-env:8123');
});

test('env file fallback when env var absent', () => {
  const root = tmpPath();
  saveEnvFile(root, { HOMEASSISTANT_URL: 'http://from-file:8123' });
  delete process.env.HOMEASSISTANT_URL;
  const config = loadConfig(root);
  expect(config.haUrl).toBe('http://from-file:8123');
});

test('safe entities override bypasses sensitive domain', () => {
  const root = tmpPath();
  saveEnvFile(root, { HA_SAFE_ENTITIES: 'cover.garage_door' });
  clearPolicyCaches();
  const [sev] = classifyEntity('cover.garage_door', root);
  expect(sev).toBe(Severity.ALLOW);
  clearPolicyCaches();
});

test('extra sensitive domains blocks new domain', () => {
  const root = tmpPath();
  saveEnvFile(root, { HA_EXTRA_SENSITIVE_DOMAINS: 'vacuum' });
  clearPolicyCaches();
  const [sev] = classifyEntity('vacuum.roomba', root);
  expect(sev).not.toBe(Severity.ALLOW);
  clearPolicyCaches();
});

test('extra sensitive keywords blocks matching entity', () => {
  const root = tmpPath();
  saveEnvFile(root, { HA_EXTRA_SENSITIVE_KEYWORDS: 'pool' });
  clearPolicyCaches();
  const [sev] = classifyEntity('switch.pool_pump', root);
  expect(sev).not.toBe(Severity.ALLOW);
  clearPolicyCaches();
});

// ---------------------------------------------------------------------------
// .env parser parity (manual port of python-dotenv dotenv_values — these
// pin the semantics the explicit loader must keep; verified against
// python-dotenv when writing the port)
// ---------------------------------------------------------------------------

describe('parseEnvText (python-dotenv parity)', () => {
  test('plain, export prefix, padded, empty, bare keys', () => {
    expect(
      parseEnvText('# comment\nA=1\nexport B=yes\nC = padded value\nEMPTY=\nNOVALUE\n'),
    ).toEqual({ A: '1', B: 'yes', C: 'padded value', EMPTY: '', NOVALUE: null });
  });

  test('double quotes decode escapes; single quotes are literal', () => {
    expect(parseEnvText('DQ="a\\nb # kept"\nSQ=\'lit\\n $HOME\'\n')).toEqual({
      DQ: 'a\nb # kept',
      SQ: 'lit\\n $HOME',
    });
  });

  test('inline comments: stripped after whitespace, kept when glued', () => {
    expect(parseEnvText('A=value # comment\nB=value#kept\nC="abc" # comment\n')).toEqual({
      A: 'value',
      B: 'value#kept',
      C: 'abc',
    });
  });

  test('quoted values may span lines', () => {
    expect(parseEnvText('M="line1\nline2"\n')).toEqual({ M: 'line1\nline2' });
  });
});
