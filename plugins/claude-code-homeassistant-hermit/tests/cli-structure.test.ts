// Tests for the WebSocket structural CLI commands (helpers, areas, registries)
// and the safety gate, driven through main() with an injected fake WS client.

import { afterEach, expect, test } from 'bun:test';

import { main } from '../src/cli';
import { AppConfig } from '../src/config';
import { HomeAssistantError } from '../src/ha-api';
import { clearPolicyCaches } from '../src/policy';
import { captureOutput, cleanupTmp, makeHaConfig, tmpPath } from './helpers';

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
