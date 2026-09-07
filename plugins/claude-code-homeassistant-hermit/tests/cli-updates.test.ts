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

// Regression gate: --digest wiring must never change default stdout — pinned
// as the output contract for ha-update-check's `reflect --check-id ha-update-check --check claude-code-homeassistant-hermit:ha-update-check`.
test('cli updates default output is byte-identical with and without the digest flag defaulting off', async () => {
  const deps = {
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
  };
  const withoutFlag = await captureOutput(() => handleUpdates(dummyConfig, deps));
  const withFlagFalse = await captureOutput(() => handleUpdates(dummyConfig, deps, false));
  // The header carries today's date; pin everything below it byte-for-byte and
  // require the two invocations to agree, so the date can't make this flake.
  const body = (out: string) => out.split('\n').slice(1).join('\n');
  expect(withFlagFalse.out).toBe(withoutFlag.out);
  expect(withoutFlag.out.split('\n')[0]).toStartWith('ha-update-check findings — ');
  expect(body(withoutFlag.out)).toBe(
    'Updates pending: 1\n- [core] Home Assistant Core: 2026.6.3 → 2026.7.1 — https://example.com/core\n',
  );
});

test('cli updates --digest emits tier-sorted digest lines instead of the default shape', async () => {
  const { code, out } = await captureOutput(() =>
    handleUpdates(
      dummyConfig,
      {
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
                },
              },
            ],
          }),
      },
      true,
    ),
  );
  expect(code).toBe(0);
  expect(out).toBe('[core] Home Assistant Core: 2026.6.3 → 2026.7.1\n');
  expect(out).not.toContain('ha-update-check findings');
  expect(out).not.toContain('Updates pending:');
});

test('cli updates --digest with zero updates matches the default (no updates pending) shape', async () => {
  const { code, out } = await captureOutput(() =>
    handleUpdates(dummyConfig, { createClient: async () => fakeClient({ getStates: () => [] }) }, true),
  );
  expect(code).toBe(0);
  expect(out).toContain('No actionable findings. (no updates pending)');
});

test('cli updates --digest on fetch failure matches the default (skipped:) shape', async () => {
  const { code, out } = await captureOutput(() =>
    handleUpdates(
      dummyConfig,
      {
        createClient: async () => {
          throw new HomeAssistantError('HA unreachable');
        },
      },
      true,
    ),
  );
  expect(code).toBe(0);
  expect(out).toContain('skipped:');
});
