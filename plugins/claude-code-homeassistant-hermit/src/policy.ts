// WP7 tier 1 port of src/ha_agent_lab/policy.py.
//
// Python-isms mapped:
//   - functools.lru_cache(root) -> module-level Maps keyed by resolved root;
//     clearPolicyCaches() replaces the test-facing `.cache_clear()` hooks.
//   - Severity(str, Enum) -> const object of string literals (JSON-compatible
//     values, same "block"/"ask"/"allow" wire format).
//   - dataclass PolicyDecision -> interface.
//   - check_entity keeps its snake_case JSON keys (CLI output contract).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadEnvFile } from './config';

export const SENSITIVE_DOMAINS = new Set(['lock', 'alarm_control_panel']);

export const CONDITIONALLY_SENSITIVE_DOMAINS = new Set(['cover', 'button', 'switch']);

export const SENSITIVE_KEYWORDS = new Set([
  'garage',
  'gate',
  'door',
  'alarm',
  'lock',
  'security',
  'shutter',
  'entry',
  'access',
]);

export const SAFE_RELOAD_DOMAINS = new Set(['automation', 'script']);

// Read-only MCP tools on the `homeassistant` server. The safety gate matches the
// whole `mcp__homeassistant__.*` namespace (default-deny chokepoint), so these
// query tools — which carry no entity_id and would otherwise hit the fail-closed
// branch and be blocked — must be short-circuited to allow. Explicit names, NOT a
// `*Get*` pattern: a permissive regex could silently grant a future mutating tool
// whose name happens to contain "Get". Extend this set against the live server's
// tool inventory if it exposes more read-only tools.
export const READ_ONLY_TOOLS = new Set(['GetLiveContext', 'GetDateTime']);

const MCP_TOOL_PREFIX = 'mcp__homeassistant__';

/** True if `toolName` is a known read-only tool on the homeassistant MCP server. */
export function isReadOnlyTool(toolName: string): boolean {
  const bare = toolName.startsWith(MCP_TOOL_PREFIX)
    ? toolName.slice(MCP_TOOL_PREFIX.length)
    : toolName;
  return READ_ONLY_TOOLS.has(bare);
}

export const Severity = {
  BLOCK: 'block',
  ASK: 'ask',
  ALLOW: 'allow', // sentinel for non-sensitive entities; no ha_safety_mode maps to it
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

const MODE_TO_SEVERITY: Record<string, Severity> = {
  strict: Severity.BLOCK,
  ask: Severity.ASK,
};

const SEVERITY_ORDER: Record<Severity, number> = {
  [Severity.ALLOW]: 0,
  [Severity.ASK]: 1,
  [Severity.BLOCK]: 2,
};

interface PolicyOverrides {
  safeEntities: Set<string>;
  extraDomains: Set<string>;
  extraKeywords: Set<string>;
}

const overridesCache = new Map<string, PolicyOverrides>();
const safetyModeCache = new Map<string, string>();

/** Test hook — replaces Python's `_load_policy_overrides.cache_clear()` etc. */
export function clearPolicyCaches(): void {
  overridesCache.clear();
  safetyModeCache.clear();
}

function loadPolicyOverrides(root: string): PolicyOverrides {
  const cached = overridesCache.get(root);
  if (cached) return cached;
  const env = loadEnvFile(root);
  const set = (name: string): Set<string> =>
    new Set(
      (env[name] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );
  const overrides: PolicyOverrides = {
    safeEntities: set('HA_SAFE_ENTITIES'),
    extraDomains: set('HA_EXTRA_SENSITIVE_DOMAINS'),
    extraKeywords: set('HA_EXTRA_SENSITIVE_KEYWORDS'),
  };
  overridesCache.set(root, overrides);
  return overrides;
}

function loadSafetyMode(root: string): string {
  const cached = safetyModeCache.get(root);
  if (cached !== undefined) return cached;
  let mode = 'strict';
  try {
    const cfg = JSON.parse(readFileSync(join(root, '.claude-code-hermit', 'config.json'), 'utf8'));
    const value = cfg?.ha_safety_mode ?? 'strict';
    mode = typeof value === 'string' && Object.hasOwn(MODE_TO_SEVERITY, value) ? value : 'strict';
  } catch {
    mode = 'strict';
  }
  safetyModeCache.set(root, mode);
  return mode;
}

/** Read ha_safety_mode from .claude-code-hermit/config.json. Fail-closed: returns 'strict'. */
export function safetyMode(root?: string | null): string {
  return loadSafetyMode(resolve(root ?? process.cwd()));
}

export interface PolicyDecision {
  severity: Severity;
  blocked: boolean;
  reasons: string[];
}

/** Return [Severity, reasons] for a single entity. */
export function classifyEntity(entityId: string, root?: string | null): [Severity, string[]] {
  const resolved = resolve(root ?? process.cwd());
  const overrides = loadPolicyOverrides(resolved);
  if (overrides.safeEntities.has(entityId)) return [Severity.ALLOW, []];
  // Match the domain case-insensitively: HA entity_ids are lowercase, but a
  // call carrying `LOCK.front_door` must not slip past the sensitive-domain
  // check (the keyword branch already lowercases). Closes a real bypass.
  const domain = entityId.split('.', 1)[0]!.toLowerCase();
  const modeSev = MODE_TO_SEVERITY[loadSafetyMode(resolved)]!;
  if (SENSITIVE_DOMAINS.has(domain) || overrides.extraDomains.has(domain)) {
    return [modeSev, [`Domain '${domain}' is always sensitive`]];
  }
  if (CONDITIONALLY_SENSITIVE_DOMAINS.has(domain)) {
    const lower = entityId.toLowerCase();
    const matched = [...SENSITIVE_KEYWORDS, ...overrides.extraKeywords].filter((kw) =>
      lower.includes(kw),
    );
    if (matched.length > 0) {
      return [modeSev, [`Domain '${domain}' with keywords: ${matched.join(', ')}`]];
    }
  }
  return [Severity.ALLOW, []];
}

export function isSensitiveEntity(entityId: string, root?: string | null): boolean {
  const [sev] = classifyEntity(entityId, root);
  return sev !== Severity.ALLOW;
}

export function isSensitiveService(serviceName: string): boolean {
  const [sev] = classifyEntity(serviceName);
  return sev !== Severity.ALLOW;
}

export function evaluateReferences(
  entityIds: string[],
  services: string[],
  root?: string | null,
): PolicyDecision {
  let maxSev: Severity = Severity.ALLOW;
  const reasons: string[] = [];
  for (const entityId of [...new Set(entityIds)].sort()) {
    const [sev] = classifyEntity(entityId, root);
    if (sev !== Severity.ALLOW) {
      reasons.push(`Sensitive or ambiguous entity (${sev}): ${entityId}`);
      if (SEVERITY_ORDER[sev] > SEVERITY_ORDER[maxSev]) maxSev = sev;
    }
  }
  for (const service of [...new Set(services)].sort()) {
    const [sev] = classifyEntity(service, root);
    if (sev !== Severity.ALLOW) {
      reasons.push(`Sensitive or ambiguous service (${sev}): ${service}`);
      if (SEVERITY_ORDER[sev] > SEVERITY_ORDER[maxSev]) maxSev = sev;
    }
  }
  return { severity: maxSev, blocked: maxSev === Severity.BLOCK, reasons };
}

export function canReloadDomain(domain: string): boolean {
  return SAFE_RELOAD_DOMAINS.has(domain);
}

export interface EntityCheck {
  entity_id: string;
  sensitive: boolean;
  severity: Severity;
  reasons: string[];
}

/** Return a JSON-friendly policy check for a single entity. */
export function checkEntity(entityId: string): EntityCheck {
  const [sev, reasons] = classifyEntity(entityId);
  return {
    entity_id: entityId,
    sensitive: sev !== Severity.ALLOW,
    severity: sev,
    reasons,
  };
}

export function normalizeEntityIndex(
  states: Array<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const index: Record<string, Record<string, unknown>> = {};
  for (const state of states) {
    const entityId = state['entity_id'];
    if (typeof entityId === 'string') index[entityId] = state;
  }
  return index;
}
