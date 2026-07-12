import { expect, test } from 'bun:test';

import { classifyUpdateEntity, collectPendingUpdates, formatUpdatesStdout } from '../src/update-check';

function state(entityId: string, attrs: Record<string, any>, pending = true): Record<string, any> {
  return { entity_id: entityId, state: pending ? 'on' : 'off', attributes: attrs };
}

test('classifyUpdateEntity recognizes well-known core/os/supervisor ids', () => {
  expect(classifyUpdateEntity('update.home_assistant_core_update')).toBe('core');
  expect(classifyUpdateEntity('update.home_assistant_operating_system_update')).toBe('os');
  expect(classifyUpdateEntity('update.home_assistant_supervisor_update')).toBe('supervisor');
});

test('classifyUpdateEntity uses platform for add-ons', () => {
  expect(classifyUpdateEntity('update.mosquitto_broker', 'hassio')).toBe('addon');
});

test('classifyUpdateEntity defaults unknown platform to hacs bucket', () => {
  expect(classifyUpdateEntity('update.frigate', 'hacs')).toBe('hacs');
  expect(classifyUpdateEntity('update.some_integration', null)).toBe('hacs');
});

test('collectPendingUpdates filters to update.* entities in pending state', () => {
  const states = [
    state('update.home_assistant_core_update', {
      installed_version: '2026.6.3',
      latest_version: '2026.7.1',
      release_summary: 'Bug fixes',
      release_url: 'https://example.com/core',
    }),
    state('light.kitchen', { brightness: 100 }),
    state('update.mosquitto_broker', { installed_version: '6.4', latest_version: '6.4' }, false),
  ];
  const updates = collectPendingUpdates(states);
  expect(updates.length).toBe(1);
  expect(updates[0].entity_id).toBe('update.home_assistant_core_update');
  expect(updates[0].tier).toBe('core');
  expect(updates[0].latest_version).toBe('2026.7.1');
});

test('collectPendingUpdates honors HA-native skipped_version', () => {
  const states = [
    state('update.frigate', {
      installed_version: '1.0',
      latest_version: '1.1',
      skipped_version: '1.1',
    }),
  ];
  expect(collectPendingUpdates(states)).toEqual([]);
});

test('collectPendingUpdates does not skip when skipped_version is stale', () => {
  const states = [
    state('update.frigate', {
      installed_version: '1.0',
      latest_version: '1.2',
      skipped_version: '1.1',
    }),
  ];
  const updates = collectPendingUpdates(states);
  expect(updates.length).toBe(1);
});

test('collectPendingUpdates passes registry platform through for tiering', () => {
  const states = [state('update.mosquitto_broker', { installed_version: '6.4', latest_version: '6.5' })];
  const updates = collectPendingUpdates(states, { 'update.mosquitto_broker': 'hassio' });
  expect(updates[0].tier).toBe('addon');
});

test('collectPendingUpdates sorts by entity_id', () => {
  const states = [
    state('update.zzz_thing', { installed_version: '1', latest_version: '2' }),
    state('update.aaa_thing', { installed_version: '1', latest_version: '2' }),
  ];
  const updates = collectPendingUpdates(states);
  expect(updates.map((u) => u.entity_id)).toEqual(['update.aaa_thing', 'update.zzz_thing']);
});

test('formatUpdatesStdout empty case', () => {
  const out = formatUpdatesStdout([], '2026-07-12');
  expect(out).toBe('ha-update-check findings — 2026-07-12\nNo actionable findings. (no updates pending)');
});

test('formatUpdatesStdout lists individual tiers and aggregates hacs', () => {
  const updates = collectPendingUpdates([
    state('update.home_assistant_core_update', {
      title: 'Home Assistant Core',
      installed_version: '2026.6.3',
      latest_version: '2026.7.1',
      release_url: 'https://example.com/core',
    }),
    state('update.frigate', { installed_version: '1.0', latest_version: '1.1' }),
    state('update.mushroom', { installed_version: '2.0', latest_version: '2.1' }),
  ]);
  const out = formatUpdatesStdout(updates, '2026-07-12');
  expect(out).toContain('Updates pending: 3');
  expect(out).toContain('- [core] Home Assistant Core: 2026.6.3 → 2026.7.1 — https://example.com/core');
  expect(out).toContain('- [hacs] 2 HACS updates pending');
  expect(out).not.toContain('frigate');
});
