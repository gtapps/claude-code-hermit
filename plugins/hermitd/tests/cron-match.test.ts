// Unit tests for scripts/lib/cron-match.ts — pure 5-field cron matcher evaluated
// directly in a target timezone (no shiftCron). Pure exported functions, tested
// in-process per the repo convention (see tests/pause-lib.test.ts header).
//
// Usage: bun test tests/cron-match.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import {
  cronMatches, datePartsInTz,
  compileCron, cronMatchesCompiled, makeTzFormatter, partsFromFormatter,
} from '../scripts/lib/cron-match';

const W = new Date('2026-01-15T12:00:00Z'); // winter reference
const S = new Date('2026-07-15T12:00:00Z'); // summer reference

describe('datePartsInTz', () => {
  test('UTC — exact parts', () => {
    expect(datePartsInTz(new Date('2026-07-15T09:05:00Z'), 'UTC')).toEqual({
      minute: 5, hour: 9, dom: 15, month: 7, dow: 3, // 2026-07-15 is a Wednesday
    });
  });

  test('null tz falls back to machine-local (TZ env)', () => {
    // process TZ is inherited by bun test's Intl — assert internal consistency
    // rather than a specific offset, since CI machine TZ is unspecified.
    const withTz = datePartsInTz(S, Intl.DateTimeFormat().resolvedOptions().timeZone);
    const withNull = datePartsInTz(S, null);
    expect(withNull).toEqual(withTz);
  });

  test('invalid tz → null', () => {
    expect(datePartsInTz(S, 'Not/A_Zone')).toBeNull();
  });

  test('Asia/Kolkata half-hour offset', () => {
    // 09:00 UTC + 5:30 = 14:30 IST
    expect(datePartsInTz(new Date('2026-07-15T09:00:00Z'), 'Asia/Kolkata')).toMatchObject({
      hour: 14, minute: 30,
    });
  });

  test('DOW: Sunday maps to 0', () => {
    // 2026-07-19 is a Sunday
    expect(datePartsInTz(new Date('2026-07-19T12:00:00Z'), 'UTC')!.dow).toBe(0);
  });
});

describe('cronMatches', () => {
  test('exact minute match', () => {
    const parts = datePartsInTz(new Date('2026-07-15T09:05:00Z'), 'UTC')!;
    expect(cronMatches('5 9 * * *', parts)).toBe(true);
    expect(cronMatches('6 9 * * *', parts)).toBe(false);
  });

  test('DOW 0 and 7 both match Sunday', () => {
    const parts = datePartsInTz(new Date('2026-07-19T09:05:00Z'), 'UTC')!; // Sunday
    expect(cronMatches('5 9 * * 0', parts)).toBe(true);
    expect(cronMatches('5 9 * * 7', parts)).toBe(true);
    expect(cronMatches('5 9 * * 1', parts)).toBe(false);
  });

  test('step pattern */15', () => {
    const at0 = datePartsInTz(new Date('2026-07-15T09:00:00Z'), 'UTC')!;
    const at10 = datePartsInTz(new Date('2026-07-15T09:10:00Z'), 'UTC')!;
    const at15 = datePartsInTz(new Date('2026-07-15T09:15:00Z'), 'UTC')!;
    expect(cronMatches('*/15 * * * *', at0)).toBe(true);
    expect(cronMatches('*/15 * * * *', at10)).toBe(false);
    expect(cronMatches('*/15 * * * *', at15)).toBe(true);
  });

  test('range and list', () => {
    const parts = datePartsInTz(new Date('2026-07-15T14:00:00Z'), 'UTC')!; // hour 14
    expect(cronMatches('0 9-17 * * *', parts)).toBe(true);
    expect(cronMatches('0 8,14,20 * * *', parts)).toBe(true);
    expect(cronMatches('0 20-23 * * *', parts)).toBe(false);
  });

  test('DOM + month restriction', () => {
    const parts = datePartsInTz(new Date('2026-07-15T09:00:00Z'), 'UTC')!; // Jul 15
    expect(cronMatches('0 9 15 7 *', parts)).toBe(true);
    expect(cronMatches('0 9 15 8 *', parts)).toBe(false);
    expect(cronMatches('0 9 16 7 *', parts)).toBe(false);
  });

  test('malformed expression (wrong field count) → false, no throw', () => {
    const parts = datePartsInTz(W, 'UTC')!;
    expect(cronMatches('0 9 * *', parts)).toBe(false);
  });

  test('spring-forward skipped hour: schedule inside it never matches that day', () => {
    // America/New_York, 2026-03-08: local clocks jump 01:59 EST → 03:00 EDT at
    // 2026-03-08T07:00:00Z. Local hour 2 never occurs that day — a schedule of
    // "30 2 * * *" has zero matching wall-clock minutes. This is the accepted,
    // once-a-year miss documented in the plan's Risks section (asymmetric with
    // the fall-back double fire) — pinned here as intentional, not a bug.
    let anyHourTwo = false;
    for (let t = new Date('2026-03-08T04:00:00Z').getTime(); t <= new Date('2026-03-08T10:00:00Z').getTime(); t += 60000) {
      const parts = datePartsInTz(new Date(t), 'America/New_York');
      if (parts && parts.hour === 2) anyHourTwo = true;
      if (parts) expect(cronMatches('30 2 * * *', parts)).toBe(false);
    }
    expect(anyHourTwo).toBe(false); // confirms the local hour truly never occurs
  });

  test('fall-back: repeated wall-clock minute matches twice (documented double fire)', () => {
    // America/New_York, 2026-11-01: clocks fall back 01:59 EDT → 01:00 EST at
    // 2026-11-01T05:00:00Z (repeats local 01:00-01:59 twice). A schedule at
    // "30 1 * * *" matches on both UTC passes through that wall-clock minute.
    const beforeFallback = datePartsInTz(new Date('2026-11-01T05:30:00Z'), 'America/New_York')!;
    const afterFallback = datePartsInTz(new Date('2026-11-01T06:30:00Z'), 'America/New_York')!;
    expect(beforeFallback.hour).toBe(1);
    expect(afterFallback.hour).toBe(1);
    expect(cronMatches('30 1 * * *', beforeFallback)).toBe(true);
    expect(cronMatches('30 1 * * *', afterFallback)).toBe(true);
  });
});

// The compiled two-tier interface (compileCron / cronMatchesCompiled) that routine-due.ts
// uses in its hot loop — exercised directly, not just through the cronMatches wrapper.
describe('compileCron / cronMatchesCompiled', () => {
  test('malformed exprs return null (no throw)', () => {
    expect(compileCron('0 9 * *')).toBeNull();       // 4 fields
    expect(compileCron('0 9 * * * *')).toBeNull();   // 6 fields
    expect(compileCron('*/0 * * * *')).toBeNull();   // step base 0
    expect(compileCron('99 9 * * *')).toBeNull();    // minute out of range
  });

  test('DOW 7 normalizes to 0 (Sunday)', () => {
    const c = compileCron('5 9 * * 7')!;
    expect(c.dow.has(0)).toBe(true);
    expect(c.dow.has(7)).toBe(true);
    const sunday = datePartsInTz(new Date('2026-07-19T09:05:00Z'), 'UTC')!; // Sunday → dow 0
    expect(cronMatchesCompiled(c, sunday)).toBe(true);
    const monday = datePartsInTz(new Date('2026-07-20T09:05:00Z'), 'UTC')!;
    expect(cronMatchesCompiled(c, monday)).toBe(false);
  });

  test('compiled match agrees with the cronMatches wrapper', () => {
    const parts = datePartsInTz(new Date('2026-07-15T09:05:00Z'), 'UTC')!;
    const c = compileCron('5 9 * * *')!;
    expect(cronMatchesCompiled(c, parts)).toBe(true);
    expect(cronMatchesCompiled(c, parts)).toBe(cronMatches('5 9 * * *', parts));
  });
});

describe('makeTzFormatter / partsFromFormatter', () => {
  test('reused formatter yields the same parts as the single-shot datePartsInTz', () => {
    const fmt = makeTzFormatter('UTC')!;
    const d = new Date('2026-07-15T09:05:00Z');
    expect(partsFromFormatter(fmt, d)).toEqual(datePartsInTz(d, 'UTC'));
  });

  test('bad tz → makeTzFormatter returns null', () => {
    expect(makeTzFormatter('Not/A_Zone')).toBeNull();
  });
});
