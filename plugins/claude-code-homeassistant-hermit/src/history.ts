// WP7 tier 2 port of src/ha_agent_lab/history.py — History API aggregation,
// pattern detection for ha-analyze-patterns and ha-morning-brief.
//
// Representation note: Python emitted timestamps via `datetime.isoformat()`,
// preserving the source offset (e.g. "+02:00") in `transitions[].ts`. JS
// Dates are instants, so all emitted timestamps here are UTC via isoUtc()
// ("+00:00" form). Same instant, normalized offset; no consumer pins the
// offset (artifacts are read by skills/LLM).

import type { HomeAssistantClient } from './ha-api';
import { writeJsonArtifact } from './artifacts';
import { isoUtc, parseIso } from './time-utils';

const DEFAULT_DOMAINS = new Set(['light', 'switch', 'cover', 'climate', 'automation']);
const HISTORY_BINARY_SENSOR_CLASSES = new Set(['motion', 'door', 'window', 'opening', 'occupancy']);

// Informational description of the default scope for documentation and tests.
export const DEFAULT_ENTITY_SCOPE = [
  'light.*',
  'switch.*',
  'cover.*',
  'climate.*',
  'automation.*',
  'binary_sensor.* (motion/door/window/opening/occupancy)',
] as const;

// fnmatch.fnmatchcase subset: *, ?, [seq], [!seq]; everything else literal.
function fnmatchCase(name: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      re += '.*';
    } else if (ch === '?') {
      re += '.';
    } else if (ch === '[') {
      let j = i + 1;
      if (pattern[j] === '!') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j++;
      if (j >= pattern.length) {
        re += '\\[';
      } else {
        let stuff = pattern.slice(i + 1, j).replaceAll('\\', '\\\\');
        if (stuff.startsWith('!')) stuff = `^${stuff.slice(1)}`;
        re += `[${stuff}]`;
        i = j;
      }
    } else {
      re += ch.replace(/[.+^${}()|\\/[\]]/, '\\$&');
    }
  }
  return new RegExp(`^(?:${re})$`, 's').test(name);
}

/**
 * Return entity IDs for the history fetch.
 *
 * When override is given, tokens containing '*' are expanded against the
 * entity_index via fnmatch; tokens without '*' are treated as exact IDs.
 * Results are de-duped and sorted. Otherwise the default scope applies:
 * all entities in light/switch/cover/climate/automation domains, plus
 * binary_sensor entities whose device_class is in the event sensor set.
 */
export function selectHistoryEntities(
  normalized: Record<string, any>,
  options: { override?: string[] | null } = {},
): string[] {
  const entityIndex: Record<string, any> = normalized.entity_index ?? {};
  const override = options.override ?? null;
  if (override !== null) {
    const out = new Set<string>();
    for (const token of override) {
      if (token.includes('*')) {
        for (const entityId of Object.keys(entityIndex)) {
          if (fnmatchCase(entityId, token)) out.add(entityId);
        }
      } else {
        out.add(token);
      }
    }
    return [...out].sort();
  }
  const result: string[] = [];
  for (const [entityId, entity] of Object.entries(entityIndex)) {
    const domain = entityId.split('.', 1)[0]!;
    if (DEFAULT_DOMAINS.has(domain)) {
      result.push(entityId);
    } else if (domain === 'binary_sensor') {
      const attrs = entity.attributes || {};
      if (HISTORY_BINARY_SENSOR_CLASSES.has(attrs.device_class)) result.push(entityId);
    }
  }
  return result.sort();
}

/**
 * Aggregate HA history events per entity.
 *
 * Entities in `requested` that are absent from `history` (no events in the
 * window) get synthesized zero-count rows so callers always see a complete
 * picture. `state_durations` clips event spans to [windowStart, windowEnd].
 *
 * When `includeTransitions` is true, each aggregate gains a `transitions`
 * list: ordered `{"ts": <iso>, "state": <str>}` objects for real state
 * changes only (consecutive duplicate states are collapsed).
 */
export function aggregateHistory(
  history: Record<string, Array<Record<string, any>>>,
  requested: string[],
  options: { windowStart: Date; windowEnd: Date; includeTransitions?: boolean },
): Record<string, Record<string, any>> {
  const { windowStart, windowEnd, includeTransitions = false } = options;
  const ws = windowStart.getTime();
  const we = windowEnd.getTime();
  const result: Record<string, Record<string, any>> = {};

  for (const entityId of requested) {
    const events = history[entityId];
    if (events === undefined) {
      const row: Record<string, any> = {
        event_count: 0,
        returned: false,
        hour_histogram: new Array(24).fill(0),
        last_event_iso: null,
        state_durations: {},
      };
      if (includeTransitions) row.transitions = [];
      result[entityId] = row;
      continue;
    }

    const timestamps = events.map((ev) => parseIso(ev.last_changed));

    const histogram: number[] = new Array(24).fill(0);
    let lastEvent: Date | null = null;

    for (const ts of timestamps) {
      if (ts !== null) {
        histogram[ts.getUTCHours()]! += 1;
        if (lastEvent === null || ts.getTime() > lastEvent.getTime()) lastEvent = ts;
      }
    }

    const stateDurations: Record<string, number> = {};
    for (let i = 0; i < events.length; i++) {
      const evTs = timestamps[i];
      if (evTs === null) continue;
      const spanStart = Math.max(evTs.getTime(), ws);
      const nextTs = i + 1 < timestamps.length ? timestamps[i + 1]! : null;
      const spanEnd = Math.min(nextTs !== null ? nextTs.getTime() : we, we);
      if (spanEnd > spanStart) {
        const state: string = events[i]!.state ?? '';
        stateDurations[state] = (stateDurations[state] ?? 0) + (spanEnd - spanStart) / 1000;
      }
    }

    const agg: Record<string, any> = {
      event_count: events.length,
      returned: true,
      hour_histogram: histogram,
      last_event_iso: lastEvent ? isoUtc(lastEvent) : null,
      // Python int() truncates toward zero (durations are non-negative).
      state_durations: Object.fromEntries(
        Object.entries(stateDurations).map(([state, secs]) => [state, Math.trunc(secs)]),
      ),
    };

    if (includeTransitions) {
      const transitions: Array<{ ts: string; state: string }> = [];
      let prevState: string | null = null;
      for (let i = 0; i < events.length; i++) {
        const state: string = events[i]!.state ?? '';
        const ts = timestamps[i] ?? null;
        // An event with an unparseable timestamp is skipped without advancing
        // prevState (a state change hidden behind a bad ts can be lost). HA
        // timestamps are reliably parseable in practice, so we accept this.
        if (state !== prevState && ts !== null) {
          transitions.push({ ts: isoUtc(ts), state });
          prevState = state;
        }
      }
      agg.transitions = transitions;
    }

    result[entityId] = agg;
  }

  return result;
}

/**
 * Return entities with a dominant single-hour activity peak.
 *
 * A pattern requires total events >= 5 and the peak hour accounting for
 * > 50% of total events. Synthesized zero-count rows are skipped.
 */
export function detectTimePatterns(
  aggregates: Record<string, Record<string, any>>,
): Array<Record<string, any>> {
  const patterns: Array<Record<string, any>> = [];
  for (const [entityId, agg] of Object.entries(aggregates)) {
    if (!agg.returned) continue;
    const total: number = agg.event_count ?? 0;
    if (total < 5) continue;
    const histogram: number[] = agg.hour_histogram ?? new Array(24).fill(0);
    // max(range(24), key=...) — first index with the maximum count.
    let peakHour = 0;
    for (let h = 1; h < 24; h++) {
      if (histogram[h]! > histogram[peakHour]!) peakHour = h;
    }
    const peakCount = histogram[peakHour]!;
    if (peakCount / total > 0.5) {
      patterns.push({
        entity_id: entityId,
        peak_hour: peakHour,
        peak_count: peakCount,
        total,
        description: `${entityId} — ${peakCount}/${total} events at ${String(peakHour).padStart(2, '0')}:00 UTC`,
      });
    }
  }
  return patterns.sort((a, b) =>
    a.peak_count !== b.peak_count
      ? b.peak_count - a.peak_count
      : a.entity_id < b.entity_id
        ? -1
        : a.entity_id > b.entity_id
          ? 1
          : 0,
  );
}

/** The slice of HomeAssistantClient that fetchHistorySnapshot needs (tests inject a stub). */
export interface HistoryClient {
  getHistory(
    entityIds: string[],
    startTime: Date,
    endTime: Date,
  ): Promise<Record<string, Array<Record<string, any>>>>;
}

/**
 * Fetch, aggregate, and write a history snapshot artifact.
 *
 * Writes both a dated file and a fixed-name latest alias under
 * `.claude-code-hermit/raw/snapshot-ha-history-{windowDays}d-{date}.json`.
 */
export async function fetchHistorySnapshot(
  root: string,
  client: HistoryClient | HomeAssistantClient,
  normalized: Record<string, any>,
  options: {
    windowDays?: number;
    entityOverride?: string[] | null;
    includeTransitions?: boolean;
  } = {},
): Promise<Record<string, any>> {
  const { windowDays = 7, entityOverride = null, includeTransitions = false } = options;
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

  const entityIds = selectHistoryEntities(normalized, { override: entityOverride });
  const history = await client.getHistory(entityIds, windowStart, now);
  const aggregates = aggregateHistory(history, entityIds, {
    windowStart,
    windowEnd: now,
    includeTransitions,
  });
  const timePatterns = detectTimePatterns(aggregates);

  const returnedEntities = Object.entries(aggregates)
    .filter(([, agg]) => agg.returned)
    .map(([eid]) => eid)
    .sort();
  const missingEntities = Object.entries(aggregates)
    .filter(([, agg]) => !agg.returned)
    .map(([eid]) => eid)
    .sort();

  const payload: Record<string, any> = {
    window_start: isoUtc(windowStart),
    window_end: isoUtc(now),
    fetched_at: isoUtc(now),
    requested_entities: entityIds,
    returned_entities: returnedEntities,
    missing_entities: missingEntities,
    event_total: Object.values(aggregates).reduce((sum, agg) => sum + agg.event_count, 0),
    entity_aggregates: aggregates,
    time_patterns: timePatterns,
  };

  writeJsonArtifact(
    root,
    '.claude-code-hermit/raw',
    `snapshot-ha-history-${windowDays}d`,
    payload,
    `snapshot-ha-history-${windowDays}d-latest.json`,
  );

  return payload;
}
