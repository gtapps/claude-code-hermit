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

  test('after clearPause — unpaused, files removed', withTmpHermitRoot((dir) => {
    setPause(dir, { reason: 'operator', by: 'alice' });
    expect(isPaused(dir).paused).toBe(true);
    clearPause(dir);
    expect(isPaused(dir)).toEqual({ paused: false });
    expect(fs.readdirSync(path.join(dir, 'state'))).toEqual([]);
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

  test('setPause writes atomically — no leftover .tmp file (operator -> operator-pause.json)', withTmpHermitRoot((dir) => {
    setPause(dir, { reason: 'operator', by: 'alice' });
    const files = fs.readdirSync(path.join(dir, 'state'));
    expect(files).toEqual(['operator-pause.json']);
  }));

  test('setPause twice same tier — second call overwrites (new reason/by)', withTmpHermitRoot((dir) => {
    setPause(dir, { reason: 'operator', by: 'alice' });
    setPause(dir, { reason: 'watchdog', by: 'system' }); // same (manual) tier -> same file
    const status = isPaused(dir);
    expect(status.reason).toBe('watchdog');
    expect(status.by).toBe('system');
  }));

  // File-split precedence: a budget pause writes auto-pause.json and can NEVER touch
  // the operator-pause.json file, so an operator "stop" is structurally safe from a
  // concurrent budget-breach tick — the TOCTOU fix.
  test('budget pause writes auto-pause.json, leaving an operator stop intact', withTmpHermitRoot((dir) => {
    setPause(dir, { reason: 'operator', by: 'alice' }); // indefinite operator stop
    setPause(dir, { reason: 'budget', by: 'cost-tracker', until: '2999-01-01T00:00:00Z' });
    const files = fs.readdirSync(path.join(dir, 'state')).sort();
    expect(files).toEqual(['auto-pause.json', 'operator-pause.json']);
    const status = isPaused(dir);
    expect(status.reason).toBe('operator'); // higher priority wins
    expect(status.until).toBeNull();         // still the indefinite stop
  }));

  test('with only a budget pause, isPaused reports it', withTmpHermitRoot((dir) => {
    setPause(dir, { reason: 'budget', by: 'cost-tracker', until: '2999-01-01T00:00:00Z' });
    expect(isPaused(dir).reason).toBe('budget');
  }));

  test('an EXPIRED operator pause does not mask an active budget pause', withTmpHermitRoot((dir) => {
    setPause(dir, { reason: 'operator', by: 'alice', until: '2000-01-01T00:00:00Z' }); // lapsed
    setPause(dir, { reason: 'budget', by: 'cost-tracker', until: '2999-01-01T00:00:00Z' });
    expect(isPaused(dir).reason).toBe('budget');
  }));

  test('clearPause removes every tier + the legacy file', withTmpHermitRoot((dir) => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(pausePath(dir), JSON.stringify({ paused: true, paused_until: null, reason: 'operator', by: 'legacy', ts: 'x' }));
    setPause(dir, { reason: 'budget', by: 'cost-tracker', until: '2999-01-01T00:00:00Z' });
    clearPause(dir);
    expect(isPaused(dir)).toEqual({ paused: false });
    expect(fs.readdirSync(path.join(dir, 'state'))).toEqual([]);
  }));

  // Migration: a pause in force in the legacy pause.json (written before the split)
  // is still honored until the operator resumes.
  test('legacy pause.json is still read (upgrade migration)', withTmpHermitRoot((dir) => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(pausePath(dir), JSON.stringify({ paused: true, paused_until: null, reason: 'operator', by: 'legacy', ts: 'x' }));
    expect(isPaused(dir).paused).toBe(true);
    expect(isPaused(dir).reason).toBe('operator');
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
