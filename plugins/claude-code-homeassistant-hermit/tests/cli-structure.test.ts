// Tests for the WebSocket structural CLI commands (helpers, areas, registries)
// and the safety gate, driven through main() with an injected fake WS client.

import { afterEach, expect, test } from 'bun:test';

import { main } from '../src/cli';
import { AppConfig } from '../src/config';
import { HomeAssistantError } from '../src/ha-api';
import { clearPolicyCaches } from '../src/policy';
import { captureOutput, cleanupTmp, makeHaConfig, tmpPath, writeArtifact } from './helpers';

afterEach(() => {
  cleanupTmp();
  clearPolicyCaches();
});

/** A config whose root carries the given ha_safety_mode (omit ⇒ strict default). */
function cfg(mode?: string): AppConfig {
  const root = mode ? makeHaConfig(mode) : tmpPath();
  return new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
}

interface FakeWs {
  calls: Array<{ type: string; payload: Record<string, unknown> }>;
  closed: boolean;
  command(type: string, payload?: Record<string, unknown>): Promise<any>;
  close(): void;
}

function fakeWs(handler?: (type: string, payload: Record<string, unknown>) => any): FakeWs {
  return {
    calls: [],
    closed: false,
    async command(type: string, payload: Record<string, unknown> = {}) {
      this.calls.push({ type, payload });
      return handler ? handler(type, payload) : { result: 'ok' };
    },
    close() {
      this.closed = true;
    },
  };
}

function runCli(argv: string[], ws: FakeWs, config: AppConfig) {
  return captureOutput(() =>
    main(argv, { loadConfig: () => config, createWsClient: async () => ws }),
  );
}

// --- reads ---------------------------------------------------------------

test('list-areas reads via WS and closes', async () => {
  const ws = fakeWs(() => [{ area_id: 'a1', name: 'Office' }]);
  const { code, out } = await runCli(['ha', 'list-areas'], ws, cfg());
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(true);
  expect(parsed.data).toEqual([{ area_id: 'a1', name: 'Office' }]);
  expect(ws.calls).toEqual([{ type: 'config/area_registry/list', payload: {} }]);
  expect(ws.closed).toBe(true);
});

test('list-helpers fans out across all 8 types', async () => {
  const ws = fakeWs(() => []);
  const { code, out } = await runCli(['ha', 'list-helpers'], ws, cfg());
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(Object.keys(parsed.data).sort()).toEqual(
    ['counter', 'input_boolean', 'input_datetime', 'input_number', 'input_select', 'input_text', 'schedule', 'timer'].sort(),
  );
  expect(ws.calls.length).toBe(8);
});

test('list-helpers --type scopes to one', async () => {
  const ws = fakeWs(() => []);
  const { code } = await runCli(['ha', 'list-helpers', '--type', 'input_boolean'], ws, cfg());
  expect(code).toBe(0);
  expect(ws.calls).toEqual([{ type: 'input_boolean/list', payload: {} }]);
});

test('list-entities requires --registry', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'list-entities'], ws, cfg());
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('--registry');
  expect(ws.calls.length).toBe(0);
});

test('list-entities --registry reads entity registry', async () => {
  const ws = fakeWs(() => [{ entity_id: 'light.x' }]);
  const { code } = await runCli(['ha', 'list-entities', '--registry'], ws, cfg());
  expect(code).toBe(0);
  expect(ws.calls).toEqual([{ type: 'config/entity_registry/list', payload: {} }]);
});

// --- dashboards ------------------------------------------------------------

test('list-dashboards reads via WS and closes', async () => {
  const ws = fakeWs(() => [{ url_path: 'lovelace-home', id: 'd1', title: 'Home' }]);
  const { code, out } = await runCli(['ha', 'list-dashboards'], ws, cfg());
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(true);
  expect(parsed.data).toEqual([{ url_path: 'lovelace-home', id: 'd1', title: 'Home' }]);
  expect(ws.calls).toEqual([{ type: 'lovelace/dashboards/list', payload: {} }]);
  expect(ws.closed).toBe(true);
});

test('get-dashboard defaults to null url_path', async () => {
  const ws = fakeWs(() => ({ title: 'Home', views: [] }));
  const { code } = await runCli(['ha', 'get-dashboard'], ws, cfg());
  expect(code).toBe(0);
  expect(ws.calls).toEqual([{ type: 'lovelace/config', payload: { url_path: null } }]);
});

test('get-dashboard --url-path passes the named dashboard', async () => {
  const ws = fakeWs(() => ({ title: 'Home', views: [] }));
  const { code } = await runCli(['ha', 'get-dashboard', '--url-path', 'lovelace-home'], ws, cfg());
  expect(code).toBe(0);
  expect(ws.calls).toEqual([{ type: 'lovelace/config', payload: { url_path: 'lovelace-home' } }]);
});

// --- dashboard writes ------------------------------------------------------

test('delete-dashboard blocked under strict, no WS command sent', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'delete-dashboard', 'dashboard_cameras'], ws, cfg('strict'));
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.blocked).toBe(true);
  expect(parsed.requires_confirm).toBe(false);
  expect(ws.calls.length).toBe(0);
});

test('delete-dashboard under ask needs --confirm', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'delete-dashboard', 'dashboard_cameras'], ws, cfg('ask'));
  expect(code).toBe(1);
  expect(JSON.parse(out).requires_confirm).toBe(true);
  expect(ws.calls.length).toBe(0);
});

test('delete-dashboard sends dashboard_id payload', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(
    ['ha', 'delete-dashboard', 'dashboard_cameras', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(true);
  expect(parsed.report_path).toBeTruthy();
  expect(ws.calls).toEqual([
    { type: 'lovelace/dashboards/delete', payload: { dashboard_id: 'dashboard_cameras' } },
  ]);
});

test('create-dashboard rejects invalid JSON', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(
    ['ha', 'create-dashboard', 'not-json', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('valid JSON');
  expect(ws.calls.length).toBe(0);
});

test('create-dashboard sends parsed payload', async () => {
  const ws = fakeWs(() => ({ id: 'd9', url_path: 'hermit-test' }));
  const { code } = await runCli(
    ['ha', 'create-dashboard', '{"url_path":"hermit-test","title":"Hermit Test"}', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    {
      type: 'lovelace/dashboards/create',
      payload: { url_path: 'hermit-test', title: 'Hermit Test' },
    },
  ]);
});

test('apply-dashboard reads the artifact and sends url_path + config', async () => {
  const artifactPath = writeArtifact(tmpPath(), '{"title":"Hermit Test","views":[]}', 'dashboard.json');
  const ws = fakeWs(() => ({ result: 'ok' }));
  const { code } = await runCli(
    ['ha', 'apply-dashboard', artifactPath, '--url-path', 'hermit-test', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    {
      type: 'lovelace/config/save',
      payload: { url_path: 'hermit-test', config: { title: 'Hermit Test', views: [] } },
    },
  ]);
});

test('apply-dashboard defaults to null url_path', async () => {
  const artifactPath = writeArtifact(tmpPath(), '{"title":"Home","views":[]}', 'dashboard.json');
  const ws = fakeWs(() => ({ result: 'ok' }));
  const { code } = await runCli(['ha', 'apply-dashboard', artifactPath, '--confirm'], ws, cfg('ask'));
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    {
      type: 'lovelace/config/save',
      payload: { url_path: null, config: { title: 'Home', views: [] } },
    },
  ]);
});

test('dashboard write failure surfaces HA message and writes report', async () => {
  const ws = fakeWs(() => {
    throw new HomeAssistantError('Dashboard not found.');
  });
  const { code, out } = await runCli(
    ['ha', 'delete-dashboard', 'nope', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(false);
  expect(parsed.message).toBe('Dashboard not found.');
  expect(parsed.report_path).toBeTruthy();
});

// --- gate ----------------------------------------------------------------

test('mutation blocked under strict, no WS command sent', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'create-area', 'Office'], ws, cfg('strict'));
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.blocked).toBe(true);
  expect(parsed.requires_confirm).toBe(false);
  expect(parsed.message).toContain('proposal');
  expect(ws.calls.length).toBe(0);
});

test('mutation under ask needs --confirm', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'create-area', 'Office'], ws, cfg('ask'));
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.blocked).toBe(true);
  expect(parsed.requires_confirm).toBe(true);
  expect(ws.calls.length).toBe(0);
});

test('mutation under ask with --confirm runs', async () => {
  const ws = fakeWs(() => ({ area_id: 'a9' }));
  const { code, out } = await runCli(['ha', 'create-area', 'Office', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(true);
  expect(parsed.blocked).toBe(false);
  expect(parsed.report_path).toBeTruthy();
  expect(ws.calls).toEqual([{ type: 'config/area_registry/create', payload: { name: 'Office' } }]);
});

// --- helpers create/delete ----------------------------------------------

test('create-helper rejects unknown type', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(
    ['ha', 'create-helper', 'input_bogus', '{}', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('Unknown helper type');
  expect(ws.calls.length).toBe(0);
});

test('create-helper rejects invalid JSON', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(
    ['ha', 'create-helper', 'input_boolean', 'not-json', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('valid JSON');
  expect(ws.calls.length).toBe(0);
});

test('create-helper sends type/create with parsed payload', async () => {
  const ws = fakeWs(() => ({ id: 'h1' }));
  const { code } = await runCli(
    ['ha', 'create-helper', 'input_boolean', '{"name":"Guests"}', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([{ type: 'input_boolean/create', payload: { name: 'Guests' } }]);
});

test('delete-helper sends type/delete with id key', async () => {
  const ws = fakeWs();
  const { code } = await runCli(['ha', 'delete-helper', 'timer', 't1', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(0);
  expect(ws.calls).toEqual([{ type: 'timer/delete', payload: { timer_id: 't1' } }]);
});

// --- registry writes -----------------------------------------------------

test('rename-entity requires --name', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'rename-entity', 'light.x', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('--name');
  expect(ws.calls.length).toBe(0);
});

test('rename-entity updates the entity registry', async () => {
  const ws = fakeWs(() => ({ entity_entry: {} }));
  const { code } = await runCli(
    ['ha', 'rename-entity', 'light.x', '--name', 'Lamp', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    { type: 'config/entity_registry/update', payload: { entity_id: 'light.x', name: 'Lamp' } },
  ]);
});

test('set-entity-enabled false maps to disabled_by user', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-entity-enabled', 'light.x', '--enabled', 'false', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls[0]).toEqual({
    type: 'config/entity_registry/update',
    payload: { entity_id: 'light.x', disabled_by: 'user' },
  });
});

test('set-device-area updates the device registry', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-device-area', 'dev1', '--area', 'a1', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    { type: 'config/device_registry/update', payload: { device_id: 'dev1', area_id: 'a1' } },
  ]);
});

// --- floors --------------------------------------------------------------

test('list-floors reads via WS and closes', async () => {
  const ws = fakeWs(() => [{ floor_id: 'ground', name: 'Ground Floor', level: 0 }]);
  const { code, out } = await runCli(['ha', 'list-floors'], ws, cfg());
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.data).toEqual([{ floor_id: 'ground', name: 'Ground Floor', level: 0 }]);
  expect(ws.calls).toEqual([{ type: 'config/floor_registry/list', payload: {} }]);
  expect(ws.closed).toBe(true);
});

test('create-floor blocked under strict, no WS command sent', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'create-floor', 'Attic'], ws, cfg('strict'));
  expect(code).toBe(1);
  expect(JSON.parse(out).blocked).toBe(true);
  expect(ws.calls.length).toBe(0);
});

test('create-floor sends name payload', async () => {
  const ws = fakeWs(() => ({ floor_id: 'attic' }));
  const { code } = await runCli(['ha', 'create-floor', 'Attic', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(0);
  expect(ws.calls).toEqual([{ type: 'config/floor_registry/create', payload: { name: 'Attic' } }]);
});

test('delete-floor sends floor_id payload', async () => {
  const ws = fakeWs();
  const { code } = await runCli(['ha', 'delete-floor', 'attic', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(0);
  expect(ws.calls).toEqual([{ type: 'config/floor_registry/delete', payload: { floor_id: 'attic' } }]);
});

// --- labels --------------------------------------------------------------

test('list-labels reads via WS and closes', async () => {
  const ws = fakeWs(() => [{ label_id: 'security', name: 'Security' }]);
  const { code, out } = await runCli(['ha', 'list-labels'], ws, cfg());
  expect(code).toBe(0);
  expect(JSON.parse(out).data).toEqual([{ label_id: 'security', name: 'Security' }]);
  expect(ws.calls).toEqual([{ type: 'config/label_registry/list', payload: {} }]);
});

test('create-label sends name payload', async () => {
  const ws = fakeWs(() => ({ label_id: 'security' }));
  const { code } = await runCli(['ha', 'create-label', 'Security', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(0);
  expect(ws.calls).toEqual([{ type: 'config/label_registry/create', payload: { name: 'Security' } }]);
});

test('delete-label sends label_id payload', async () => {
  const ws = fakeWs();
  const { code } = await runCli(['ha', 'delete-label', 'security', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(0);
  expect(ws.calls).toEqual([{ type: 'config/label_registry/delete', payload: { label_id: 'security' } }]);
});

// --- Assist exposure ---------------------------------------------------------

test('list-exposed-entities reads via WS', async () => {
  const ws = fakeWs(() => ({ conversation: { 'light.x': { should_expose: true } } }));
  const { code, out } = await runCli(['ha', 'list-exposed-entities'], ws, cfg());
  expect(code).toBe(0);
  expect(JSON.parse(out).data).toEqual({ conversation: { 'light.x': { should_expose: true } } });
  expect(ws.calls).toEqual([{ type: 'homeassistant/expose_entity/list', payload: {} }]);
});

test('expose-entity requires --entity-ids', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(
    ['ha', 'expose-entity', '--assistants', 'conversation', '--expose', 'true', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('--entity-ids');
  expect(ws.calls.length).toBe(0);
});

test('expose-entity requires --assistants', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(
    ['ha', 'expose-entity', '--entity-ids', 'light.x', '--expose', 'true', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('--assistants');
  expect(ws.calls.length).toBe(0);
});

test('expose-entity requires --expose', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(
    ['ha', 'expose-entity', '--entity-ids', 'light.x', '--assistants', 'conversation', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('--expose');
  expect(ws.calls.length).toBe(0);
});

test('expose-entity sends entity_ids, assistants, and should_expose', async () => {
  const ws = fakeWs(() => ({ result: 'ok' }));
  const { code } = await runCli(
    [
      'ha',
      'expose-entity',
      '--entity-ids',
      'light.x',
      'light.y',
      '--assistants',
      'conversation',
      'cloud.alexa',
      '--expose',
      'true',
      '--confirm',
    ],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    {
      type: 'homeassistant/expose_entity',
      payload: {
        entity_ids: ['light.x', 'light.y'],
        assistants: ['conversation', 'cloud.alexa'],
        should_expose: true,
      },
    },
  ]);
});

test('expose-entity blocked under strict', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(
    ['ha', 'expose-entity', '--entity-ids', 'light.x', '--assistants', 'conversation', '--expose', 'false'],
    ws,
    cfg('strict'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).blocked).toBe(true);
  expect(ws.calls.length).toBe(0);
});

// --- entity metadata extensions ---------------------------------------------

test('set-entity-icon updates the entity registry', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-entity-icon', 'light.x', '--icon', 'mdi:lamp', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    { type: 'config/entity_registry/update', payload: { entity_id: 'light.x', icon: 'mdi:lamp' } },
  ]);
});

test('set-entity-hidden true maps to hidden_by user', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-entity-hidden', 'light.x', '--hidden', 'true', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    { type: 'config/entity_registry/update', payload: { entity_id: 'light.x', hidden_by: 'user' } },
  ]);
});

test('set-entity-hidden false maps to hidden_by null', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-entity-hidden', 'light.x', '--hidden', 'false', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    { type: 'config/entity_registry/update', payload: { entity_id: 'light.x', hidden_by: null } },
  ]);
});

test('set-entity-labels requires --labels', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'set-entity-labels', 'light.x', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('--labels');
  expect(ws.calls.length).toBe(0);
});

test('set-entity-labels sends multiple labels', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-entity-labels', 'light.x', '--labels', 'security', 'main-floor', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    {
      type: 'config/entity_registry/update',
      payload: { entity_id: 'light.x', labels: ['security', 'main-floor'] },
    },
  ]);
});

test('set-entity-categories rejects invalid JSON', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(
    ['ha', 'set-entity-categories', 'light.x', '--categories', 'not-json', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('valid JSON');
  expect(ws.calls.length).toBe(0);
});

test('set-entity-categories sends the parsed scoped mapping', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-entity-categories', 'light.x', '--categories', '{"automation":"config"}', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    {
      type: 'config/entity_registry/update',
      payload: { entity_id: 'light.x', categories: { automation: 'config' } },
    },
  ]);
});

test('set-entity-aliases requires --aliases', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'set-entity-aliases', 'light.x', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('--aliases');
  expect(ws.calls.length).toBe(0);
});

test('set-entity-aliases sends multiple aliases', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-entity-aliases', 'light.x', '--aliases', 'lamp', 'reading light', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    {
      type: 'config/entity_registry/update',
      payload: { entity_id: 'light.x', aliases: ['lamp', 'reading light'] },
    },
  ]);
});

// --- area metadata ---------------------------------------------------------

test('rename-area requires --name', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'rename-area', 'a1', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('--name');
  expect(ws.calls.length).toBe(0);
});

test('rename-area updates the area registry', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'rename-area', 'a1', '--name', 'Living Room', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    { type: 'config/area_registry/update', payload: { area_id: 'a1', name: 'Living Room' } },
  ]);
});

test('set-area-icon updates the area registry', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-area-icon', 'a1', '--icon', 'mdi:sofa', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    { type: 'config/area_registry/update', payload: { area_id: 'a1', icon: 'mdi:sofa' } },
  ]);
});

test('set-area-floor updates the area registry', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-area-floor', 'a1', '--floor', 'ground', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    { type: 'config/area_registry/update', payload: { area_id: 'a1', floor_id: 'ground' } },
  ]);
});

test('set-area-labels requires --labels', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'set-area-labels', 'a1', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('--labels');
  expect(ws.calls.length).toBe(0);
});

test('set-area-labels updates the area registry with multiple labels', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    ['ha', 'set-area-labels', 'a1', '--labels', 'security', 'main-floor', '--confirm'],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    {
      type: 'config/area_registry/update',
      payload: { area_id: 'a1', labels: ['security', 'main-floor'] },
    },
  ]);
});

// --- core config -----------------------------------------------------------

test('set-core-config requires at least one field flag', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'set-core-config'], ws, cfg('ask'));
  expect(code).toBe(1);
  expect(JSON.parse(out).message).toContain('At least one config field flag');
  expect(ws.calls.length).toBe(0);
});

test('set-core-config blocked under strict', async () => {
  const ws = fakeWs();
  const { code, out } = await runCli(['ha', 'set-core-config', '--currency', 'EUR'], ws, cfg('strict'));
  expect(code).toBe(1);
  expect(JSON.parse(out).blocked).toBe(true);
  expect(ws.calls.length).toBe(0);
});

test('set-core-config sends only the provided fields, coercing numerics', async () => {
  const ws = fakeWs();
  const { code } = await runCli(
    [
      'ha',
      'set-core-config',
      '--latitude',
      '38.7223',
      '--longitude',
      '-9.1393',
      '--elevation',
      '10',
      '--unit-system',
      'metric',
      '--currency',
      'EUR',
      '--time-zone',
      'Europe/Lisbon',
      '--country',
      'PT',
      '--confirm',
    ],
    ws,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(ws.calls).toEqual([
    {
      type: 'config/core/update',
      payload: {
        latitude: 38.7223,
        longitude: -9.1393,
        elevation: 10,
        unit_system: 'metric',
        currency: 'EUR',
        time_zone: 'Europe/Lisbon',
        country: 'PT',
      },
    },
  ]);
});

// --- HA failure surfaces verbatim ---------------------------------------

test('WS command failure surfaces HA message and writes report', async () => {
  const ws = fakeWs(() => {
    throw new HomeAssistantError('Area name already exists.');
  });
  const { code, out } = await runCli(['ha', 'create-area', 'Office', '--confirm'], ws, cfg('ask'));
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(false);
  expect(parsed.message).toBe('Area name already exists.');
  expect(parsed.report_path).toBeTruthy();
});
