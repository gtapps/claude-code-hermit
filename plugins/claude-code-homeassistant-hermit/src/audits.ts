// WP7 tier 2 port of src/ha_agent_lab/audits.py — safety audits over
// REST-managed automations and scripts.
//
// Async note: audit functions are async (the client is fetch-based). The
// Python ThreadPoolExecutor(max_workers=min(20, total)) becomes a 20-wide
// async worker pool; results land in input order (Python's as_completed
// order was arbitrary, so ordering was never part of the contract).

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { currentSessionId, standardMetadata, writeJsonArtifact, writeMarkdownArtifact } from './artifacts';
import { HomeAssistantError } from './ha-api';
import { loadFrontmatter } from './markdown';
import { evaluateReferences } from './policy';
import { collectReferences } from './simulate';

/** The slice of HomeAssistantClient the audits need (tests inject a fake). */
export interface AuditClient {
  get(path: string): Promise<any>;
  getStates(): Promise<Array<Record<string, any>>>;
}

// Python-private `_load_acknowledged`, exported for tests (the pytest file
// imports it directly).
export function loadAcknowledged(root: string): { automation: Set<string>; script: Set<string> } {
  const path = join(root, '.claude-code-hermit', 'compiled', 'acknowledged-violations.md');
  const empty = { automation: new Set<string>(), script: new Set<string>() };
  if (!existsSync(path)) return empty;
  let data: Record<string, unknown>;
  try {
    [data] = loadFrontmatter(path);
  } catch (exc) {
    console.error(
      `Warning: acknowledged-violations.md has malformed frontmatter (${exc}) — violations not suppressed.`,
    );
    return empty;
  }
  return {
    automation: new Set((data.automation_ids as string[]) || []),
    script: new Set((data.script_ids as string[]) || []),
  };
}

type FetchKind = 'ok' | 'unmanaged' | 'failure';

/** Fetch one domain config. Returns [kind, value] where kind is 'ok'|'unmanaged'|'failure'. */
async function fetchConfig(
  client: AuditClient,
  domain: string,
  state: Record<string, any>,
): Promise<[FetchKind, any]> {
  const configId = (state.attributes || {}).id;
  if (!configId) return ['unmanaged', state.entity_id];
  try {
    const config = await client.get(`/api/config/${domain}/config/${configId}`);
    return ['ok', config];
  } catch (exc) {
    if (exc instanceof HomeAssistantError && exc.statusCode === 404) {
      return ['failure', String(configId)];
    }
    throw exc;
  }
}

async function runAudit(
  domain: string,
  root: string,
  client: AuditClient,
  artifactSlug: string,
): Promise<Record<string, any>> {
  const allStates = await client.getStates();
  const domainStates = allStates.filter(
    (s) => s !== null && typeof s === 'object' && (s.entity_id ?? '').startsWith(`${domain}.`),
  );
  const total = domainStates.length;
  const acknowledgedIds =
    loadAcknowledged(root)[domain as 'automation' | 'script'] ?? new Set<string>();

  const unmanaged: string[] = [];
  const fetchFailures: string[] = [];
  const items: Array<Record<string, any>> = [];

  // ThreadPoolExecutor(max_workers=min(20, total)) equivalent.
  const maxWorkers = total ? Math.min(20, total) : 1;
  const outcomes: Array<[FetchKind, any]> = new Array(total);
  let next = 0;
  const workers = Array.from({ length: maxWorkers }, async () => {
    while (next < domainStates.length) {
      const i = next++;
      outcomes[i] = await fetchConfig(client, domain, domainStates[i]!);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed) throw failed.reason;

  for (const [kind, value] of outcomes) {
    if (kind === 'unmanaged') unmanaged.push(value);
    else if (kind === 'failure') fetchFailures.push(value);
    else if (value !== null && typeof value === 'object' && !Array.isArray(value)) items.push(value);
  }

  const violations: Array<Record<string, any>> = [];
  const acknowledged: Array<Record<string, any>> = [];
  for (const item of items) {
    const [entities, services] = collectReferences(item);
    const decision = evaluateReferences(
      [...new Set(entities)].sort(),
      [...new Set(services)].sort(),
      root,
    );
    if (decision.blocked) {
      const record = {
        id: item.id ?? null,
        alias: item.alias || item.id || '(unnamed)',
        reasons: decision.reasons,
      };
      if (acknowledgedIds.has(record.id)) acknowledged.push(record);
      else violations.push(record);
    }
  }

  const passed =
    total - violations.length - acknowledged.length - unmanaged.length - fetchFailures.length;
  const summary: Record<string, any> = {
    [`total_${domain}s`]: total,
    violations,
    acknowledged,
    passed,
    unmanaged,
    fetch_failures: fetchFailures,
  };

  writeJsonArtifact(root, '.claude-code-hermit/raw', artifactSlug, summary, `${artifactSlug}-latest.json`);

  const bodyLines = [
    `# HA Safety Audit (${domain}s)`,
    '',
    `- total ${domain}s: ${total}`,
    `- passed: ${passed}`,
    `- violations: ${violations.length}`,
  ];
  if (acknowledged.length > 0) bodyLines.push(`- acknowledged: ${acknowledged.length}`);
  if (unmanaged.length > 0) bodyLines.push(`- unmanaged (no id, skipped): ${unmanaged.length}`);
  if (fetchFailures.length > 0) {
    bodyLines.push(`- fetch failures (404, skipped): ${fetchFailures.length}`);
  }
  if (violations.length > 0) {
    bodyLines.push('', '## Violations');
    for (const v of violations) {
      bodyLines.push(`- **${v.alias}** (\`${v.id}\`)`);
      for (const reason of v.reasons) bodyLines.push(`  - ${reason}`);
    }
  }
  if (acknowledged.length > 0) {
    bodyLines.push('', '## Acknowledged');
    for (const a of acknowledged) {
      bodyLines.push(`- **${a.alias}** (\`${a.id}\`)`);
      for (const reason of a.reasons) bodyLines.push(`  - ${reason}`);
    }
  }

  writeMarkdownArtifact(
    root,
    '.claude-code-hermit/raw',
    artifactSlug,
    standardMetadata('audit', `HA Safety Audit (${domain}s)`, {
      session: currentSessionId(root),
      tags: ['ha-safety', 'audit', 'policy-drift'],
      extra: {
        source: 'scheduled-check',
        [`total_${domain}s`]: total,
        violations: violations.length,
        acknowledged: acknowledged.length,
      },
    }),
    bodyLines.join('\n'),
    `${artifactSlug}-latest.md`,
  );
  return summary;
}

export function auditAutomations(root: string, client: AuditClient): Promise<Record<string, any>> {
  return runAudit('automation', root, client, 'audit-ha-safety');
}

export function auditScripts(root: string, client: AuditClient): Promise<Record<string, any>> {
  return runAudit('script', root, client, 'audit-ha-script-safety');
}
