import { afterAll, expect, test } from 'bun:test';

import { main } from '../src/cli';
import { captureOutput, cleanupTmp, fakeClient, makeMockConfig } from './helpers';

afterAll(cleanupTmp);

function makeDeps(postResult: Record<string, unknown> = {}) {
  const client = fakeClient({ post: () => postResult });
  return {
    calls: client.calls,
    deps: { createClient: async () => client, loadConfig: () => makeMockConfig() },
  };
}

test('trigger-automation: success', async () => {
  const { calls, deps } = makeDeps({ result: 'ok' });

  const { code, out } = await captureOutput(() =>
    main(['ha', 'trigger-automation', 'automation.morning_routine'], deps),
  );

  expect(code).toBe(0);
  const json = JSON.parse(out.trim());
  expect(json).toEqual({ status: 'ok', automation_id: 'automation.morning_routine' });
  expect(calls.post[0]![0]).toBe('/api/services/automation/trigger');
  expect(calls.post[0]![1]).toMatchObject({ entity_id: 'automation.morning_routine' });
});

test('trigger-automation: rejects non-automation entity_id', async () => {
  const { deps } = makeDeps();

  const { code, out } = await captureOutput(() =>
    main(['ha', 'trigger-automation', 'light.kitchen'], deps),
  );

  expect(code).toBe(2);
  const json = JSON.parse(out.trim());
  expect(json.status).toBe('error');
  expect(json.message).toContain('automation.');
});

test('trigger-automation: HA error → status error exit 1', async () => {
  const { HomeAssistantError } = await import('../src/ha-api');
  const errClient = fakeClient({
    post: () => {
      throw new HomeAssistantError('Entity not found', 404);
    },
  });
  const deps = {
    createClient: async () => errClient,
    loadConfig: () => makeMockConfig(),
  };

  const { code, out } = await captureOutput(() =>
    main(['ha', 'trigger-automation', 'automation.missing'], deps),
  );

  expect(code).toBe(1);
  const json = JSON.parse(out.trim());
  expect(json.status).toBe('error');
});

test('trigger-automation: missing arg → exit 2', async () => {
  const { code } = await captureOutput(() => main(['ha', 'trigger-automation'], {}));
  expect(code).toBe(2);
});
