import { test, expect } from 'bun:test';
import { validate } from '../scripts/validate-config';
import { TABLE, specAt, type Spec } from '../scripts/lib/config-read';

test('standalone clear settings are validated and the retired flag is ignored', () => {
  const valid = { context_hygiene: { clear: { enabled: true, quiet: '1h', max_age: '24h', min_tokens: 20000 } }, tasks: { queue_nudge_minutes: 60 } };
  expect(validate(valid).errors.filter(e => /context_hygiene|tasks/.test(e))).toEqual([]);
  expect(validate({ post_close_clear: 'retired' }).errors.some(e => e.includes('post_close_clear'))).toBe(false);
  for (const [key, value] of [['enabled', 'yes'], ['quiet', 1], ['max_age', 'later'], ['min_tokens', -1]]) {
    expect(validate({ context_hygiene: { clear: { [key]: value } } }).errors.some(e => e.includes(`context_hygiene.clear.${key}`))).toBe(true);
  }
  expect(validate({ tasks: { queue_nudge_minutes: -1 } }).errors.some(e => e.includes('queue_nudge_minutes'))).toBe(true);
});

function configAt(dotted: string, value: unknown): Record<string, unknown> {
  return dotted.split('.').reverse().reduce<Record<string, unknown> | unknown>(
    (nested, key) => ({ [key]: nested }), value,
  ) as Record<string, unknown>;
}

function constrainedLeaves(rows: Record<string, Spec>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(rows).flatMap(([key, spec]): Array<[string, unknown]> => {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (spec.kind === 'shape') return constrainedLeaves(spec.sub, dotted);
    if (spec.kind === 'string') {
      if (spec.enum) return [[dotted, 'zz']];
      if (spec.pattern) return [[dotted, spec.pattern === 'duration' ? 123 : '8am']];
    }
    if (spec.kind === 'number' && spec.range) return [[dotted, spec.range[0] - 1]];
    return [];
  });
}

test('heartbeat.every declares its duration constraint', () => {
  const spec = specAt('heartbeat.every');
  expect(spec?.kind === 'string' && spec.pattern).toBe('duration');
});

for (const [dotted, invalid] of constrainedLeaves(TABLE)) {
  test(`table constraint rejects invalid ${dotted}`, () => {
    expect(validate(configAt(dotted, invalid)).errors.some(error => error.includes(dotted))).toBe(true);
  });
}

for (const [dotted, invalid] of [
  ['heartbeat.every', 123],
  ['heartbeat.stale_threshold', 'bogus'],
  ['heartbeat.waiting_timeout', -1],
  ['heartbeat.clean_recheck_cooldown', {}],
  ['routine_wake_lint.max_windows', 'x'],
  ['storage_drift.ignore', 'notarray'],
] as const) {
  test(`invalid ${dotted} names the key`, () => {
    expect(validate(configAt(dotted, invalid)).errors.some(error => error.includes(dotted))).toBe(true);
  });
}
