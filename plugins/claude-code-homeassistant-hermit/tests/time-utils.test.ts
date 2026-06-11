// WP7 tier 1: tests for src/time-utils.ts.
//
// 1:1 port of the time_utils cases in tests/test_silence.py (the `# --- parse_iso ---`
// and `# --- days_since ---` sections — time_utils.py has no dedicated pytest file).
// Python asserted `dt.utcoffset() == 0` for the Z suffix; JS Dates are tz-less
// instants, so the equivalent assertion is the exact UTC instant.

import { expect, test } from 'bun:test';

import { daysSince, parseIso } from '../src/time-utils';

const NOW = new Date(Date.UTC(2026, 4, 14, 12, 0, 0));

// --- parse_iso ---

test('parse_iso handles Z suffix', () => {
  const dt = parseIso('2026-05-14T12:00:00Z');
  expect(dt).not.toBeNull();
  expect(dt!.getTime()).toBe(NOW.getTime());
});

test('parse_iso returns null on malformed', () => {
  expect(parseIso('not-a-date')).toBeNull();
  expect(parseIso(null)).toBeNull();
  expect(parseIso('')).toBeNull();
});

// --- days_since ---

test('days_since returns null when then is null', () => {
  expect(daysSince(NOW, null)).toBeNull();
});

test('days_since computes integer days', () => {
  const then = new Date(NOW.getTime() - (3 * 24 + 6) * 3_600_000);
  expect(daysSince(NOW, then)).toBe(3);
});
