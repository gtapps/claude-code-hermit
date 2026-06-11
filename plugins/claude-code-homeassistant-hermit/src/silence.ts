// WP7 tier 2 port of src/ha_agent_lab/silence.py — silence-summary analysis:
// dead automations, silent sensors, long-unavailable entities.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { daysSince, isoUtc, parseIso } from './time-utils';

const EVENT_SENSOR_DEVICE_CLASSES = new Set(['motion', 'door', 'window', 'opening', 'occupancy']);
// `climate` is retained here for visibility into HVAC entities that haven't received
// a state change in weeks (broken schedule, dead controller). Expect a higher false-positive
// rate than the other domains — climate state is often legitimately stable. The bucket is
// informational only (Markdown artifact); the canonical HVAC signal is `state_durations`
// from `snapshot-ha-history-*-latest.json`.
const INACTIVE_CANDIDATE_DOMAINS = ['light', 'switch', 'cover', 'climate'] as const;

/**
 * Return degraded entity-domain prefixes from the integration-health state artifact.
 *
 * Returns an empty set if the artifact is missing or malformed — suppression is
 * opportunistic; silence.ts self-heals after the next ha integration-health run.
 */
function loadDegradedEntityDomains(root: string): Set<string> {
  const path = join(root, '.claude-code-hermit', 'state', 'integration-health-degraded-domains.json');
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const entries: unknown[] = data?.degraded_entity_domains ?? [];
    return new Set(
      entries
        .filter((entry: any) => typeof entry?.domain === 'string')
        .map((entry: any) => entry.domain as string),
    );
  } catch {
    return new Set();
  }
}

/**
 * Return a dead-automation payload for enabled automations past the threshold, else null.
 *
 * Disabled automations (state == 'off') are dropped silently. Newly-enabled automations
 * that have never fired are also dropped: a never_fired:true classification only counts
 * once `last_changed` (creation or enable time) is at least deadThresholdDays old.
 * Without that gate, a freshly-created automation would be flagged immediately.
 */
function classifyAutomation(
  entity: Record<string, any>,
  now: Date,
  deadThresholdDays: number,
): Record<string, any> | null {
  if (entity.state !== 'on') return null;
  const attrs = entity.attributes || {};
  const lastTriggeredRaw = attrs.last_triggered ?? null;
  const lastTriggered = parseIso(lastTriggeredRaw);
  const days = daysSince(now, lastTriggered);
  const neverFired = lastTriggered === null;

  if (neverFired) {
    const lastChangedDays = daysSince(now, parseIso(entity.last_changed));
    if (lastChangedDays === null || lastChangedDays < deadThresholdDays) return null;
  } else if (days === null || days < deadThresholdDays) {
    return null;
  }

  return {
    entity_id: entity.entity_id,
    last_triggered: lastTriggeredRaw,
    days_silent: days,
    never_fired: neverFired,
  };
}

/** Return a silent-event-sensor payload if the sensor hasn't fired in stuckDays, else null. */
function classifyEventSensor(
  entity: Record<string, any>,
  now: Date,
  stuckDays: number,
): Record<string, any> | null {
  const attrs = entity.attributes || {};
  const deviceClass = attrs.device_class;
  if (!EVENT_SENSOR_DEVICE_CLASSES.has(deviceClass)) return null;
  const lastChanged = parseIso(entity.last_changed);
  const days = daysSince(now, lastChanged);
  if (days === null || days < stuckDays) return null;
  return {
    entity_id: entity.entity_id,
    device_class: deviceClass,
    last_changed: entity.last_changed ?? null,
    days_silent: days,
  };
}

// Python: sorted by (-(days_silent ?? days ?? 0), entity_id).
function sortRows(items: Array<Record<string, any>>): Array<Record<string, any>> {
  return [...items].sort((a, b) => {
    const da: number = a.days_silent ?? a.days ?? 0;
    const db: number = b.days_silent ?? b.days ?? 0;
    if (da !== db) return db - da;
    const ea: string = a.entity_id ?? '';
    const eb: string = b.entity_id ?? '';
    return ea < eb ? -1 : ea > eb ? 1 : 0;
  });
}

/**
 * Compute silence metrics from the normalized snapshot.
 *
 * Reads the integration-health degraded-domains artifact to suppress long_unavailable
 * entries that ha-integration-health already covers.
 */
export function computeSilenceSummary(
  normalized: Record<string, any>,
  root: string,
  options: { now?: Date | null; stuckDays?: number; deadAutomationDays?: number } = {},
): Record<string, any> {
  const { stuckDays = 7, deadAutomationDays = 30 } = options;
  const now = options.now ?? new Date();

  const entityIndex: Record<string, any> = normalized.entity_index ?? {};
  const unavailableList: string[] = normalized.unavailable_entities ?? [];

  const degradedDomains = loadDegradedEntityDomains(root);

  const deadAutomations: Array<Record<string, any>> = [];
  const silentEventSensors: Array<Record<string, any>> = [];
  const inactiveByDomain: Record<string, Array<Record<string, any>>> = Object.fromEntries(
    INACTIVE_CANDIDATE_DOMAINS.map((d) => [d, []]),
  );
  const longUnavailable: Array<Record<string, any>> = [];

  for (const [entityId, entity] of Object.entries(entityIndex)) {
    const domain = entityId.split('.', 1)[0]!;
    const entityWithId = { ...entity, entity_id: entityId };

    if (domain === 'automation') {
      const result = classifyAutomation(entityWithId, now, deadAutomationDays);
      if (result) deadAutomations.push(result);
      continue;
    }

    if (domain === 'binary_sensor') {
      const payload = classifyEventSensor(entityWithId, now, stuckDays);
      if (payload) silentEventSensors.push(payload);
      continue;
    }

    if (domain in inactiveByDomain) {
      const lastChanged = parseIso(entity.last_changed);
      const days = daysSince(now, lastChanged);
      if (days !== null && days >= stuckDays) {
        inactiveByDomain[domain]!.push({
          entity_id: entityId,
          last_changed: entity.last_changed ?? null,
          days_silent: days,
        });
      }
    }
  }

  const suppressedDomains = new Set<string>();
  for (const entityId of unavailableList) {
    const domain = entityId.split('.', 1)[0]!;
    const entity = entityIndex[entityId] ?? {};
    const since = entity.last_changed ?? null;
    const lastChanged = parseIso(since);
    const days = daysSince(now, lastChanged);
    if (days === null || days < stuckDays) continue;
    if (degradedDomains.has(domain)) {
      suppressedDomains.add(domain);
      continue;
    }
    longUnavailable.push({ entity_id: entityId, domain, since, days });
  }

  return {
    computed_at: isoUtc(now),
    thresholds: { stuck_days: stuckDays, dead_automation_days: deadAutomationDays },
    dead_automations: sortRows(deadAutomations),
    silent_event_sensors: sortRows(silentEventSensors),
    inactive_candidates_by_domain: Object.fromEntries(
      Object.entries(inactiveByDomain).map(([d, v]) => [d, sortRows(v)]),
    ),
    long_unavailable: sortRows(longUnavailable),
    suppressed_entity_domains: [...suppressedDomains].sort(),
  };
}
