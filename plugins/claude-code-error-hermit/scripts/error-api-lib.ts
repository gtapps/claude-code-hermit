// Shared pure helpers for the error-hermit Sentry/GlitchTip client.
//
// No process.exit, no argv parsing — safe to import from both error-api.ts
// (the CLI), error-precheck.ts (added in Phase 2), and the test suite, so the
// tests exercise the SAME parsers and redaction the CLI ships.
//
// GlitchTip implements the Sentry `/api/0/` API shape, so one client covers
// both backends. Endpoints used are the minimal set both support.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface ErrorHermitConfig {
  token: string;
  baseUrl: string;
  org: string;
  project: string;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number; // 0 = network/transport error (never reached the server)
  data?: T;
  error?: string; // scrubbed of the token before it is ever set
}

export interface IssueSummary {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  status: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
}

export interface EventSummary {
  id: string;
  message: string;
  release: string;
  dateCreated: string;
  culprit: string;
}

// Resolve the consumer project root: CLAUDE_PROJECT_DIR if it holds the hermit
// state dir, else walk up from cwd looking for .claude-code-hermit/config.json,
// else cwd. Mirrors forge.php projectRoot() so .env resolves the same way.
export function projectRoot(): string {
  const proj = process.env.CLAUDE_PROJECT_DIR;
  if (proj && safeExists(join(proj, '.claude-code-hermit'))) return proj;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (safeExists(join(dir, '.claude-code-hermit', 'config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function safeExists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

// Parse a project-root .env into a plain map. Real process.env takes precedence
// in resolveConfig(), matching forge.php's getenv-wins semantics.
export function loadEnv(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const eq = t.indexOf('=');
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) out[key] = val;
  }
  return out;
}

export function resolveConfig(root: string): { config?: ErrorHermitConfig; missing: string[] } {
  const fileEnv = loadEnv(root);
  const get = (k: string) => (process.env[k] ?? fileEnv[k] ?? '').trim();
  const token = get('ERROR_HERMIT_TOKEN');
  const baseUrl = get('ERROR_HERMIT_BASE_URL').replace(/\/+$/, '');
  const org = get('ERROR_HERMIT_ORG');
  const project = get('ERROR_HERMIT_PROJECT');
  const missing: string[] = [];
  if (!token || token === 'replace_me') missing.push('ERROR_HERMIT_TOKEN');
  if (!baseUrl) missing.push('ERROR_HERMIT_BASE_URL');
  if (!org) missing.push('ERROR_HERMIT_ORG');
  if (!project) missing.push('ERROR_HERMIT_PROJECT');
  if (missing.length) return { missing };
  return { config: { token, baseUrl, org, project }, missing: [] };
}

export function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

// Scrub the token and any bearer/token-shaped substrings before any output or
// persistence. Always run over error text before it leaves this module.
export function redact(text: string, token?: string): string {
  let out = text;
  if (token) out = out.split(token).join('[REDACTED]');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  out = out.replace(/token["']?\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]+/gi, 'token=[REDACTED]');
  return out;
}

export async function apiRequest<T>(
  url: string,
  token: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, error: redact(String(e), token) };
  }
  const raw = await res.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: redact(raw || res.statusText, token) };
  }
  return { ok: true, status: res.status, data: data as T };
}

export function summarizeIssue(raw: Record<string, unknown>): IssueSummary {
  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  return {
    id: str(raw.id),
    shortId: str(raw.shortId),
    title: str(raw.title ?? metadata.title ?? metadata.value),
    culprit: str(raw.culprit),
    level: str(raw.level),
    status: str(raw.status),
    count: str(raw.count),
    firstSeen: str(raw.firstSeen),
    lastSeen: str(raw.lastSeen),
  };
}

export function summarizeEvent(raw: Record<string, unknown>): EventSummary {
  const releaseObj = (raw.release ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(raw.tags) ? (raw.tags as Array<Record<string, unknown>>) : [];
  const releaseTag = tags.find((t) => t.key === 'release');
  return {
    id: str(raw.id ?? raw.eventID),
    message: str(raw.message ?? raw.title),
    release: str(releaseObj.version ?? releaseTag?.value),
    dateCreated: str(raw.dateCreated),
    culprit: str(raw.culprit),
  };
}

function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

// Build the Sentry issue-search `query` string. Combines an optional free-form
// query with a `firstSeen:>=<iso>` bound so the watch loop sees only groups
// that first appeared at or after the cursor (>= handles boundary ties; the
// triage skill dedups against ids already recorded that day).
export function buildIssueQuery(opts: { since?: string; query?: string }): string {
  const parts: string[] = [];
  if (opts.query) parts.push(opts.query.trim());
  if (opts.since) parts.push(`firstSeen:>=${opts.since}`);
  return parts.join(' ').trim();
}

export function issuesPath(org: string, project: string): string {
  return `/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/`;
}

export function orgPath(org: string): string {
  return `/api/0/organizations/${encodeURIComponent(org)}/`;
}

export function issuePath(id: string): string {
  return `/api/0/issues/${encodeURIComponent(id)}/`;
}

export function latestEventPath(id: string): string {
  return `/api/0/issues/${encodeURIComponent(id)}/events/latest/`;
}
