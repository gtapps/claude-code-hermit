// WP7 tier 2: tests for src/ha-api.ts — 1:1 port of tests/test_ha_api.py
// (14 cases).
//
// pytest fixture mapping:
//   - tmp_path -> mkdtempSync
//   - save_boot_preferences (boot.py, tier 3) -> saveEnvFile (the helper's
//     .env subset is all load_config reads in these tests)
//   - patch("...select_home_assistant_url") during construction -> the direct
//     HomeAssistantClient constructor, which takes a pre-selected base URL
//   - patch.object(client, "get") -> instance property assignment
//   - patch("...probe_home_assistant_url", return_value=False) -> an injected
//     fetch that rejects (probe catches and returns false)

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, saveEnvFile } from '../src/config';
import { HomeAssistantClient, HomeAssistantError, selectHomeAssistantUrl } from '../src/ha-api';

const tmpDirs: string[] = [];
const ENV_KEYS = [
  'HOMEASSISTANT_URL',
  'HOMEASSISTANT_LOCAL_URL',
  'HOMEASSISTANT_REMOTE_URL',
  'HOMEASSISTANT_TOKEN',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ha-api-test-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a HomeAssistantClient whose URL probe is bypassed. */
function makeClient(tmp: string): HomeAssistantClient {
  saveEnvFile(tmp, { HOMEASSISTANT_URL: 'http://ha.local:8123', HOMEASSISTANT_TOKEN: 'fake-token' });
  const config = loadConfig(tmp);
  return new HomeAssistantClient(config, 'http://ha.local:8123', 'test');
}

function stubGet(
  client: HomeAssistantClient,
  impl: (path: string) => Array<Array<Record<string, any>>> | Record<string, any>,
): string[] {
  const captured: string[] = [];
  (client as any).get = async (path: string) => {
    captured.push(path);
    return impl(path);
  };
  return captured;
}

const T0 = new Date(Date.UTC(2026, 4, 1, 0, 0, 0));
const T1 = new Date(Date.UTC(2026, 4, 8, 0, 0, 0));

/** A fetch that always fails — probes report unreachable. */
const unreachableFetch = (async () => {
  throw new Error('unreachable');
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// getHistory — response mapping
// ---------------------------------------------------------------------------

test('get_history returns dict keyed by entity from response', async () => {
  const client = makeClient(tmpPath());
  const response = [
    [
      { entity_id: 'light.kitchen', state: 'on' },
      { entity_id: 'light.kitchen', state: 'off' },
    ],
    [{ entity_id: 'switch.fan', state: 'on' }],
  ];
  stubGet(client, () => response);
  const result = await client.getHistory(['light.kitchen', 'switch.fan'], T0, T1);
  expect(Object.keys(result).sort()).toEqual(['light.kitchen', 'switch.fan']);
  expect(result['light.kitchen']).toEqual(response[0]!);
  expect(result['switch.fan']).toEqual(response[1]!);
});

test('get_history raises on empty entity_ids', async () => {
  const client = makeClient(tmpPath());
  await expect(client.getHistory([], T0, T1)).rejects.toThrow(/entity_ids/);
});

test('get_history omits entities with no events from response', async () => {
  const client = makeClient(tmpPath());
  // HA omits entities that had no events — only light.kitchen returned
  stubGet(client, () => [[{ entity_id: 'light.kitchen', state: 'on' }]]);
  const result = await client.getHistory(['light.kitchen', 'switch.fan'], T0, T1);
  expect(Object.keys(result)).toContain('light.kitchen');
  expect(Object.keys(result)).not.toContain('switch.fan');
});

test('get_history resilient to response reordering', async () => {
  const client = makeClient(tmpPath());
  // Response arrives in reverse order from what we requested
  const response = [
    [{ entity_id: 'switch.fan', state: 'on' }],
    [{ entity_id: 'light.kitchen', state: 'off' }],
  ];
  stubGet(client, () => response);
  const result = await client.getHistory(['light.kitchen', 'switch.fan'], T0, T1);
  expect(result['light.kitchen']).toEqual(response[1]!);
  expect(result['switch.fan']).toEqual(response[0]!);
});

test('get_history returns empty dict on non-list response', async () => {
  const client = makeClient(tmpPath());
  stubGet(client, () => ({ error: 'unexpected' }));
  const result = await client.getHistory(['light.kitchen'], T0, T1);
  expect(result).toEqual({});
});

// ---------------------------------------------------------------------------
// getHistory — URL construction
// ---------------------------------------------------------------------------

test('get_history url-encodes ISO8601 plus sign and colons', async () => {
  const client = makeClient(tmpPath());
  const captured = stubGet(client, () => []);
  await client.getHistory(['light.x'], T0, T1);

  const path = captured[0]!;
  // Colons and plus signs must be percent-encoded in the ISO timestamp
  expect(path.split('?')[0]).not.toContain(':'); // start_iso in path segment
  expect(path).toContain('%3A'); // encoded colon
  expect(path).toContain('%2B'); // encoded plus sign from UTC offset
});

test('get_history uses bare-flag query string', async () => {
  const client = makeClient(tmpPath());
  const captured = stubGet(client, () => []);
  await client.getHistory(['light.x'], T0, T1);

  const path = captured[0]!;
  expect(path).toContain('&minimal_response');
  expect(path).not.toContain('minimal_response=true');
  expect(path).toContain('&significant_changes_only');
  expect(path).not.toContain('significant_changes_only=true');
  expect(path).toContain('&end_time=');
});

test('get_history requires explicit end_time', async () => {
  const client = makeClient(tmpPath());
  stubGet(client, () => []);
  await expect(client.getHistory(['light.x'], T0, null as unknown as Date)).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// getHistory — chunking for large entity lists
// ---------------------------------------------------------------------------

function parseFilterEntityIds(path: string): string[] {
  const query = new URLSearchParams(path.split('?')[1]!);
  return query.get('filter_entity_id')!.split(',');
}

function entityRange(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `light.x${String(i).padStart(3, '0')}`);
}

test('get_history single chunk when under limit', async () => {
  const client = makeClient(tmpPath());
  const captured = stubGet(client, () => []);
  await client.getHistory(entityRange(50), T0, T1);

  // Exactly at the chunk size — still one request, no chunking overhead
  expect(captured.length).toBe(1);
  expect(parseFilterEntityIds(captured[0]!).length).toBe(50);
});

test('get_history chunks large entity lists and merges results', async () => {
  const client = makeClient(tmpPath());
  const entityIds = entityRange(120);
  const captured = stubGet(client, (path) =>
    // HA returns one inner list per entity that had events
    parseFilterEntityIds(path).map((eid) => [{ entity_id: eid, state: 'on' }]),
  );
  const result = await client.getHistory(entityIds, T0, T1);

  // 120 entities at chunk size 50 → ceil(120/50) == 3 chunks
  expect(captured.length).toBe(3);
  expect(captured.map((p) => parseFilterEntityIds(p).length)).toEqual([50, 50, 20]);
  // Merged result covers every requested entity
  expect(Object.keys(result).sort()).toEqual([...entityIds].sort());
});

test('get_history dedupes entity_ids before chunking', async () => {
  const client = makeClient(tmpPath());
  // 60 unique entities, each repeated twice → 120 entries
  const entityIds = [...entityRange(60), ...entityRange(60)];
  const captured = stubGet(client, () => []);
  await client.getHistory(entityIds, T0, T1);

  // After de-dup: 60 entities → 2 chunks of 50 and 10, not 3 chunks of 50/50/20
  expect(captured.length).toBe(2);
  expect(captured.map((p) => parseFilterEntityIds(p).length)).toEqual([50, 10]);
});

// ---------------------------------------------------------------------------
// selectHomeAssistantUrl (pre-existing tests)
// ---------------------------------------------------------------------------

test('select url dual mode both unreachable falls back to local', async () => {
  const tmp = tmpPath();
  saveEnvFile(tmp, {
    HOMEASSISTANT_LOCAL_URL: 'http://ha.local:8123',
    HOMEASSISTANT_REMOTE_URL: 'https://ha.remote.com',
    HOMEASSISTANT_TOKEN: 'tok',
  });
  const config = loadConfig(tmp);
  const [url, source] = await selectHomeAssistantUrl(config, unreachableFetch);
  expect(url).toBe('http://ha.local:8123');
  expect(source).toBe('fallback');
});

test('select url raises when token missing', async () => {
  const tmp = tmpPath();
  saveEnvFile(tmp, { HOMEASSISTANT_URL: 'http://ha.local:8123' });
  const config = loadConfig(tmp);
  await expect(selectHomeAssistantUrl(config, unreachableFetch)).rejects.toThrow(
    HomeAssistantError,
  );
  await expect(selectHomeAssistantUrl(config, unreachableFetch)).rejects.toThrow(/TOKEN/);
});

test('select url raises when no url configured', async () => {
  const tmp = tmpPath();
  saveEnvFile(tmp, { HOMEASSISTANT_TOKEN: 'tok' });
  const config = loadConfig(tmp);
  await expect(selectHomeAssistantUrl(config, unreachableFetch)).rejects.toThrow(/URL/);
});
