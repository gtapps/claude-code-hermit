// Tests for ha-snapshot-restore (issue #472, skill A).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Whole file runs serial: afterEach drains the shared tmpDirs array and clears
// the global policy cache — per-test global state that cannot isolate under
// `bun test --concurrent`.
import { afterEach, expect, test as bunTest } from 'bun:test';
const test = bunTest.serial;

import { clearPolicyCaches } from '../src/policy';
import { captureStates, restoreStates, type StateSnapshot } from '../src/snapshot-restore';
import { cleanupTmp, fakeClient, makeHaConfig, tmpPath } from './helpers';

afterEach(() => {
  clearPolicyCaches();
  cleanupTmp();
});

function writeSnapshot(root: string, entities: StateSnapshot['entities']): string {
  const path = join(root, 'snap.json');
  writeFileSync(path, JSON.stringify({ name: 'x', generated: 'y', entities }), 'utf8');
  return path;
}

test('capture filters by domain and keeps only restore-relevant attributes', async () => {
  const root = tmpPath();
  const client = fakeClient({
    getStates: () => [
      { entity_id: 'light.living_room', state: 'on', attributes: { brightness: 200, friendly_name: 'LR', supported_features: 44 } },
      { entity_id: 'sensor.temp', state: '21', attributes: {} },
    ],
  });
  const res = await captureStates(root, client, { name: 'evening', domains: ['light'] });

  expect(res.captured).toBe(1);
  expect(res.entities).toEqual(['light.living_room']);
  const latest = JSON.parse(
    readFileSync(join(root, '.claude-code-hermit/raw/snapshot-ha-states-evening-latest.json'), 'utf8'),
  );
  // friendly_name + supported_features dropped; only brightness kept.
  expect(latest.entities['light.living_room'].attributes).toEqual({ brightness: 200 });
});

test('restore blocks a sensitive entity under strict mode', async () => {
  const root = makeHaConfig('strict');
  const artifactPath = writeSnapshot(root, {
    'lock.front_door': { state: 'locked', attributes: {} },
  });
  const client = fakeClient();
  const res = await restoreStates(root, client, { artifactPath, confirm: false });

  expect(res.ok).toBe(false);
  expect(res.blocked).toBe(true);
  expect(res.sensitive).toContain('lock.front_door');
  expect(client.calls.post).toHaveLength(0);
});

test('restore of a non-sensitive light issues the expected scene.apply call', async () => {
  const root = makeHaConfig('strict');
  const artifactPath = writeSnapshot(root, {
    'light.living_room': { state: 'on', attributes: { brightness: 200 } },
  });
  const client = fakeClient({ post: () => ({}) });
  const res = await restoreStates(root, client, { artifactPath, confirm: false });

  expect(res.ok).toBe(true);
  expect(res.applied).toBe(1);
  expect(client.calls.post).toEqual([
    ['/api/services/scene/apply', { entities: { 'light.living_room': { state: 'on', brightness: 200 } } }],
  ]);
});

test('ask mode requires --confirm for a sensitive entity', async () => {
  const root = makeHaConfig('ask');
  const artifactPath = writeSnapshot(root, {
    'alarm_control_panel.home': { state: 'armed_away', attributes: {} },
  });
  const client = fakeClient({ post: () => ({}) });

  const noConfirm = await restoreStates(root, client, { artifactPath, confirm: false });
  expect(noConfirm.ok).toBe(false);
  expect(noConfirm.needsConfirm).toBe(true);
  expect(client.calls.post).toHaveLength(0);

  const confirmed = await restoreStates(root, client, { artifactPath, confirm: true });
  expect(confirmed.ok).toBe(true);
  expect(client.calls.post).toHaveLength(1);
});
