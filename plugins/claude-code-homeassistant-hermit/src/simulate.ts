// WP7 tier 3 port of src/ha_agent_lab/simulate.py — YAML artifact simulation
// against the normalized entity inventory and the safety policy.
// (collectReferences landed in tier 2 for audits.ts; the rest is tier 3.)

import { existsSync, readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';

import { currentSessionId, slugify, standardMetadata, writeMarkdownArtifact } from './artifacts';
import { normalizedContextPath } from './config';
import { evaluateReferences, type PolicyDecision } from './policy';
import { parseYaml } from './yaml';

export class SimulationResult {
  constructor(
    readonly artifactPath: string,
    readonly referencedEntities: string[],
    readonly referencedServices: string[],
    readonly missingEntities: string[],
    readonly blockedReasons: string[],
    /** True only when severity == BLOCK (not ASK). */
    readonly policyBlocked: boolean,
  ) {}

  get isValid(): boolean {
    return this.missingEntities.length === 0 && !this.policyBlocked;
  }
}

// Python `yaml.safe_load(...) or {}`: any falsy parse result becomes {}.
function loadYamlOrEmpty(path: string): unknown {
  const data = parseYaml(readFileSync(path, 'utf8'));
  return data === null || data === undefined || data === false || data === 0 || data === ''
    ? {}
    : data;
}

/** Load a YAML file, extract references, and evaluate against safety policy. */
export function evaluateYamlPolicy(
  yamlPath: string,
  root?: string | null,
): [string[], string[], PolicyDecision] {
  const data = loadYamlOrEmpty(yamlPath);
  const [rawEntities, rawServices] = collectReferences(data);
  const entities = [...new Set(rawEntities)].sort();
  const services = [...new Set(rawServices)].sort();
  const decision = evaluateReferences(entities, services, root);
  return [entities, services, decision];
}

export function simulateArtifact(
  root: string,
  artifactPath: string,
  inventoryPath: string | null = null,
): SimulationResult {
  const data = loadYamlOrEmpty(artifactPath);
  const inventory = loadInventory(root, inventoryPath);
  const entityIndex: Record<string, unknown> = inventory.entity_index ?? {};
  const [rawEntities, rawServices] = collectReferences(data);
  const entities = [...new Set(rawEntities)].sort();
  const services = [...new Set(rawServices)].sort();
  const missingEntities = entities.filter((entityId) => !(entityId in entityIndex));
  const decision = evaluateReferences(entities, services, root);
  const result = new SimulationResult(
    artifactPath,
    entities,
    services,
    missingEntities,
    decision.reasons,
    decision.blocked,
  );
  writeSimulationReport(root, result);
  return result;
}

export function loadInventory(root: string, inventoryPath: string | null = null): Record<string, any> {
  const path = inventoryPath || normalizedContextPath(root);
  if (!existsSync(path)) {
    throw new Error(
      `Normalized inventory not found at ${path}. Run \`./bin/ha-agent-lab ha refresh-context\` first.`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** basename without the final extension (Python Path.stem). */
function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function writeSimulationReport(root: string, result: SimulationResult): string {
  const metadata = standardMetadata('simulation', `Simulation Report — ${basename(result.artifactPath)}`, {
    session: currentSessionId(root),
    tags: ['simulation', 'policy-check'],
    extra: {
      artifact_path: relative(root, result.artifactPath),
      valid: result.isValid,
      referenced_entities: result.referencedEntities,
      referenced_services: result.referencedServices,
      missing_entities: result.missingEntities,
      blocked_reasons: result.blockedReasons,
    },
  });
  const bodyLines = [
    `# Simulation Report for \`${basename(result.artifactPath)}\``,
    '',
    `- valid: ${result.isValid}`,
    `- referenced_entities: ${result.referencedEntities.length}`,
    `- referenced_services: ${result.referencedServices.length}`,
  ];
  if (result.missingEntities.length > 0) {
    bodyLines.push('', '## Missing Entities', ...result.missingEntities.map((item) => `- ${item}`));
  }
  if (result.blockedReasons.length > 0) {
    bodyLines.push('', '## Policy Reasons', ...result.blockedReasons.map((item) => `- ${item}`));
  }
  const slug = `audit-ha-simulation-${slugify(stem(result.artifactPath))}`;
  return writeMarkdownArtifact(
    root,
    '.claude-code-hermit/raw',
    slug,
    metadata,
    bodyLines.join('\n'),
    'audit-ha-simulation-latest.md',
  );
}

/** Walk a YAML tree once and return [entityIds, services]. */
export function collectReferences(value: unknown): [string[], string[]] {
  const entities: string[] = [];
  const services: string[] = [];
  walkReferences(value, entities, services);
  return [entities, services];
}

function pushEntityValue(child: unknown, entities: string[]): void {
  if (typeof child === 'string') {
    entities.push(...child.split(',').map((part) => part.trim()).filter(Boolean));
  } else if (Array.isArray(child)) {
    entities.push(...child.filter((item): item is string => typeof item === 'string'));
  }
}

function walkReferences(value: unknown, entities: string[], services: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walkReferences(item, entities, services);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'entity_id') {
        pushEntityValue(child, entities);
      } else if (key === 'target' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        pushEntityValue((child as Record<string, unknown>).entity_id, entities);
      }
      if (key === 'service' && typeof child === 'string') services.push(child);
      walkReferences(child, entities, services);
    }
  }
}
