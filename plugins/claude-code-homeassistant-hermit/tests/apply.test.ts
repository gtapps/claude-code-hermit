// WP7 tier 3: tests for src/apply.ts — 1:1 port of tests/test_apply.py
// (23 cases).
//
// pytest fixture mapping: MagicMock client -> fakeClient (helpers.ts);
// side_effect sequences -> closure-queued handlers that throw on demand.

import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { removeConfig, validateAndApply } from '../src/apply';
import { HomeAssistantError, extractHaErrorMessage } from '../src/ha-api';
import { clearPolicyCaches } from '../src/policy';
import { cleanupTmp, fakeClient, makeHaRoot, writeArtifact } from './helpers';

afterEach(() => {
  cleanupTmp();
  clearPolicyCaches();
});

const SAFE_YAML = `alias: Safe automation
actions:
  - service: light.turn_on
    target:
      entity_id: light.living_room`;

const SAFE_YAML_WITH_ID = `id: my_automation
alias: Safe automation
actions:
  - service: light.turn_on
    target:
      entity_id: light.living_room`;

const SENSITIVE_YAML = `alias: Unsafe automation
actions:
  - service: lock.lock
    target:
      entity_id: lock.front_door`;

const SENSITIVE_ALARM_YAML = `id: disarm_home
alias: Disarm
actions:
  - service: alarm_control_panel.alarm_disarm
    target:
      entity_id: alarm_control_panel.home`;

const SCRIPT_YAML = `id: my_script
alias: Safe script
sequence:
  - delay: "00:00:01"`;

const SCENE_YAML = `id: my_scene
name: Movie Night
entities:
  light.living_room:
    state: "on"
    brightness: 80`;

const safeRoot = () => makeHaRoot();

/** post handler that pops a queue; entries may be values or thrown errors. */
function sideEffect(queue: Array<unknown | (() => never)>): () => any {
  return () => {
    const next = queue.shift();
    if (typeof next === 'function') (next as () => never)();
    return next;
  };
}

const raise = (exc: Error) => () => {
  throw exc;
};

// --- existing tests (updated) ---

test('sensitive yaml is blocked before network call', async () => {
  const root = makeHaRoot({
    entity_index: {
      'lock.front_door': { entity_id: 'lock.front_door', state: 'locked' },
    },
  });
  const artifact = writeArtifact(root, SENSITIVE_YAML);
  const client = fakeClient();

  const result = await validateAndApply(root, client, artifact);

  expect(result.ok).toBe(false);
  expect(client.calls.post.length).toBe(0);
});

test('config check failure returns not ok', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML);
  const client = fakeClient({ post: raise(new HomeAssistantError('connection refused')) });

  const result = await validateAndApply(root, client, artifact);

  expect(result.ok).toBe(false);
  expect(result.reloadAttempted).toBe(false);
});

test('valid yaml with reload calls reload', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML);
  const client = fakeClient({
    post: () => ({ result: 'valid' }),
    get: () => ({ alias: 'Safe automation' }),
  });

  const result = await validateAndApply(root, client, artifact, 'automation');

  expect(result.ok).toBe(true);
  expect(result.reloadAttempted).toBe(true);
  expect(client.calls.post).toContainEqual(['/api/services/automation/reload', {}]);
});

test('invalid reload domain is blocked', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML);
  const client = fakeClient({ post: () => ({ result: 'valid' }) });

  const result = await validateAndApply(root, client, artifact, 'shell_command');

  expect(result.ok).toBe(false);
  expect(result.reloadAttempted).toBe(false);
  expect(result.message).toBe('reload-blocked');
});

test('valid yaml no reload', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML);
  const client = fakeClient({ post: () => true });

  const result = await validateAndApply(root, client, artifact);

  expect(result.ok).toBe(true);
  expect(result.reloadAttempted).toBe(false);
  expect(result.creationAttempted).toBe(false);
});

// --- REST push tests ---

test('pushes automation config via rest', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML_WITH_ID);
  const client = fakeClient({
    post: () => ({ result: 'valid' }),
    get: () => ({ alias: 'Safe automation' }),
  });

  const result = await validateAndApply(root, client, artifact, 'automation');

  expect(result.ok).toBe(true);
  expect(result.creationAttempted).toBe(true);
  expect(client.calls.post).toContainEqual([
    '/api/config/automation/config/my_automation',
    {
      id: 'my_automation',
      alias: 'Safe automation',
      actions: [{ service: 'light.turn_on', target: { entity_id: 'light.living_room' } }],
    },
  ]);
});

test('pushes script config via rest', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SCRIPT_YAML);
  const client = fakeClient({
    post: () => ({ result: 'valid' }),
    get: () => ({ alias: 'Safe script' }),
  });

  const result = await validateAndApply(root, client, artifact, 'script');

  expect(result.ok).toBe(true);
  expect(result.creationAttempted).toBe(true);
  expect(client.calls.post).toContainEqual([
    '/api/config/script/config/my_script',
    { id: 'my_script', alias: 'Safe script', sequence: [{ delay: '00:00:01' }] },
  ]);
});

test('pushes scene config via rest', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SCENE_YAML);
  const client = fakeClient({
    post: () => ({ result: 'ok' }),
    get: () => ({ id: 'my_scene', name: 'Movie Night' }),
  });

  const result = await validateAndApply(root, client, artifact, 'scene');

  expect(result.ok).toBe(true);
  expect(result.creationAttempted).toBe(true);
  expect(result.creationOk).toBe(true);
  expect(client.calls.post).toContainEqual([
    '/api/config/scene/config/my_scene',
    { id: 'my_scene', name: 'Movie Night', entities: { 'light.living_room': { state: 'on', brightness: 80 } } },
  ]);
  // reload service call uses the scene domain
  expect(client.calls.post).toContainEqual(['/api/services/scene/reload', {}]);
});

test('id extracted from yaml id field', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML_WITH_ID);
  const client = fakeClient({
    post: () => ({ result: 'valid' }),
    get: () => ({ alias: 'Safe automation' }),
  });

  const result = await validateAndApply(root, client, artifact, 'automation');

  expect(result.configId).toBe('my_automation');
  expect(result.creationOk).toBe(true);
});

test('id generated from alias when no id', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML);
  const client = fakeClient({
    post: () => ({ result: 'valid' }),
    get: () => ({ alias: 'Safe automation' }),
  });

  const result = await validateAndApply(root, client, artifact, 'automation');

  expect(result.configId).toBe('Safe_automation');
  expect(result.message).toContain('derived from alias');
});

test('id generated from stem when no id no alias', async () => {
  const root = safeRoot();
  const yamlContent =
    'actions:\n  - service: light.turn_on\n    target:\n      entity_id: light.living_room';
  const artifact = writeArtifact(root, yamlContent, 'my_rule.yaml');
  const client = fakeClient({ post: () => ({ result: 'valid' }), get: () => ({}) });

  const result = await validateAndApply(root, client, artifact, 'automation');

  expect(result.configId).toBe('my_rule');
  expect(result.message).toContain('derived from filename');
});

test('skip push when no reload domain', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML_WITH_ID);
  const client = fakeClient({ post: () => true });

  const result = await validateAndApply(root, client, artifact);

  expect(result.ok).toBe(true);
  expect(result.creationAttempted).toBe(false);
  expect(result.configId).toBeNull();
  // only the check_config POST, not the config-push POST
  expect(client.calls.post).toEqual([['/api/config/core/check_config', {}]]);
});

test('verify ok sets creation_ok true', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML_WITH_ID);
  const client = fakeClient({
    post: () => ({ result: 'valid' }),
    get: () => ({ alias: 'Safe automation' }),
  });

  const result = await validateAndApply(root, client, artifact, 'automation');

  expect(result.creationOk).toBe(true);
});

test('verify failure keeps overall ok true', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML_WITH_ID);
  const client = fakeClient({
    post: () => ({ result: 'valid' }),
    get: raise(new HomeAssistantError('GET failed')),
  });

  const result = await validateAndApply(root, client, artifact, 'automation');

  expect(result.ok).toBe(true);
  expect(result.creationAttempted).toBe(true);
  expect(result.creationOk).toBe(false);
});

test('403 yaml mode falls back with clear message', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML_WITH_ID);
  const client = fakeClient({
    post: sideEffect([
      { result: 'valid' }, // check_config succeeds
      raise(new HomeAssistantError('Forbidden', 403)), // config push fails
      { result: 'ok' }, // reload succeeds
    ]),
  });

  const result = await validateAndApply(root, client, artifact, 'automation');

  expect(result.ok).toBe(true);
  expect(result.creationAttempted).toBe(true);
  expect(result.creationOk).toBe(false);
  expect(result.reloadAttempted).toBe(true);
  expect(result.message).toContain('YAML mode');
});

test('400 invalid payload surfaces HA message', async () => {
  const root = safeRoot();
  const artifact = writeArtifact(root, SAFE_YAML_WITH_ID);
  const client = fakeClient({
    post: sideEffect([
      { result: 'valid' }, // check_config
      raise(
        new HomeAssistantError(
          'Bad request',
          400,
          '{"message":"Message malformed: required key not provided @ data[\'triggers\']"}',
        ),
      ),
    ]),
  });

  const result = await validateAndApply(root, client, artifact, 'automation');

  expect(result.ok).toBe(false);
  expect(result.creationAttempted).toBe(true);
  expect(result.creationOk).toBe(false);
  expect(result.message).toContain('Message malformed');
});

// --- removeConfig tests ---

test('remove automation ok', async () => {
  const root = safeRoot();
  const client = fakeClient({ del: () => ({ result: 'ok' }) });

  const result = await removeConfig(root, client, 'automation', 'my_automation');

  expect(result.ok).toBe(true);
  expect(result.message).toBe('ok');
  expect(client.calls.delete).toEqual(['/api/config/automation/config/my_automation']);
});

test('remove script ok', async () => {
  const root = safeRoot();
  const client = fakeClient({ del: () => ({ result: 'ok' }) });

  const result = await removeConfig(root, client, 'script', 'my_script');

  expect(result.ok).toBe(true);
  expect(client.calls.delete).toEqual(['/api/config/script/config/my_script']);
});

test('remove scene ok', async () => {
  const root = safeRoot();
  const client = fakeClient({ del: () => ({ result: 'ok' }) });

  const result = await removeConfig(root, client, 'scene', 'my_scene');

  expect(result.ok).toBe(true);
  expect(client.calls.delete).toEqual(['/api/config/scene/config/my_scene']);
});

test('remove returns 400 with resource not found', async () => {
  const root = safeRoot();
  const client = fakeClient({
    del: raise(
      new HomeAssistantError('Home Assistant request failed.', 400, '{"message":"Resource not found"}'),
    ),
  });

  const result = await removeConfig(root, client, 'automation', 'nonexistent_id');

  expect(result.ok).toBe(false);
  expect(result.message).toBe('Resource not found');
});

test('remove invalid domain', async () => {
  const root = safeRoot();
  const client = fakeClient();

  const result = await removeConfig(root, client, 'shell_command', 'my_id');

  expect(result.ok).toBe(false);
  expect(result.message).toContain('not a configurable domain');
  expect(client.calls.delete.length).toBe(0);
});

// --- extractHaErrorMessage tests ---

test('extract_ha_error_message pulls message field', () => {
  const exc = new HomeAssistantError('failed', 400, '{"message":"Resource not found"}');
  expect(extractHaErrorMessage(exc)).toBe('Resource not found');
});

test('extract_ha_error_message falls back on non-json', () => {
  const exc = new HomeAssistantError('plain error', 500, 'Internal Server Error');
  expect(extractHaErrorMessage(exc)).toBe(exc.message);
});

test('extract_ha_error_message falls back on no payload', () => {
  const exc = new HomeAssistantError('connection refused');
  expect(extractHaErrorMessage(exc)).toBe(exc.message);
});

// --- ask-mode regression tests ---

test('apply proceeds under ask mode with sensitive entity', async () => {
  const root = makeHaRoot({
    entity_index: {
      'alarm_control_panel.home': { entity_id: 'alarm_control_panel.home', state: 'armed_away' },
    },
  });
  writeFileSync(join(root, '.claude-code-hermit', 'config.json'), '{"ha_safety_mode": "ask"}');
  const artifact = writeArtifact(root, SENSITIVE_ALARM_YAML);
  const client = fakeClient({
    post: () => ({ result: 'valid' }),
    get: () => ({ alias: 'Disarm' }),
  });

  const result = await validateAndApply(root, client, artifact, 'automation');

  expect(result.ok).toBe(true);
  expect(client.calls.post).toContainEqual(['/api/services/automation/reload', {}]);
});
