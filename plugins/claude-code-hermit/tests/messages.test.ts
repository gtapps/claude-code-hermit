// Unit tests for scripts/lib/messages.ts — the operator-facing message catalog.
// Covers locale resolution, per-domain table completeness (every table carries
// both locales with the same method set, each returning a non-empty string), and
// the friendlyDate renderer (en-GB verbatim / pt-PT static month table / invalid
// fallback). Byte-identity of the `en` bodies vs the pre-refactor literals is a
// separate regression guard (tests/localization-regression.test.ts).

import { describe, test, expect } from 'bun:test';
import {
  resolveLocale, dates,
  PAUSE, STATUS, SPEND, BUDGET, DENY, MINT, WATCHDOG,
  type Localized,
} from '../scripts/lib/messages';

describe('resolveLocale', () => {
  const toPt = [
    'pt', 'pt-PT', 'pt_PT', 'pt-BR', 'pt_BR', 'PT', 'Pt-Pt', 'PT-BR',
    'portuguese', 'Portuguese', 'PORTUGUESE', 'português', 'Português', 'portugues',
    '  pt  ', ' Português ',
  ];
  for (const v of toPt) {
    test(`"${v}" → pt-PT`, () => expect(resolveLocale(v)).toBe('pt-PT'));
  }

  const toEn: unknown[] = [null, undefined, '', 'en', 'English', 'english', 'español', 'es', 'french', 'de', 42, {}, ['pt']];
  for (const v of toEn) {
    test(`${JSON.stringify(v)} → en`, () => expect(resolveLocale(v)).toBe('en'));
  }
});

describe('catalog completeness', () => {
  // Every table maps both locales to an object whose methods all return a
  // non-empty string. A generic arg vector satisfies every signature: the first
  // slot doubles as a string label, the numeric slots feed .toFixed()/ratios.
  const tables: Record<string, Localized<any>> = { PAUSE, STATUS, SPEND, BUDGET, DENY, MINT, WATCHDOG };
  const ARGS = ['daily', 1.5, 2.5, 50];

  for (const [name, table] of Object.entries(tables)) {
    test(`${name} carries both locales with identical method sets`, () => {
      expect(Object.keys(table).sort()).toEqual(['en', 'pt-PT']);
      expect(Object.keys(table.en).sort()).toEqual(Object.keys(table['pt-PT']).sort());
    });

    for (const locale of ['en', 'pt-PT'] as const) {
      test(`${name}.${locale} methods all return non-empty strings`, () => {
        for (const [method, fn] of Object.entries(table[locale])) {
          const out = (fn as (...a: any[]) => unknown)(...ARGS);
          expect(typeof out, `${name}.${locale}.${method}`).toBe('string');
          expect((out as string).length, `${name}.${locale}.${method}`).toBeGreaterThan(0);
        }
      });
    }
  }
});

describe('dates.friendlyDate', () => {
  // Noon-UTC so the local calendar day is the 5th in every real timezone.
  const ISO = '2026-07-05T12:00:00Z';

  test('en reproduces the en-GB long form', () => {
    const expected = new Date(ISO).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    expect(dates.friendlyDate('en', ISO)).toBe(expected);
  });

  test('pt-PT renders from the static month table', () => {
    expect(dates.friendlyDate('pt-PT', ISO)).toBe('5 de julho de 2026');
  });

  test('invalid date falls back per locale', () => {
    expect(dates.friendlyDate('en', 'not-a-date')).toBe('in about a year');
    expect(dates.friendlyDate('pt-PT', 'nonsense')).toBe('daqui a cerca de um ano');
  });
});
