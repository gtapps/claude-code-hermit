// ha-automation-diff (issue #472, skill B): change memory across sessions.
//
// ha-safety-audit catches POLICY drift at a point in time; this catches CHANGE
// drift — which automations were added / removed / edited / enabled / disabled
// since the last snapshot, including UI edits that bypass ha-build-automation.
//
// Read-only against HA: enumerate automations via /api/states, fetch each
// stored config via readConfig, hash the config, and diff against the prior
// snapshot at raw/snapshot-ha-automations-latest.json (the *-latest.json
// convention history.ts already uses).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readConfig, type ApplyClient } from './apply';
import {
  currentSessionId,
  sortKeysDeep,
  standardMetadata,
  utcTimestamp,
  writeJsonArtifact,
  writeMarkdownArtifact,
} from './artifacts';

const LATEST_NAME = 'snapshot-ha-automations-latest.json';

export interface AutomationEntry {
  entity_id: string;
  friendly_name: string | null;
  state: string | null;
  hash: string;
}

// `type` (not `interface`) so it carries an implicit index signature and stays
// assignable to writeJsonArtifact's `Record<string, unknown>` payload param.
export type AutomationSnapshot = {
  generated: string;
  /** Keyed by config id (the REST-addressable automation id). */
  automations: Record<string, AutomationEntry>;
  /** Automations with no numeric id — not REST-retrievable, config not tracked. */
  untracked: Array<{ entity_id: string; friendly_name: string | null; state: string | null }>;
}

export interface ChangeItem {
  id: string;
  entity_id: string;
  friendly_name: string | null;
}

export interface AutomationDiffResult {
  baseline: boolean;
  tracked: number;
  added: ChangeItem[];
  removed: ChangeItem[];
  edited: ChangeItem[];
  enabled: ChangeItem[];
  disabled: ChangeItem[];
  untracked: AutomationSnapshot['untracked'];
}

// Hash the key-sorted config so the digest is stable regardless of HA key order.
// Used only for self-comparison across runs, so the exact serialization is moot.
function hashConfig(config: Record<string, any>): string {
  return createHash('sha256').update(JSON.stringify(sortKeysDeep(config))).digest('hex');
}

function entry(snapshot: AutomationSnapshot, id: string): ChangeItem {
  const a = snapshot.automations[id]!;
  return { id, entity_id: a.entity_id, friendly_name: a.friendly_name };
}

/** Pure diff of two snapshots. enabled/disabled (state flip) and edited (config
 * hash change) are orthogonal — an automation can appear in both. */
export function computeAutomationDiff(
  prior: AutomationSnapshot | null,
  current: AutomationSnapshot,
): AutomationDiffResult {
  const base: AutomationDiffResult = {
    baseline: prior === null,
    tracked: Object.keys(current.automations).length,
    added: [],
    removed: [],
    edited: [],
    enabled: [],
    disabled: [],
    untracked: current.untracked,
  };
  if (prior === null) return base;

  const priorIds = new Set(Object.keys(prior.automations));
  const currentIds = new Set(Object.keys(current.automations));

  for (const id of [...currentIds].sort()) {
    if (!priorIds.has(id)) {
      base.added.push(entry(current, id));
      continue;
    }
    const before = prior.automations[id]!;
    const after = current.automations[id]!;
    if (before.hash !== after.hash) base.edited.push(entry(current, id));
    if (before.state === 'on' && after.state === 'off') base.disabled.push(entry(current, id));
    if (before.state === 'off' && after.state === 'on') base.enabled.push(entry(current, id));
  }
  for (const id of [...priorIds].sort()) {
    if (!currentIds.has(id)) {
      const a = prior.automations[id]!;
      base.removed.push({ id, entity_id: a.entity_id, friendly_name: a.friendly_name });
    }
  }
  return base;
}

/** Enumerate live automations and build the current snapshot. */
async function buildSnapshot(client: ApplyClient): Promise<AutomationSnapshot> {
  const states: Array<Record<string, any>> = await client.get('/api/states');
  const automations: Record<string, AutomationEntry> = {};
  const untracked: AutomationSnapshot['untracked'] = [];
  const tracked: Array<Omit<AutomationEntry, 'hash'> & { configId: string }> = [];

  for (const s of states) {
    if (!(s && typeof s === 'object' && String(s.entity_id ?? '').startsWith('automation.'))) {
      continue;
    }
    const attrs = s.attributes || {};
    const friendlyName = attrs.friendly_name ?? null;
    const state = s.state ?? null;
    const configId = attrs.id;
    if (configId === null || configId === undefined) {
      untracked.push({ entity_id: s.entity_id, friendly_name: friendlyName, state });
      continue;
    }
    tracked.push({ configId: String(configId), entity_id: s.entity_id, friendly_name: friendlyName, state });
  }

  // Config fetches are independent — run concurrently.
  await Promise.all(
    tracked.map(async (t) => {
      const read = await readConfig(client, 'automation', t.configId);
      automations[t.configId] = {
        entity_id: t.entity_id,
        friendly_name: t.friendly_name,
        state: t.state,
        // A failed config fetch still records the entity; hash of "" flags it as
        // edited next run if the fetch later succeeds, never silently dropped.
        hash: read.ok ? hashConfig(read.config) : '',
      };
    }),
  );

  untracked.sort((a, b) => (a.entity_id < b.entity_id ? -1 : 1));
  return { generated: utcTimestamp(), automations, untracked };
}

function readPriorSnapshot(root: string): AutomationSnapshot | null {
  const path = join(root, '.claude-code-hermit', 'raw', LATEST_NAME);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AutomationSnapshot;
  } catch {
    return null;
  }
}

/** Orchestrator: enumerate, diff against prior, persist the new snapshot + a
 * markdown findings artifact. Returns the diff for stdout formatting. */
export async function automationDiff(
  root: string,
  client: ApplyClient,
): Promise<AutomationDiffResult> {
  const prior = readPriorSnapshot(root);
  const current = await buildSnapshot(client);
  const result = computeAutomationDiff(prior, current);

  writeJsonArtifact(root, '.claude-code-hermit/raw', 'snapshot-ha-automations', current, LATEST_NAME);

  writeMarkdownArtifact(
    root,
    '.claude-code-hermit/raw',
    'audit-ha-automation-diff',
    standardMetadata('audit', 'HA Automation Diff', {
      session: currentSessionId(root),
      tags: ['ha-automation-diff', 'change-memory'],
      extra: { baseline: result.baseline, tracked: result.tracked, changes: sumChanges(result) },
    }),
    formatAutomationDiff(result),
    'audit-ha-automation-diff-latest.md',
  );
  return result;
}

function sumChanges(result: AutomationDiffResult): number {
  return (
    result.added.length +
    result.removed.length +
    result.edited.length +
    result.enabled.length +
    result.disabled.length
  );
}

function line(prefix: string, item: ChangeItem): string {
  const name = item.friendly_name ?? item.entity_id;
  return `- ${prefix}: ${name} (\`${item.id}\`)`;
}

/** stdout findings block, mirroring ha-safety-audit's shape. */
export function formatAutomationDiff(result: AutomationDiffResult): string {
  const today = new Date().toISOString().slice(0, 10);
  const header = `ha-automation-diff findings — ${today}`;
  if (result.baseline) {
    return `${header}\nBaseline established. (${result.tracked} automations tracked)`;
  }

  const changeCount = sumChanges(result);

  const lines = [header];
  if (changeCount === 0) {
    lines.push(`No changes since last snapshot. (${result.tracked} automations tracked)`);
  } else {
    lines.push(`Changes since last snapshot: ${changeCount}`);
    for (const i of result.added) lines.push(line('added', i));
    for (const i of result.removed) lines.push(line('removed', i));
    for (const i of result.edited) lines.push(line('edited', i));
    for (const i of result.disabled) lines.push(line('disabled', i));
    for (const i of result.enabled) lines.push(line('enabled', i));
  }
  if (result.untracked.length > 0) {
    lines.push(`Untracked (YAML-packaged, config not diffable): ${result.untracked.length}`);
  }
  return lines.join('\n');
}
