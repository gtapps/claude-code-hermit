import { afterAll, expect, test } from 'bun:test';

import type { AppConfig } from '../src/config';
import { handleUpdates } from '../src/cli';
import { HomeAssistantError } from '../src/ha-api';
import { captureOutput, cleanupTmp, fakeClient } from './helpers';

afterAll(cleanupTmp);

const dummyConfig = {} as AppConfig;

test('cli updates emits fixed stdout shape with a pending update', async () => {
  const { code, out } = await captureOutput(() =>
    handleUpdates(dummyConfig, {
      createClient: async () =>
        fakeClient({
          getStates: () => [
            {
              entity_id: 'update.home_assistant_core_update',
              state: 'on',
              attributes: {
                title: 'Home Assistant Core',
                installed_version: '2026.6.3',
                latest_version: '2026.7.1',
                release_url: 'https://example.com/core',
              },
            },
          ],
        }),
    }),
  );
  expect(code).toBe(0);
  expect(out.startsWith('ha-update-check findings —')).toBe(true);
  expect(out).toContain('Updates pending: 1');
  expect(out).toContain('[core] Home Assistant Core');
});

test('cli updates reports no actionable findings when nothing pending', async () => {
  const { code, out } = await captureOutput(() =>
    handleUpdates(dummyConfig, { createClient: async () => fakeClient({ getStates: () => [] }) }),
  );
  expect(code).toBe(0);
  expect(out).toContain('No actionable findings. (no updates pending)');
});

test('cli updates skips cleanly when HA is unreachable', async () => {
  const { code, out } = await captureOutput(() =>
    handleUpdates(dummyConfig, {
      createClient: async () => {
        throw new HomeAssistantError('HA unreachable');
      },
    }),
  );
  expect(code).toBe(0);
  expect(out).toContain('skipped:');
});
