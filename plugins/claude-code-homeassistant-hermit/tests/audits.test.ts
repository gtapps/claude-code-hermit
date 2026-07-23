// WP7 tier 2: tests for src/audits.ts — 1:1 port of tests/test_audits.py
// (14 cases).
//
// pytest fixture mapping: tmp_path -> mkdtempSync; FakeClient stays a class
// (async get, sync-raising via rejected promise); `_load_acknowledged` ->
// exported loadAcknowledged.

import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditAutomations, auditScripts, loadAcknowledged, type AuditClient } from '../src/audits';
import { HomeAssistantError } from '../src/ha-api';

const tmpDirs: string[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ha-audits-test-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.claude-code-hermit', 'raw'), { recursive: true });
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeClient implements AuditClient {
  readonly calls: string[] = [];

  constructor(private readonly responses: Record<string, any>) {}

  async get(path: string): Promise<any> {
    this.calls.push(path);
    if (!(path in this.responses)) throw new Error(`unexpected path: ${path}`);
    const value = this.responses[path];
    if (value instanceof Error) throw value;
    return value;
  }

  getStates(): Promise<Array<Record<string, any>>> {
    return this.get('/api/states');
  }
}

function makeState(entityId: string, configId: string | null): Record<string, any> {
  const attrs = configId !== null ? { id: configId } : {};
  return { entity_id: entityId, state: 'on', attributes: attrs };
}

function writeAcknowledged(tmp: string, frontmatter: string): void {
  const compiled = join(tmp, '.claude-code-hermit', 'compiled');
  mkdirSync(compiled, { recursive: true });
  writeFileSync(join(compiled, 'acknowledged-violations.md'), frontmatter, 'utf8');
}

// ---------------------------------------------------------------------------
// auditAutomations
// ---------------------------------------------------------------------------

test('audit_automations flags sensitive references', async () => {
  const tmp = tmpPath();
  const configs: Record<string, any> = {
    safe_kitchen: {
      id: 'safe_kitchen',
      alias: 'Kitchen motion light',
      trigger: [{ platform: 'state', entity_id: 'binary_sensor.kitchen_motion' }],
      action: [{ service: 'light.turn_on', target: { entity_id: 'light.kitchen' } }],
    },
    garage_auto_close: {
      id: 'garage_auto_close',
      alias: 'Lock at night',
      trigger: [{ platform: 'time', at: '23:00:00' }],
      action: [{ service: 'lock.lock', target: { entity_id: 'lock.front_door' } }],
    },
  };
  const states = [
    makeState('automation.safe_kitchen', 'safe_kitchen'),
    makeState('automation.garage_auto_close', 'garage_auto_close'),
  ];
  const client = new FakeClient({
    '/api/states': states,
    '/api/config/automation/config/safe_kitchen': configs.safe_kitchen,
    '/api/config/automation/config/garage_auto_close': configs.garage_auto_close,
  });

  const summary = await auditAutomations(tmp, client);

  expect(summary.total_automations).toBe(2);
  expect(summary.passed).toBe(1);
  expect(summary.violations.length).toBe(1);
  expect(summary.acknowledged).toEqual([]);
  expect(summary.unmanaged).toEqual([]);
  expect(summary.fetch_failures).toEqual([]);
  const violation = summary.violations[0];
  expect(violation.id).toBe('garage_auto_close');
  expect(violation.reasons.some((r: string) => r.includes('lock'))).toBe(true);

  const latest = join(tmp, '.claude-code-hermit', 'raw', 'audit-ha-safety-latest.json');
  expect(existsSync(latest)).toBe(true);
  const persisted = JSON.parse(readFileSync(latest, 'utf8'));
  expect(persisted.violations).toEqual(summary.violations);
});

test('audit_automations no violations', async () => {
  const tmp = tmpPath();
  const config = {
    id: 'bedtime_dim',
    alias: 'Dim bedroom at bedtime',
    action: [{ service: 'light.turn_on', target: { entity_id: 'light.bedroom' } }],
  };
  const states = [makeState('automation.bedtime_dim', 'bedtime_dim')];
  const client = new FakeClient({
    '/api/states': states,
    '/api/config/automation/config/bedtime_dim': config,
  });

  const summary = await auditAutomations(tmp, client);

  expect(summary.total_automations).toBe(1);
  expect(summary.violations).toEqual([]);
  expect(summary.acknowledged).toEqual([]);
  expect(summary.passed).toBe(1);
  expect(summary.unmanaged).toEqual([]);
  expect(summary.fetch_failures).toEqual([]);
});

test('audit_automations handles unmanaged and fetch failures', async () => {
  const tmp = tmpPath();
  const states = [
    makeState('automation.yaml_only', null), // no numeric id — unmanaged
    makeState('automation.missing_config', '999'), // 404 on config fetch
  ];
  const client = new FakeClient({
    '/api/states': states,
    '/api/config/automation/config/999': new HomeAssistantError('not found', 404),
  });

  const summary = await auditAutomations(tmp, client);

  expect(summary.total_automations).toBe(2);
  expect(summary.unmanaged).toEqual(['automation.yaml_only']);
  expect(summary.fetch_failures).toEqual(['999']);
  expect(summary.violations).toEqual([]);
  expect(summary.acknowledged).toEqual([]);
  // invariant: passed + violations + acknowledged + unmanaged + fetch_failures == total
  const total = summary.total_automations;
  expect(
    summary.passed +
      summary.violations.length +
      summary.acknowledged.length +
      summary.unmanaged.length +
      summary.fetch_failures.length,
  ).toBe(total);
});

test('audit_automations propagates unexpected errors', async () => {
  const tmp = tmpPath();
  const states = [makeState('automation.broken', 'broken_id')];
  const client = new FakeClient({
    '/api/states': states,
    '/api/config/automation/config/broken_id': new HomeAssistantError('server error', 500),
  });

  try {
    await auditAutomations(tmp, client);
    expect.unreachable('expected HomeAssistantError');
  } catch (exc) {
    expect(exc).toBeInstanceOf(HomeAssistantError);
    expect((exc as HomeAssistantError).statusCode).toBe(500);
  }
});

test('audit_automations moves acknowledged to acknowledged bucket', async () => {
  const tmp = tmpPath();
  writeAcknowledged(tmp, '---\nautomation_ids: [garage_auto_close]\nscript_ids: []\n---\n');

  const states = [
    makeState('automation.safe_kitchen', 'safe_kitchen'),
    makeState('automation.garage_auto_close', 'garage_auto_close'),
  ];
  const client = new FakeClient({
    '/api/states': states,
    '/api/config/automation/config/safe_kitchen': {
      id: 'safe_kitchen',
      action: [{ service: 'light.turn_on', target: { entity_id: 'light.kitchen' } }],
    },
    '/api/config/automation/config/garage_auto_close': {
      id: 'garage_auto_close',
      alias: 'Lock at night',
      action: [{ service: 'lock.lock', target: { entity_id: 'lock.front_door' } }],
    },
  });

  const summary = await auditAutomations(tmp, client);

  expect(summary.violations).toEqual([]);
  expect(summary.acknowledged.length).toBe(1);
  expect(summary.acknowledged[0].id).toBe('garage_auto_close');
  expect(summary.passed).toBe(1);
});

// ---------------------------------------------------------------------------
// auditScripts
// ---------------------------------------------------------------------------

test('audit_scripts flags sensitive references', async () => {
  const tmp = tmpPath();
  const configs: Record<string, any> = {
    safe_lights: {
      id: 'safe_lights',
      alias: 'Turn off lights',
      sequence: [{ service: 'light.turn_off', target: { entity_id: 'light.living_room' } }],
    },
    unlock_front: {
      id: 'unlock_front',
      alias: 'Unlock front door',
      sequence: [{ service: 'lock.unlock', target: { entity_id: 'lock.front_door' } }],
    },
  };
  const states = [
    makeState('script.safe_lights', 'safe_lights'),
    makeState('script.unlock_front', 'unlock_front'),
  ];
  const client = new FakeClient({
    '/api/states': states,
    '/api/config/script/config/safe_lights': configs.safe_lights,
    '/api/config/script/config/unlock_front': configs.unlock_front,
  });

  const summary = await auditScripts(tmp, client);

  expect(summary.total_scripts).toBe(2);
  expect(summary.passed).toBe(1);
  expect(summary.violations.length).toBe(1);
  expect(summary.acknowledged).toEqual([]);
  expect(summary.unmanaged).toEqual([]);
  expect(summary.fetch_failures).toEqual([]);
  const violation = summary.violations[0];
  expect(violation.id).toBe('unlock_front');
  expect(
    violation.reasons.some((r: string) => r.includes('front_door') || r.includes('lock')),
  ).toBe(true);

  const latest = join(tmp, '.claude-code-hermit', 'raw', 'audit-ha-script-safety-latest.json');
  expect(existsSync(latest)).toBe(true);
  const persisted = JSON.parse(readFileSync(latest, 'utf8'));
  expect(persisted.violations).toEqual(summary.violations);
});

test('audit_scripts no violations', async () => {
  const tmp = tmpPath();
  const config = {
    id: 'morning_lights',
    alias: 'Morning lights on',
    sequence: [{ service: 'light.turn_on', target: { entity_id: 'light.kitchen' } }],
  };
  const states = [makeState('script.morning_lights', 'morning_lights')];
  const client = new FakeClient({
    '/api/states': states,
    '/api/config/script/config/morning_lights': config,
  });

  const summary = await auditScripts(tmp, client);

  expect(summary.total_scripts).toBe(1);
  expect(summary.violations).toEqual([]);
  expect(summary.acknowledged).toEqual([]);
  expect(summary.passed).toBe(1);
  expect(summary.unmanaged).toEqual([]);
  expect(summary.fetch_failures).toEqual([]);
});

test('audit_scripts handles unmanaged and fetch failures', async () => {
  const tmp = tmpPath();
  const states = [
    makeState('script.yaml_only', null),
    makeState('script.missing_config', 'ghost_script'),
  ];
  const client = new FakeClient({
    '/api/states': states,
    '/api/config/script/config/ghost_script': new HomeAssistantError('not found', 404),
  });

  const summary = await auditScripts(tmp, client);

  expect(summary.total_scripts).toBe(2);
  expect(summary.unmanaged).toEqual(['script.yaml_only']);
  expect(summary.fetch_failures).toEqual(['ghost_script']);
  expect(summary.violations).toEqual([]);
  expect(summary.acknowledged).toEqual([]);
  const total = summary.total_scripts;
  expect(
    summary.passed +
      summary.violations.length +
      summary.acknowledged.length +
      summary.unmanaged.length +
      summary.fetch_failures.length,
  ).toBe(total);
});

test('audit_scripts propagates unexpected errors', async () => {
  const tmp = tmpPath();
  const states = [makeState('script.broken', 'broken_script')];
  const client = new FakeClient({
    '/api/states': states,
    '/api/config/script/config/broken_script': new HomeAssistantError('server error', 500),
  });

  try {
    await auditScripts(tmp, client);
    expect.unreachable('expected HomeAssistantError');
  } catch (exc) {
    expect(exc).toBeInstanceOf(HomeAssistantError);
    expect((exc as HomeAssistantError).statusCode).toBe(500);
  }
});

test('audit_scripts moves acknowledged to acknowledged bucket', async () => {
  const tmp = tmpPath();
  writeAcknowledged(tmp, '---\nautomation_ids: []\nscript_ids: [unlock_front]\n---\n');

  const states = [
    makeState('script.safe_lights', 'safe_lights'),
    makeState('script.unlock_front', 'unlock_front'),
  ];
  const client = new FakeClient({
    '/api/states': states,
    '/api/config/script/config/safe_lights': {
      id: 'safe_lights',
      sequence: [{ service: 'light.turn_off', target: { entity_id: 'light.living_room' } }],
    },
    '/api/config/script/config/unlock_front': {
      id: 'unlock_front',
      alias: 'Unlock front door',
      sequence: [{ service: 'lock.unlock', target: { entity_id: 'lock.front_door' } }],
    },
  });

  const summary = await auditScripts(tmp, client);

  expect(summary.violations).toEqual([]);
  expect(summary.acknowledged.length).toBe(1);
  expect(summary.acknowledged[0].id).toBe('unlock_front');
  expect(summary.passed).toBe(1);
});

// ---------------------------------------------------------------------------
// loadAcknowledged
// ---------------------------------------------------------------------------

test('load_acknowledged empty when file missing', () => {
  const result = loadAcknowledged(tmpPath());
  expect(result).toEqual({ automation: new Set(), script: new Set() });
});

test('load_acknowledged reads automation and script ids', () => {
  const tmp = tmpPath();
  writeAcknowledged(
    tmp,
    '---\nautomation_ids: [garage_auto_close, morning_routine]\nscript_ids: [unlock_front]\n---\n\nbody text\n',
  );

  const result = loadAcknowledged(tmp);

  expect(result.automation).toEqual(new Set(['garage_auto_close', 'morning_routine']));
  expect(result.script).toEqual(new Set(['unlock_front']));
});

test('load_acknowledged tolerates empty lists', () => {
  const tmp = tmpPath();
  writeAcknowledged(tmp, '---\nautomation_ids: []\nscript_ids: []\n---\n');

  const result = loadAcknowledged(tmp);

  expect(result.automation).toEqual(new Set());
  expect(result.script).toEqual(new Set());
});

test('load_acknowledged tolerates missing fields', () => {
  const tmp = tmpPath();
  writeAcknowledged(tmp, '---\ntitle: Acknowledged\n---\n');

  const result = loadAcknowledged(tmp);

  expect(result.automation).toEqual(new Set());
  expect(result.script).toEqual(new Set());
});
