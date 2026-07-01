// Tests for 'ha call-service' — the per-entity/service policy gate
// (gateServiceCall), distinct from gateStructuralMutation: non-sensitive
// calls proceed in both modes; sensitive ones follow strict/ask like every
// other gate.

import { afterEach, expect, test } from 'bun:test';

import { main } from '../src/cli';
import { HomeAssistantError } from '../src/ha-api';
import { clearPolicyCaches } from '../src/policy';
import { captureOutput, cleanupTmp, fakeClient, makeHaConfig, tmpPath, type FakeClient } from './helpers';
import { AppConfig } from '../src/config';

afterEach(() => {
  cleanupTmp();
  clearPolicyCaches();
});

function cfg(mode?: string): AppConfig {
  const root = mode ? makeHaConfig(mode) : tmpPath();
  return new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
}

function runCli(argv: string[], client: FakeClient, config: AppConfig) {
  return captureOutput(() =>
    main(argv, { loadConfig: () => config, createClient: async () => client }),
  );
}

test('rejects a target with no dot', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(['ha', 'call-service', 'reload_all'], client, cfg());
  expect(code).toBe(2);
  expect(JSON.parse(out).message).toContain("must contain a '.'");
});

test('rejects invalid --data JSON', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'automation.reload', '--data', 'not-json'],
    client,
    cfg(),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('valid JSON');
});

test('non-sensitive service call proceeds under strict with no --confirm', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(['ha', 'call-service', 'automation.reload'], client, cfg('strict'));
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(true);
  expect(parsed.blocked).toBe(false);
  expect(parsed.report_path).toBeTruthy();
  expect(client.calls.post).toEqual([['/api/services/automation/reload', {}]]);
});

test('sensitive domain via --data entity_id blocked under strict', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'lock.unlock', '--data', '{"entity_id":"lock.front_door"}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.blocked).toBe(true);
  expect(parsed.requires_confirm).toBe(false);
  expect(client.calls.post.length).toBe(0);
});

test('sensitive domain under ask needs --confirm', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'lock.unlock', '--data', '{"entity_id":"lock.front_door"}'],
    client,
    cfg('ask'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).requires_confirm).toBe(true);
  expect(client.calls.post.length).toBe(0);
});

test('sensitive domain under ask with --confirm runs', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    ['ha', 'call-service', 'lock.unlock', '--data', '{"entity_id":"lock.front_door"}', '--confirm'],
    client,
    cfg('ask'),
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(true);
  expect(client.calls.post).toEqual([
    ['/api/services/lock/unlock', { entity_id: 'lock.front_door' }],
  ]);
});

test('target as an array (not an object) fails closed instead of silently extracting nothing', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'light.turn_off', '--data', '{"target":["lock.front_door"]}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.blocked).toBe(true);
  expect(parsed.message).toContain('malformed targeting field');
  expect(client.calls.post.length).toBe(0);
});

test('non-string entity_id fails closed instead of silently extracting nothing', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'light.turn_off', '--data', '{"entity_id":123}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('malformed targeting field');
  expect(client.calls.post.length).toBe(0);
});

test('mixed-type entity_id array fails closed', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'light.turn_off', '--data', '{"entity_id":["light.x", 42]}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('malformed targeting field');
});

test('unresolvable area_id target fails closed in both modes', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'light.turn_off', '--data', '{"target":{"area_id":"living_room"}}'],
    client,
    cfg('ask'),
  );
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.blocked).toBe(true);
  expect(parsed.requires_confirm).toBe(false);
  expect(parsed.message).toContain('no resolvable entity IDs');
  expect(client.calls.post.length).toBe(0);
});

test('HA error surfaces verbatim', async () => {
  const client = fakeClient({
    post: () => {
      throw new HomeAssistantError('Service not found.', 400);
    },
  });
  const { code, out } = await runCli(['ha', 'call-service', 'automation.reload'], client, cfg());
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(false);
  expect(parsed.message).toBe('Service not found. (status=400)');
});

test('sensitive entity hidden in scene.apply entities map is blocked under strict', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    ['ha', 'call-service', 'scene.apply', '--data', '{"entities":{"lock.front_door":"unlocked"}}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.blocked).toBe(true);
  expect(client.calls.post.length).toBe(0);
});

test('sensitive entity in scene.apply entities map needs --confirm under ask', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    ['ha', 'call-service', 'scene.apply', '--data', '{"entities":{"lock.front_door":"unlocked"}}'],
    client,
    cfg('ask'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).requires_confirm).toBe(true);
  expect(client.calls.post.length).toBe(0);
});

test('non-sensitive entities in scene.apply map still proceed under strict', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    ['ha', 'call-service', 'scene.apply', '--data', '{"entities":{"light.living_room":"on"}}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out).ok).toBe(true);
  expect(client.calls.post).toEqual([
    ['/api/services/scene/apply', { entities: { 'light.living_room': 'on' } }],
  ]);
});
