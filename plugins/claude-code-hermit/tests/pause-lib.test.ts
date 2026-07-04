// Unit tests for scripts/lib/pause.ts — the binding pause/stop/resume flag
// (PROP-015). Pure exported helpers, so tested in-process (not via runScript)
// per the repo convention (see tests/hooks.contract.test.ts header).
//
// Usage: bun test tests/pause-lib.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isPaused, setPause, clearPause, pausePath, parseSnoozeDuration } from '../scripts/lib/pause';

function withTmpHermitRoot(fn: (dir: string) => void) {
  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-pauselib-'));
    try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

describe('isPaused', () => {
  test('missing pause.json — unpaused', withTmpHermitRoot((dir) => {
    expect(isPaused(dir)).toEqual({ paused: false });
  }));

  test('after setPause (indefinite) — paused, until null', withTmpHermitRoot((dir) => {
    setPause(dir, { reason: 'operator', by: 'alice' });
    const status = isPaused(dir);
    expect(status.paused).toBe(true);
    expect(status.reason).toBe('operator');
    expect(status.by).toBe('alice');
    expect(status.until).toBeNull();
    expect(typeof status.ts).toBe('string');
  }));

  test('after clearPause — unpaused, file removed', withTmpHermitRoot((dir) => {
    setPause(dir, { reason: 'operator', by: 'alice' });
    expect(fs.existsSync(pausePath(dir))).toBe(true);
    clearPause(dir);
    expect(fs.existsSync(pausePath(dir))).toBe(false);
    expect(isPaused(dir)).toEqual({ paused: false });
  }));

  test('clearPause on an already-absent flag is a no-op (idempotent)', withTmpHermitRoot((dir) => {
    expect(() => clearPause(dir)).not.toThrow();
    expect(isPaused(dir)).toEqual({ paused: false });
  }));

  test('paused_until in the future — still paused', withTmpHermitRoot((dir) => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    setPause(dir, { reason: 'budget', by: 'watchdog', until });
    const status = isPaused(dir);
    expect(status.paused).toBe(true);
    expect(status.until).toBe(until);
    expect(status.reason).toBe('budget');
  }));

  test('paused_until in the past — reader-side expiry, reads as unpaused', withTmpHermitRoot((dir) => {
    const until = new Date(Date.now() - 3600_000).toISOString();
    setPause(dir, { reason: 'operator', by: 'alice', until });
    expect(isPaused(dir)).toEqual({ paused: false });
  }));

  test('flag with paused:false explicitly — unpaused', withTmpHermitRoot((dir) => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(pausePath(dir), JSON.stringify({ paused: false, paused_until: null, reason: 'operator', by: 'x', ts: 'x' }));
    expect(isPaused(dir)).toEqual({ paused: false });
  }));

  test('corrupt pause.json — fail-open, reads as unpaused', withTmpHermitRoot((dir) => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(pausePath(dir), '{not valid json');
    expect(isPaused(dir)).toEqual({ paused: false });
  }));

  test('pause.json is a JSON array — fail-open, reads as unpaused', withTmpHermitRoot((dir) => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(pausePath(dir), '[1,2,3]');
    expect(isPaused(dir)).toEqual({ paused: false });
  }));

  test('setPause writes atomically — no leftover .tmp file', withTmpHermitRoot((dir) => {
    setPause(dir, { reason: 'operator', by: 'alice' });
    const files = fs.readdirSync(path.join(dir, 'state'));
    expect(files).toEqual(['pause.json']);
  }));

  test('setPause twice — second call overwrites (new reason/by)', withTmpHermitRoot((dir) => {
    setPause(dir, { reason: 'operator', by: 'alice' });
    setPause(dir, { reason: 'watchdog', by: 'system' });
    const status = isPaused(dir);
    expect(status.reason).toBe('watchdog');
    expect(status.by).toBe('system');
  }));
});

describe('parseSnoozeDuration', () => {
  test.each([
    ['30m', 30 * 60_000],
    ['2h', 2 * 3_600_000],
    ['1d', 24 * 3_600_000],
    ['45s', 45_000],
    ['1.5h', 1.5 * 3_600_000],
    ['2H', 2 * 3_600_000], // case-insensitive unit
    ['  10m  ', 10 * 60_000], // tolerant of surrounding whitespace
  ])('parses %s -> %d ms', (input, expected) => {
    expect(parseSnoozeDuration(input)).toBe(expected);
  });

  test.each([
    [''],
    ['abc'],
    ['30'],       // no unit
    ['30x'],      // unknown unit
    ['-5m'],      // negative
    ['5 m extra'],
    ['0m'],       // zero — would write a paused_until that reads as immediately expired
    ['0s'],
    ['0.0h'],
    ['99999999999d'], // absurdly large — would overflow Date and throw on toISOString
  ])('rejects %j -> null', (input) => {
    expect(parseSnoozeDuration(input)).toBeNull();
  });
});
