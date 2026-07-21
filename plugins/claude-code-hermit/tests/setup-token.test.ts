// Long-lived setup-token storage, expiry record, and the doctor probe.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run';
import {
  installToken,
  isPlausibleToken,
  msUntilExpiry,
  readTokenRecord,
  readTokenValue,
  tokenFilePath,
  tokenModeActive,
  TOKEN_ENV_VAR,
} from '../scripts/lib/setup-token';

const VALID = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-token-test-'));
}

function withDirs<T>(fn: (hermitDir: string, configDir: string) => T): () => T {
  return () => {
    const root = tmpdir();
    try {
      const hermitDir = path.join(root, '.claude-code-hermit');
      const configDir = path.join(root, 'config');
      fs.mkdirSync(hermitDir, { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
      return fn(hermitDir, configDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('token storage', () => {
  test('installs the token 0600 and writes a 1-year record', withDirs((hermitDir, configDir) => {
    const before = Date.now();
    const record = installToken(hermitDir, configDir, VALID);

    expect(readTokenValue(configDir)).toBe(VALID);

    // The token is a bearer credential sitting on a shared volume; anything
    // group- or world-readable here is a real leak.
    const mode = fs.statSync(tokenFilePath(configDir)).mode & 0o777;
    expect(mode).toBe(0o600);

    const ttlDays = (Date.parse(record.expires_at) - Date.parse(record.minted_at)) / 86400000;
    expect(Math.round(ttlDays)).toBe(365);
    expect(Date.parse(record.minted_at)).toBeGreaterThanOrEqual(before - 1000);
  }));

  test('the record round-trips and reports remaining time', withDirs((hermitDir, configDir) => {
    installToken(hermitDir, configDir, VALID);
    const record = readTokenRecord(hermitDir);
    expect(record).not.toBeNull();
    const left = msUntilExpiry(hermitDir);
    expect(left).not.toBeNull();
    expect(left! / 86400000).toBeGreaterThan(360);
  }));

  test('the record never contains the token', withDirs((hermitDir, configDir) => {
    installToken(hermitDir, configDir, VALID);
    const raw = fs.readFileSync(path.join(hermitDir, 'state', 'setup-token.json'), 'utf8');
    expect(raw).not.toContain(VALID);
  }));

  test('a re-install overwrites cleanly and moves expiry forward', withDirs((hermitDir, configDir) => {
    const first = installToken(hermitDir, configDir, VALID);
    const second = installToken(hermitDir, configDir, `${VALID}-two`);
    expect(readTokenValue(configDir)).toBe(`${VALID}-two`);
    expect(Date.parse(second.expires_at)).toBeGreaterThanOrEqual(Date.parse(first.expires_at));
    // No .tmp litter left behind by the atomic write.
    expect(fs.existsSync(`${tokenFilePath(configDir)}.tmp`)).toBe(false);
  }));

  test('absent or malformed record reads as null, never as expired', withDirs((hermitDir) => {
    expect(readTokenRecord(hermitDir)).toBeNull();
    expect(msUntilExpiry(hermitDir)).toBeNull();
    fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(hermitDir, 'state', 'setup-token.json'), '{not json');
    expect(readTokenRecord(hermitDir)).toBeNull();
    fs.writeFileSync(path.join(hermitDir, 'state', 'setup-token.json'), JSON.stringify({ expires_at: 'soon' }));
    expect(readTokenRecord(hermitDir)).toBeNull();
  }));
});

describe('token shape validation', () => {
  // The mint driver scrapes a terminal pane, so the realistic failure is
  // capturing prose or a truncated fragment. Installing either takes the hermit
  // dark, so refuse at the door.
  test('rejects implausible values', () => {
    expect(isPlausibleToken(VALID)).toBe(true);
    expect(isPlausibleToken('')).toBe(false);
    expect(isPlausibleToken('sk-ant-short')).toBe(false);
    expect(isPlausibleToken('Paste code here if prompted >')).toBe(false);
    expect(isPlausibleToken('sk-ant-oat01-abcdefghij klmnopqrstuvwxyz')).toBe(false);
    expect(isPlausibleToken('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(false);
  });

  test('install refuses an implausible token', withDirs((hermitDir, configDir) => {
    expect(() => installToken(hermitDir, configDir, 'not a token')).toThrow();
    expect(readTokenValue(configDir)).toBeNull();
    expect(readTokenRecord(hermitDir)).toBeNull();
  }));
});

describe('auth-mode detection', () => {
  test('file presence alone means token mode', withDirs((hermitDir, configDir) => {
    const saved = process.env[TOKEN_ENV_VAR];
    delete process.env[TOKEN_ENV_VAR];
    try {
      expect(tokenModeActive(configDir)).toBe(false);
      installToken(hermitDir, configDir, VALID);
      // The docker entrypoint runs before anything exports the env var, so the
      // file has to be sufficient on its own.
      expect(tokenModeActive(configDir)).toBe(true);
    } finally {
      if (saved !== undefined) process.env[TOKEN_ENV_VAR] = saved;
    }
  }));

  test('env var alone means token mode', withDirs((_hermitDir, configDir) => {
    const saved = process.env[TOKEN_ENV_VAR];
    process.env[TOKEN_ENV_VAR] = VALID;
    try {
      expect(tokenModeActive(configDir)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[TOKEN_ENV_VAR];
      else process.env[TOKEN_ENV_VAR] = saved;
    }
  }));
});

describe('doctor expiry probe', () => {
  const probe = async (hermitDir: string) =>
    (await runScript('setup-token-probe.ts', { args: [hermitDir] })).stdout.trim();

  test('no record → OK (not token mode is not a problem)', async () => {
    const root = tmpdir();
    try {
      expect(await probe(path.join(root, '.claude-code-hermit'))).toBe('OK');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('record present → EXPIRES:<iso> matching the record', async () => {
    const root = tmpdir();
    try {
      const hermitDir = path.join(root, '.claude-code-hermit');
      const configDir = path.join(root, 'config');
      fs.mkdirSync(hermitDir, { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
      const record = installToken(hermitDir, configDir, VALID);
      expect(await probe(hermitDir)).toBe(`EXPIRES:${record.expires_at}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('probe prints exactly one line (doctor parses only the first)', async () => {
    const root = tmpdir();
    try {
      const hermitDir = path.join(root, '.claude-code-hermit');
      const configDir = path.join(root, 'config');
      fs.mkdirSync(hermitDir, { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
      installToken(hermitDir, configDir, VALID);
      const out = (await runScript('setup-token-probe.ts', { args: [hermitDir] })).stdout;
      expect(out.trim().split('\n')).toHaveLength(1);
      expect(out).not.toContain(VALID);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
