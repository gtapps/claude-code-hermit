// Tests for scripts/lib/format.ts: kStr/formatTokens magnitude selection.
// Guards against the #511 regression (532431000 tokens mislabeled as "532.4K").

import { describe, test, expect } from 'bun:test';
import { kStr, formatTokens } from '../scripts/lib/format';

describe('kStr', () => {
  test('zero', () => {
    expect(kStr(0)).toBe('0');
  });

  test('sub-1000 raw', () => {
    expect(kStr(999)).toBe('999');
  });

  test('K range: decimal under 100K, integer at/above', () => {
    expect(kStr(45000)).toBe('45.0K');
    expect(kStr(304000)).toBe('304K');
  });

  test('M range: decimal under 100M, integer at/above', () => {
    expect(kStr(3310000)).toBe('3.3M');
    expect(kStr(532431000)).toBe('532M');
  });

  test('B range', () => {
    expect(kStr(2156563000)).toBe('2.2B');
  });

  test('tier-boundary rounding promotes instead of overflowing to 1000', () => {
    expect(kStr(999999)).toBe('1.0M');
    expect(kStr(999500)).toBe('1.0M');
    expect(kStr(999499)).toBe('999K');
    expect(kStr(999999999)).toBe('1.0B');
  });
});

describe('formatTokens', () => {
  test('appends " tokens" to the magnitude-suffixed value', () => {
    expect(formatTokens(0)).toBe('0 tokens');
    expect(formatTokens(45000)).toBe('45.0K tokens');
  });

  test('#511 regression: large day is labeled M, not a rescaled K', () => {
    expect(formatTokens(532431000)).toBe('532M tokens');
    expect(formatTokens(532431000)).not.toBe('532.4K tokens');
  });
});
