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

test('classifyUpdateEntity uses the BACKUP feature bit for add-ons', () => {
  expect(classifyUpdateEntity('update.mosquitto_broker', true)).toBe('addon');
});

test('classifyUpdateEntity defaults entities without the BACKUP bit to hacs', () => {
  expect(classifyUpdateEntity('update.frigate', false)).toBe('hacs');
  expect(classifyUpdateEntity('update.some_integration')).toBe('hacs');
});

test('classifyUpdateEntity id fast-path wins over the BACKUP bit (core/os also advertise BACKUP)', () => {
  expect(classifyUpdateEntity('update.home_assistant_core_update', true)).toBe('core');
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

test('collectPendingUpdates tiers add-ons via the BACKUP feature bit', () => {
  const states = [
    // supported_features 29 = INSTALL|PROGRESS|BACKUP|RELEASE_NOTES (supervisor add-on)
    state('update.mosquitto_broker', { installed_version: '6.4', latest_version: '6.5', supported_features: 29 }),
    // supported_features 23 = INSTALL|SPECIFIC_VERSION|PROGRESS|RELEASE_NOTES (HACS, no BACKUP)
    state('update.frigate', { installed_version: '1.0', latest_version: '1.1', supported_features: 23 }),
  ];
  const updates = collectPendingUpdates(states);
  const byId = Object.fromEntries(updates.map((u) => [u.entity_id, u.tier]));
  expect(byId['update.mosquitto_broker']).toBe('addon');
  expect(byId['update.frigate']).toBe('hacs');
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
