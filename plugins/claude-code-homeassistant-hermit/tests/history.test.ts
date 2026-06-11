// WP7 tier 2: tests for src/history.ts — 1:1 port of tests/test_history.py
// (27 cases).
//
// pytest fixture mapping: tmp_path -> mkdtempSync; MagicMock client ->
// inline { getHistory: async () => ... } stub (HistoryClient interface).

import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateHistory,
  detectTimePatterns,
  fetchHistorySnapshot,
  selectHistoryEntities,
  type HistoryClient,
} from '../src/history';

const tmpDirs: string[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ha-history-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const W_START = new Date(Date.UTC(2026, 4, 1, 0, 0, 0));
const W_END = new Date(Date.UTC(2026, 4, 8, 0, 0, 0));

function normalized(entities: Record<string, any>): Record<string, any> {
  return { entity_index: entities };
}

function entity(state = 'on', domainAttrs: Record<string, any> | null = null): Record<string, any> {
  return { state, attributes: domainAttrs || {}, last_changed: '2026-05-06T12:00:00+00:00' };
}

function event(state: string, lastChanged: string): Record<string, any> {
  return { state, last_changed: lastChanged };
}

function makeMockClient(historyData: Record<string, any>): HistoryClient {
  return { getHistory: async () => historyData };
}

// ---------------------------------------------------------------------------
// selectHistoryEntities
// ---------------------------------------------------------------------------

test('select_history_entities applies default scope', () => {
  const norm = normalized({
    'light.kitchen': entity(),
    'switch.fan': entity(),
    'cover.blind': entity(),
    'climate.hvac': entity(),
    'automation.morning': entity(),
    'binary_sensor.motion_hall': entity('on', { device_class: 'motion' }),
    'binary_sensor.temperature': entity('on', { device_class: 'temperature' }),
    'sensor.power': entity(),
  });
  const result = selectHistoryEntities(norm);
  expect(result).toContain('light.kitchen');
  expect(result).toContain('switch.fan');
  expect(result).toContain('cover.blind');
  expect(result).toContain('climate.hvac');
  expect(result).toContain('automation.morning');
  expect(result).toContain('binary_sensor.motion_hall');
  // temperature binary_sensor excluded (wrong device_class)
  expect(result).not.toContain('binary_sensor.temperature');
  // sensor excluded (not in scope)
  expect(result).not.toContain('sensor.power');
});

test('select_history_entities override bypasses scope', () => {
  const norm = normalized({
    'light.kitchen': entity(),
    'sensor.power': entity(),
  });
  const override = ['sensor.power', 'sensor.energy'];
  const result = selectHistoryEntities(norm, { override });
  expect(result).toEqual([...override].sort());
  expect(result).not.toContain('light.kitchen');
});

test('select_history_entities empty entity_index returns empty list', () => {
  // Fresh-install edge case: snapshot exists but the entity_index is empty.
  // Returning [] here lets the caller surface the empty-fetch error from
  // HomeAssistantClient.getHistory instead of crashing on a missing key.
  expect(selectHistoryEntities(normalized({}))).toEqual([]);
  expect(selectHistoryEntities({})).toEqual([]);
});

// ---------------------------------------------------------------------------
// aggregateHistory
// ---------------------------------------------------------------------------

test('aggregate_history counts events', () => {
  const history = {
    'light.kitchen': [
      event('off', '2026-05-01T06:00:00+00:00'),
      event('on', '2026-05-01T18:00:00+00:00'),
    ],
  };
  const result = aggregateHistory(history, ['light.kitchen'], {
    windowStart: W_START,
    windowEnd: W_END,
  });
  expect(result['light.kitchen']!.event_count).toBe(2);
  expect(result['light.kitchen']!.returned).toBe(true);
});

test('aggregate_history synthesizes zero-count row for requested but missing entity', () => {
  const history = { 'light.kitchen': [event('on', '2026-05-01T06:00:00+00:00')] };
  const result = aggregateHistory(history, ['light.kitchen', 'switch.fan'], {
    windowStart: W_START,
    windowEnd: W_END,
  });
  const fan = result['switch.fan']!;
  expect(fan.event_count).toBe(0);
  expect(fan.returned).toBe(false);
  expect(fan.hour_histogram).toEqual(new Array(24).fill(0));
  expect(fan.last_event_iso).toBeNull();
  expect(fan.state_durations).toEqual({});
});

test('aggregate_history hour histogram uses UTC', () => {
  // Event at 14:00 UTC
  const history = { 'light.x': [event('on', '2026-05-03T14:30:00+00:00')] };
  const result = aggregateHistory(history, ['light.x'], {
    windowStart: W_START,
    windowEnd: W_END,
  });
  const histogram: number[] = result['light.x']!.hour_histogram;
  expect(histogram[14]).toBe(1);
  expect(histogram.reduce((a, b) => a + b, 0)).toBe(1);
});

test('aggregate_history does not emit automation execution fields', () => {
  const history = {
    'automation.morning': [
      event('off', '2026-05-01T06:00:00+00:00'),
      event('on', '2026-05-01T06:00:01+00:00'),
    ],
  };
  const result = aggregateHistory(history, ['automation.morning'], {
    windowStart: W_START,
    windowEnd: W_END,
  });
  const agg = result['automation.morning']!;
  expect(Object.keys(agg)).not.toContain('last_triggered_iso');
  expect(Object.keys(agg)).not.toContain('never_fired_in_window');
});

test('aggregate_history does not emit first_event_iso', () => {
  const history = { 'light.x': [event('on', '2026-05-01T06:00:00+00:00')] };
  const result = aggregateHistory(history, ['light.x'], {
    windowStart: W_START,
    windowEnd: W_END,
  });
  expect(Object.keys(result['light.x']!)).not.toContain('first_event_iso');
});

test('state_durations sums intervals between transitions', () => {
  // light is off from 06:00, on from 07:00, off from 09:00 → on=2h, off spans rest
  const history = {
    'light.x': [
      event('off', '2026-05-01T06:00:00+00:00'),
      event('on', '2026-05-01T07:00:00+00:00'),
      event('off', '2026-05-01T09:00:00+00:00'),
    ],
  };
  const result = aggregateHistory(history, ['light.x'], {
    windowStart: W_START,
    windowEnd: W_END,
  });
  const durations = result['light.x']!.state_durations;
  expect(durations.on).toBe(2 * 3600);
  // off duration: (07:00 - 06:00) + (window_end - 09:00) = 1h + (7d - 3h exactly)
  const expectedOff =
    1 * 3600 + Math.trunc((W_END.getTime() - Date.UTC(2026, 4, 1, 9, 0)) / 1000);
  expect(durations.off).toBe(expectedOff);
});

test('state_durations clips to window bounds', () => {
  // Event before window_start — span should be clipped at window_start
  const history = {
    'light.x': [
      event('on', '2026-04-30T23:00:00+00:00'), // before window
      event('off', '2026-05-01T01:00:00+00:00'), // within window
    ],
  };
  const result = aggregateHistory(history, ['light.x'], {
    windowStart: W_START,
    windowEnd: W_END,
  });
  const durations = result['light.x']!.state_durations;
  // "on" span: clipped_start = window_start (2026-05-01T00:00), end = 01:00 → 1h
  expect(durations.on ?? 0).toBe(3600);
});

// ---------------------------------------------------------------------------
// detectTimePatterns
// ---------------------------------------------------------------------------

test('detect_time_patterns finds dominant hour', () => {
  const histogram = new Array(24).fill(0);
  histogram[9] = 6; // 60% of events at hour 9
  histogram[14] = 2;
  histogram[20] = 2;
  const aggregates = {
    'light.kitchen': {
      returned: true,
      event_count: 10,
      hour_histogram: histogram,
    },
  };
  const patterns = detectTimePatterns(aggregates);
  expect(patterns.length).toBe(1);
  expect(patterns[0]!.entity_id).toBe('light.kitchen');
  expect(patterns[0]!.peak_hour).toBe(9);
  expect(patterns[0]!.peak_count).toBe(6);
});

test('detect_time_patterns ignores low-volume entities', () => {
  const histogram = new Array(24).fill(0);
  histogram[9] = 4; // total = 4, below threshold of 5
  const aggregates = {
    'light.x': { returned: true, event_count: 4, hour_histogram: histogram },
  };
  expect(detectTimePatterns(aggregates)).toEqual([]);
});

test('detect_time_patterns skips synthesized zero-count rows', () => {
  const aggregates = {
    'switch.fan': { returned: false, event_count: 0, hour_histogram: new Array(24).fill(0) },
  };
  expect(detectTimePatterns(aggregates)).toEqual([]);
});

test('detect_time_patterns ignores no dominant hour', () => {
  // Evenly spread — no hour exceeds 50%
  const histogram = new Array(24).fill(1);
  const aggregates = {
    'light.x': { returned: true, event_count: 24, hour_histogram: histogram },
  };
  expect(detectTimePatterns(aggregates)).toEqual([]);
});

// ---------------------------------------------------------------------------
// fetchHistorySnapshot
// ---------------------------------------------------------------------------

test('fetch_history_snapshot artifact has no raw_events field', async () => {
  const tmp = tmpPath();
  const norm = normalized({ 'light.kitchen': entity() });
  const mockClient = makeMockClient({
    'light.kitchen': [event('on', '2026-05-03T10:00:00+00:00')],
  });

  const payload = await fetchHistorySnapshot(tmp, mockClient, norm, { windowDays: 1 });

  expect(Object.keys(payload)).not.toContain('raw_events');
  expect(Object.keys(payload)).toContain('entity_aggregates');
  expect(Object.keys(payload)).toContain('time_patterns');
  expect(Object.keys(payload)).toContain('event_total');
});

test('fetch_history_snapshot writes per-window artifact with correct filename', async () => {
  const tmp = tmpPath();
  const norm = normalized({ 'light.x': entity() });
  const mockClient = makeMockClient({});

  await fetchHistorySnapshot(tmp, mockClient, norm, { windowDays: 7 });

  const latest = join(tmp, '.claude-code-hermit', 'raw', 'snapshot-ha-history-7d-latest.json');
  expect(existsSync(latest)).toBe(true);
  const data = JSON.parse(readFileSync(latest, 'utf8'));
  expect(data.event_total).toBe(0); // no events returned
});

test('fetch_history does not clobber other window artifact', async () => {
  const tmp = tmpPath();
  const norm = normalized({ 'light.x': entity() });
  const mockClient = makeMockClient({});

  await fetchHistorySnapshot(tmp, mockClient, norm, { windowDays: 7 });
  await fetchHistorySnapshot(tmp, mockClient, norm, { windowDays: 1 });

  const raw = join(tmp, '.claude-code-hermit', 'raw');
  expect(existsSync(join(raw, 'snapshot-ha-history-7d-latest.json'))).toBe(true);
  expect(existsSync(join(raw, 'snapshot-ha-history-1d-latest.json'))).toBe(true);
});

// ---------------------------------------------------------------------------
// selectHistoryEntities — glob expansion (added for ha-presence-report)
// ---------------------------------------------------------------------------

test('select_history_entities glob expands against entity_index', () => {
  const norm = normalized({
    'person.alice': entity('home'),
    'person.bob': entity('away'),
    'device_tracker.alice_phone': entity('home'),
    'light.living_room': entity('on'),
  });
  const result = selectHistoryEntities(norm, { override: ['person.*'] });
  expect(result).toEqual(['person.alice', 'person.bob']);
  expect(result).not.toContain('light.living_room');
  expect(result).not.toContain('device_tracker.alice_phone');
});

test('select_history_entities multiple globs combined', () => {
  const norm = normalized({
    'person.alice': entity('home'),
    'device_tracker.alice_phone': entity('home'),
    'light.living_room': entity('on'),
  });
  const result = selectHistoryEntities(norm, { override: ['person.*', 'device_tracker.*'] });
  expect(result).toContain('person.alice');
  expect(result).toContain('device_tracker.alice_phone');
  expect(result).not.toContain('light.living_room');
});

test('select_history_entities mixed exact and glob dedupes', () => {
  const norm = normalized({
    'person.alice': entity('home'),
    'person.bob': entity('away'),
  });
  // person.alice matches both the exact token and person.*
  const result = selectHistoryEntities(norm, { override: ['person.alice', 'person.*'] });
  expect(result.filter((e) => e === 'person.alice').length).toBe(1);
  expect(result).toContain('person.bob');
});

test('select_history_entities nonmatching glob yields empty', () => {
  const norm = normalized({ 'light.kitchen': entity() });
  const result = selectHistoryEntities(norm, { override: ['sensor.*'] });
  expect(result).toEqual([]);
});

test('select_history_entities exact id not in index passes through', () => {
  // Exact IDs (no *) are still returned verbatim even if absent from entity_index
  const norm = normalized({ 'light.kitchen': entity() });
  const result = selectHistoryEntities(norm, { override: ['sensor.unknown'] });
  expect(result).toEqual(['sensor.unknown']);
});

// ---------------------------------------------------------------------------
// aggregateHistory — includeTransitions (added for ha-presence-report)
// ---------------------------------------------------------------------------

test('aggregate_history transitions omitted by default', () => {
  const history = {
    'person.alice': [
      event('home', '2026-05-01T06:00:00+00:00'),
      event('away', '2026-05-01T18:00:00+00:00'),
    ],
  };
  const result = aggregateHistory(history, ['person.alice'], {
    windowStart: W_START,
    windowEnd: W_END,
  });
  expect(Object.keys(result['person.alice']!)).not.toContain('transitions');
});

test('aggregate_history transitions included when flag set', () => {
  const history = {
    'person.alice': [
      event('home', '2026-05-01T06:00:00+00:00'),
      event('away', '2026-05-01T18:00:00+00:00'),
      event('home', '2026-05-02T08:00:00+00:00'),
    ],
  };
  const result = aggregateHistory(history, ['person.alice'], {
    windowStart: W_START,
    windowEnd: W_END,
    includeTransitions: true,
  });
  const transitions: Array<Record<string, string>> = result['person.alice']!.transitions;
  expect(transitions.map((t) => t.state)).toEqual(['home', 'away', 'home']);
  // All entries must have a "ts" key
  expect(transitions.every((t) => 'ts' in t)).toBe(true);
});

test('aggregate_history transitions consecutive duplicates collapsed', () => {
  // HA can emit same-state events for attribute-only updates
  const history = {
    'person.alice': [
      event('home', '2026-05-01T06:00:00+00:00'),
      event('home', '2026-05-01T06:01:00+00:00'), // duplicate — collapsed
      event('away', '2026-05-01T18:00:00+00:00'),
      event('away', '2026-05-01T18:01:00+00:00'), // duplicate — collapsed
      event('home', '2026-05-02T08:00:00+00:00'),
    ],
  };
  const result = aggregateHistory(history, ['person.alice'], {
    windowStart: W_START,
    windowEnd: W_END,
    includeTransitions: true,
  });
  const states = result['person.alice']!.transitions.map((t: Record<string, string>) => t.state);
  expect(states).toEqual(['home', 'away', 'home']);
});

test('aggregate_history missing entity gets empty transitions list', () => {
  const result = aggregateHistory({}, ['person.alice'], {
    windowStart: W_START,
    windowEnd: W_END,
    includeTransitions: true,
  });
  expect(result['person.alice']!.transitions).toEqual([]);
  expect(result['person.alice']!.returned).toBe(false);
});

test('aggregate_history include_transitions false regression', () => {
  // Existing callers (ha-analyze-patterns, ha-morning-brief) must be byte-for-byte unaffected.
  const history = {
    'light.kitchen': [
      event('off', '2026-05-01T06:00:00+00:00'),
      event('on', '2026-05-01T18:00:00+00:00'),
    ],
  };
  const result = aggregateHistory(history, ['light.kitchen'], {
    windowStart: W_START,
    windowEnd: W_END,
    includeTransitions: false,
  });
  expect(Object.keys(result['light.kitchen']!)).not.toContain('transitions');
  expect(result['light.kitchen']!.event_count).toBe(2);
});
