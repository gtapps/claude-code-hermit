// Unit tests for scripts/lib/budget.ts — pure, no I/O, imported in-process.
//
// Detection matrix: 80%/100% thresholds x daily/weekly/monthly x alert/pause.
// Boundary tests: pauseBoundary picks the most-binding (longest) breached window
// and resolves it to the correct next calendar boundary in a non-UTC timezone.

import { describe, test, expect } from 'bun:test';
import { evaluateBudget, pauseBoundary } from '../scripts/lib/budget';

const NY = 'America/New_York';
// Saturday 2026-07-04, 18:17 America/New_York (22:17 UTC)
const REF = new Date('2026-07-04T22:17:00Z');
// Monday 2026-07-06, 11:00 America/New_York
const REF_MONDAY = new Date('2026-07-06T15:00:00Z');

describe('evaluateBudget — detection matrix', () => {
  test('below warn threshold on all periods -> level none, empty periods', () => {
    const r = evaluateBudget({
      dailySpend: 1, weeklySpend: 5, monthlySpend: 10,
      caps: { daily_usd: 5, weekly_usd: 25, monthly_usd: 100 },
      action: 'alert',
    });
    expect(r.level).toBe('none');
    expect(r.periods).toEqual([]);
  });

  for (const period of ['daily', 'weekly', 'monthly'] as const) {
    test(`${period} at exactly 80% of its cap -> warn`, () => {
      const spends = { dailySpend: 0, weeklySpend: 0, monthlySpend: 0 };
      const caps = { daily_usd: null, weekly_usd: null, monthly_usd: null } as any;
      const key = `${period}Spend` as keyof typeof spends;
      const capKey = `${period}_usd` as keyof typeof caps;
      (spends as any)[key] = 8;
      caps[capKey] = 10;
      const r = evaluateBudget({ ...spends, caps, action: 'alert' });
      expect(r.level).toBe('warn');
      expect(r.periods).toEqual([{ period, spend: 8, cap: 10, ratio: 0.8, level: 'warn' }]);
    });

    test(`${period} at exactly 100% of its cap -> breach`, () => {
      const spends = { dailySpend: 0, weeklySpend: 0, monthlySpend: 0 };
      const caps = { daily_usd: null, weekly_usd: null, monthly_usd: null } as any;
      const key = `${period}Spend` as keyof typeof spends;
      const capKey = `${period}_usd` as keyof typeof caps;
      (spends as any)[key] = 10;
      caps[capKey] = 10;
      const r = evaluateBudget({ ...spends, caps, action: 'pause' });
      expect(r.level).toBe('breach');
      expect(r.periods).toEqual([{ period, spend: 10, cap: 10, ratio: 1, level: 'breach' }]);
      expect(r.action).toBe('pause');
    });

    test(`${period} just under 80% of its cap -> none`, () => {
      const spends = { dailySpend: 0, weeklySpend: 0, monthlySpend: 0 };
      const caps = { daily_usd: null, weekly_usd: null, monthly_usd: null } as any;
      const key = `${period}Spend` as keyof typeof spends;
      const capKey = `${period}_usd` as keyof typeof caps;
      (spends as any)[key] = 7.99;
      caps[capKey] = 10;
      const r = evaluateBudget({ ...spends, caps, action: 'alert' });
      expect(r.level).toBe('none');
    });
  }

  test('unset cap (null) is never evaluated regardless of spend', () => {
    const r = evaluateBudget({
      dailySpend: 1000, weeklySpend: 1000, monthlySpend: 1000,
      caps: { daily_usd: null, weekly_usd: null, monthly_usd: null },
      action: 'alert',
    });
    expect(r.level).toBe('none');
    expect(r.periods).toEqual([]);
  });

  test('a zero or negative cap is treated as unset (never evaluated)', () => {
    const r = evaluateBudget({
      dailySpend: 1, weeklySpend: 1, monthlySpend: 1,
      caps: { daily_usd: 0, weekly_usd: -5 as any, monthly_usd: null },
      action: 'alert',
    });
    expect(r.level).toBe('none');
  });

  test('multiple periods breaching at once are all reported, most-binding first', () => {
    const r = evaluateBudget({
      dailySpend: 6, weeklySpend: 20, monthlySpend: 150,
      caps: { daily_usd: 5, weekly_usd: 50, monthly_usd: 100 },
      action: 'pause',
    });
    expect(r.level).toBe('breach');
    expect(r.periods.map(p => p.period)).toEqual(['monthly', 'daily']); // weekly (0.4) below warn, excluded
    expect(r.periods.find(p => p.period === 'monthly')?.level).toBe('breach');
    expect(r.periods.find(p => p.period === 'daily')?.level).toBe('breach');
  });

  test('a breach on one period and a warn on another are both reported at their own level', () => {
    const r = evaluateBudget({
      dailySpend: 6, weeklySpend: 45, monthlySpend: 10,
      caps: { daily_usd: 5, weekly_usd: 50, monthly_usd: 1000 },
      action: 'alert',
    });
    expect(r.level).toBe('breach'); // overall level reflects the worst period
    const daily = r.periods.find(p => p.period === 'daily');
    const weekly = r.periods.find(p => p.period === 'weekly');
    expect(daily?.level).toBe('breach');
    expect(weekly?.level).toBe('warn');
  });

  test('action defaults to "alert" when omitted or not "pause"', () => {
    const r1 = evaluateBudget({ dailySpend: 10, weeklySpend: 0, monthlySpend: 0, caps: { daily_usd: 5 } });
    expect(r1.action).toBe('alert');
    const r2 = evaluateBudget({ dailySpend: 10, weeklySpend: 0, monthlySpend: 0, caps: { daily_usd: 5 }, action: 'bogus' as any });
    expect(r2.action).toBe('alert');
  });
});

describe('pauseBoundary — most-binding window + tz correctness', () => {
  test('daily-only breach resolves to next local midnight', () => {
    const until = pauseBoundary(['daily'], NY, REF);
    expect(until).toBe('2026-07-05T04:00:00.000Z'); // 2026-07-05 00:00 America/New_York (EDT, UTC-4)
  });

  test('weekly-only breach resolves to next Monday local midnight', () => {
    const until = pauseBoundary(['weekly'], NY, REF);
    expect(until).toBe('2026-07-06T04:00:00.000Z');
  });

  test('monthly-only breach resolves to the 1st of next month', () => {
    const until = pauseBoundary(['monthly'], NY, REF);
    expect(until).toBe('2026-08-01T04:00:00.000Z');
  });

  test('daily + weekly breach together -> weekly (longer window) wins', () => {
    const until = pauseBoundary(['daily', 'weekly'], NY, REF);
    expect(until).toBe(pauseBoundary(['weekly'], NY, REF));
  });

  test('all three breach together -> monthly (longest window) wins', () => {
    const until = pauseBoundary(['daily', 'weekly', 'monthly'], NY, REF);
    expect(until).toBe(pauseBoundary(['monthly'], NY, REF));
  });

  test('weekly breach on a Monday itself resolves a full week ahead, not today', () => {
    const until = pauseBoundary(['weekly'], NY, REF_MONDAY);
    expect(until).toBe('2026-07-13T04:00:00.000Z');
  });

  test('empty breached-periods list resolves to null', () => {
    expect(pauseBoundary([], NY, REF)).toBeNull();
  });
});
