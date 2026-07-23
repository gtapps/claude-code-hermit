// WP7 tier 3: tests that refresh-context paths attach silence_summary to the
// normalized snapshot — 1:1 port of tests/test_cli_silence.py (2 cases).

import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { main } from '../src/cli';
import { captureOutput, cleanupTmp, fakeClient, makeMockConfig } from './helpers';

afterAll(cleanupTmp);

function mockStates(): Array<Record<string, any>> {
  return [
    {
      entity_id: 'light.living_room',
      state: 'off',
      attributes: {},
      last_changed: '2026-05-14T10:00:00+00:00',
      last_updated: '2026-05-14T10:00:00+00:00',
    },
  ];
}

function mockHaPayloads(): unknown[] {
  return [
    { message: 'API running.' },
    { location_name: 'Home' },
    ['homeassistant'],
    [{ domain: 'light', services: { turn_on: {}, turn_off: {} } }],
    mockStates(),
  ];
}

test('refresh-context writes silence_summary', async () => {
  const cfg = makeMockConfig();
  const payloads = mockHaPayloads();
  const client = fakeClient({ get: () => payloads.shift() });

  const { code } = await captureOutput(() =>
    main(['ha', 'refresh-context'], { loadConfig: () => cfg, createClient: async () => client }),
  );

  expect(code).toBe(0);
  const normalizedPath = join(cfg.root, '.claude-code-hermit', 'raw', 'snapshot-ha-normalized-latest.json');
  expect(existsSync(normalizedPath)).toBe(true);
  const normalized = JSON.parse(readFileSync(normalizedPath, 'utf8'));
  expect(Object.keys(normalized)).toContain('silence_summary');
  const ss = normalized.silence_summary;
  expect(Object.keys(ss)).toContain('computed_at');
  expect(Object.keys(ss)).toContain('dead_automations');
  expect(Object.keys(ss)).toContain('silent_event_sensors');
});

test('refresh-context --incremental writes silence_summary on no-diff run', async () => {
  const cfg = makeMockConfig();

  // Seed a baseline snapshot
  const raw = join(cfg.root, '.claude-code-hermit', 'raw');
  mkdirSync(raw, { recursive: true });
  const baseline = {
    entity_index: {
      'light.living_room': { state: 'off', last_changed: '2026-05-14T10:00:00+00:00', attributes: {} },
    },
    service_index: {},
    components: [],
    unavailable_entities: [],
  };
  writeFileSync(join(raw, 'snapshot-ha-normalized-latest.json'), JSON.stringify(baseline), 'utf8');

  // Return the same states — no diff
  const client = fakeClient({ get: () => mockStates() });

  const { code } = await captureOutput(() =>
    main(['ha', 'refresh-context', '--incremental'], {
      loadConfig: () => cfg,
      createClient: async () => client,
    }),
  );

  expect(code).toBe(0);
  const normalized = JSON.parse(readFileSync(join(raw, 'snapshot-ha-normalized-latest.json'), 'utf8'));
  expect(Object.keys(normalized)).toContain('silence_summary');
  expect(Object.keys(normalized.silence_summary)).toContain('computed_at');
});
