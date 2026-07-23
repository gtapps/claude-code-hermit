// Tests for ha-automation-diff (issue #472, skill B).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, expect, test } from 'bun:test';

import {
  automationDiff,
  computeAutomationDiff,
  formatAutomationDiff,
  type AutomationSnapshot,
} from '../src/automation-diff';
import { cleanupTmp, fakeClient, tmpPath } from './helpers';

afterAll(cleanupTmp);

function snap(
  automations: AutomationSnapshot['automations'],
  untracked: AutomationSnapshot['untracked'] = [],
): AutomationSnapshot {
  return { generated: 'x', automations, untracked };
}

const entry = (entity_id: string, state: string, hash: string, friendly_name: string | null = null) => ({
  entity_id,
  state,
  hash,
  friendly_name,
});

test('first run with no prior is a baseline', () => {
  const current = snap({ a: entry('automation.a', 'on', 'h1') });
  const r = computeAutomationDiff(null, current);
  expect(r.baseline).toBe(true);
  expect(r.tracked).toBe(1);
  expect(r.added).toHaveLength(0);
});

test('detects added, removed, edited, enabled, disabled', () => {
  const prior = snap({
    keep: entry('automation.keep', 'on', 'same'),
    edited: entry('automation.edited', 'on', 'old'),
    gone: entry('automation.gone', 'on', 'g'),
    turnoff: entry('automation.turnoff', 'on', 't'),
    turnon: entry('automation.turnon', 'off', 't'),
  });
  const current = snap({
    keep: entry('automation.keep', 'on', 'same'),
    edited: entry('automation.edited', 'on', 'new'),
    fresh: entry('automation.fresh', 'on', 'f'),
    turnoff: entry('automation.turnoff', 'off', 't'),
    turnon: entry('automation.turnon', 'on', 't'),
  });
  const r = computeAutomationDiff(prior, current);
  expect(r.added.map((i) => i.id)).toEqual(['fresh']);
  expect(r.removed.map((i) => i.id)).toEqual(['gone']);
  expect(r.edited.map((i) => i.id)).toEqual(['edited']);
  expect(r.disabled.map((i) => i.id)).toEqual(['turnoff']);
  expect(r.enabled.map((i) => i.id)).toEqual(['turnon']);
});

test('formatAutomationDiff reports no changes when stable', () => {
  const s = snap({ a: entry('automation.a', 'on', 'h1') });
  const out = formatAutomationDiff(computeAutomationDiff(s, s));
  expect(out).toContain('No changes since last snapshot. (1 automations tracked)');
});

test('orchestrator writes baseline then detects an edit on the next run', async () => {
  const root = tmpPath();
  const states = [
    { entity_id: 'automation.morning', state: 'on', attributes: { id: 'morning', friendly_name: 'Morning' } },
    { entity_id: 'automation.legacy', state: 'on', attributes: { friendly_name: 'Legacy YAML' } },
  ];
  const configs: Record<string, any> = { morning: { id: 'morning', alias: 'Morning', trigger: [], action: [] } };
  const client = fakeClient({
    get: (path) => {
      if (path === '/api/states') return states;
      const m = path.match(/^\/api\/config\/automation\/config\/(.+)$/);
      if (m) return configs[m[1]!];
      return {};
    },
  });

  const first = await automationDiff(root, client);
  expect(first.baseline).toBe(true);
  expect(first.tracked).toBe(1);
  expect(first.untracked).toHaveLength(1); // legacy YAML automation, no id
  expect(existsSync(join(root, '.claude-code-hermit/raw/snapshot-ha-automations-latest.json'))).toBe(true);

  // Edit the stored config; the next run must flag it as edited.
  configs.morning = { id: 'morning', alias: 'Morning', trigger: [{ platform: 'time' }], action: [] };
  const second = await automationDiff(root, client);
  expect(second.baseline).toBe(false);
  expect(second.edited.map((i) => i.id)).toEqual(['morning']);

  const latest = JSON.parse(
    readFileSync(join(root, '.claude-code-hermit/raw/snapshot-ha-automations-latest.json'), 'utf8'),
  );
  expect(Object.keys(latest.automations)).toEqual(['morning']);
});
