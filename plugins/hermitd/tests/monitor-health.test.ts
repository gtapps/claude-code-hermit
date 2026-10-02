import { describe, expect, test } from 'bun:test';
import { monitorFreshness } from '../scripts/lib/monitor-health';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const isoAgo = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe('monitorFreshness', () => {
  test.each([
    ['trusted fresh tick', isoAgo(300), isoAgo(10), 60, 120, true, 'fresh'],
    ['trusted stale tick', isoAgo(300), isoAgo(90), 60, 120, false, 'stale'],
    ['missing tick during grace', isoAgo(30), null, 60, 120, true, 'warming-up'],
    ['missing tick after grace', isoAgo(120), null, 60, 120, false, 'liveness-absent'],
    ['old tick during grace', isoAgo(30), isoAgo(60), 60, 120, true, 'warming-up'],
    ['old tick after grace', isoAgo(120), isoAgo(180), 60, 120, false, 'liveness-predates-start'],
    ['unregistered without tick', null, null, 60, 120, true, 'unregistered'],
    ['unregistered fresh tick', null, isoAgo(10), 60, 120, true, 'fresh'],
  ] as const)('%s', (_name, startedAt, lastPeekAt, threshold, grace, fresh, reason) => {
    expect(monitorFreshness(startedAt, lastPeekAt, threshold, grace, NOW)).toEqual({ fresh, reason });
  });
});
