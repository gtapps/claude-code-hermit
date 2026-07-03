#!/usr/bin/env bun
/**
 * Sibling / plugin-list resolver for the core skills.
 *
 * Collapses the "run `claude plugin list --json` and apply the project-or-local
 * + enabled filter" prose that appeared verbatim in hatch, channel-setup,
 * docker-setup, and docker-security into one probe. The skills still own every
 * DECISION these entries feed (target precedence, presence checks, container
 * mirroring, fleet seeding) — this script only gathers the filtered facts.
 *
 * Canonical filter: keep an entry when `enabled === true` AND scope is
 * `"project"` or `"local"` AND its `projectPath` equals the project root passed
 * in. Drops user-scope, managed, disabled, and cross-project entries.
 *
 * Usage: bun resolve-siblings.ts [project-root] [--role all|siblings|core-scope]
 *                                [--dedupe] [--stdin-json]
 *   project-root defaults to process.cwd(); callers pass the shell's `$(pwd)`.
 *   --role all (default): the canonical-filtered list.
 *   --role siblings: filtered to plugin names containing "hermit" (excluding
 *     "claude-code-hermit"). Note: broader than a literal `*-hermit*` glob so
 *     `hermit-scribe` is kept — matches hatch's "contains hermit" intent.
 *   --role core-scope: emits {core_scope, target} for hatch_target precedence.
 *     Runs against the FULL list (the user-scope fallback ignores projectPath).
 *   --dedupe: when the same (plugin, marketplace_name) appears in both `local`
 *     and `project` scope, keep the `local` entry (local overrides project).
 *   --stdin-json: read the plugin-list JSON from stdin instead of shelling
 *     `claude plugin list --json` (test seam — tests never invoke live claude).
 *
 * Prints JSON to stdout and always exits 0 — callers inspect the emitted
 * fields, not the exit code. Any probe that errors degrades to []/null.
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

interface PluginEntry {
  id?: string;
  scope?: string;
  enabled?: boolean;
  projectPath?: string;
  installPath?: string;
}

interface FilteredEntry {
  plugin: string;
  id: string;
  marketplace_name: string;
  scope: string;
  projectPath: string;
  installPath: string;
  enabled: boolean;
}

type Role = 'all' | 'siblings' | 'core-scope';

interface Options {
  role?: Role;
  dedupe?: boolean;
}

function splitId(id: string): { plugin: string; marketplace_name: string } {
  const at = id.indexOf('@');
  if (at < 0) return { plugin: id, marketplace_name: '' };
  return { plugin: id.slice(0, at), marketplace_name: id.slice(at + 1) };
}

function toFiltered(e: PluginEntry): FilteredEntry {
  const id = e.id ?? '';
  const { plugin, marketplace_name } = splitId(id);
  return {
    plugin,
    id,
    marketplace_name,
    scope: e.scope ?? '',
    projectPath: e.projectPath ?? '',
    installPath: e.installPath ?? '',
    enabled: e.enabled === true,
  };
}

// Canonical filter — the prose that was duplicated across the 4 skills.
function canonicalFilter(list: PluginEntry[], projectRoot: string): FilteredEntry[] {
  return list
    .filter(
      (e) =>
        e.enabled === true &&
        (e.scope === 'project' || e.scope === 'local') &&
        e.projectPath === projectRoot,
    )
    .map(toFiltered);
}

// Keep `local` over `project` when the same (plugin, marketplace_name) appears in both.
function dedupeLocalOverProject(entries: FilteredEntry[]): FilteredEntry[] {
  const byKey = new Map<string, FilteredEntry>();
  for (const e of entries) {
    const key = `${e.plugin}@${e.marketplace_name}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, e);
    } else if (existing.scope === 'project' && e.scope === 'local') {
      byKey.set(key, e);
    }
  }
  return [...byKey.values()];
}

function coreScope(list: PluginEntry[], projectRoot: string): {
  core_scope: 'local' | 'project' | 'user' | null;
  target: 'committed' | 'local';
} {
  const coreHere = list.filter(
    (e) =>
      splitId(e.id ?? '').plugin === 'claude-code-hermit' &&
      e.enabled === true &&
      e.projectPath === projectRoot,
  );
  let core_scope: 'local' | 'project' | 'user' | null;
  if (coreHere.some((e) => e.scope === 'local')) {
    core_scope = 'local';
  } else if (coreHere.some((e) => e.scope === 'project')) {
    core_scope = 'project';
  } else if (
    // User-scope fallback ignores projectPath by design (hatch line 32).
    list.some((e) => splitId(e.id ?? '').plugin === 'claude-code-hermit' && e.scope === 'user')
  ) {
    core_scope = 'user';
  } else {
    core_scope = null;
  }
  // project → committed; local/user/null → local (safer default).
  const target: 'committed' | 'local' = core_scope === 'project' ? 'committed' : 'local';
  return { core_scope, target };
}

function resolveSiblings(pluginList: PluginEntry[], projectRoot: string, opts: Options = {}) {
  const role: Role = opts.role ?? 'all';
  if (role === 'core-scope') {
    return coreScope(pluginList, projectRoot);
  }
  let entries = canonicalFilter(pluginList, projectRoot);
  if (role === 'siblings') {
    entries = entries.filter((e) => e.plugin.includes('hermit') && e.plugin !== 'claude-code-hermit');
  }
  if (opts.dedupe) {
    entries = dedupeLocalOverProject(entries);
  }
  return entries;
}

export { resolveSiblings, canonicalFilter, dedupeLocalOverProject, coreScope, splitId };

function pluginListFromClaude(): PluginEntry[] {
  try {
    const r = spawnSync('claude', ['plugin', 'list', '--json'], { timeout: 15000, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) {
      const parsed = JSON.parse(r.stdout);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

function readStdin(): PluginEntry[] {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let projectRoot: string | undefined;
  let role: Role = 'all';
  let dedupe = false;
  let useStdin = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dedupe') dedupe = true;
    else if (a === '--stdin-json') useStdin = true;
    else if (a === '--role') role = (argv[++i] as Role) ?? 'all';
    else if (a.startsWith('--role=')) role = a.slice('--role='.length) as Role;
    else if (!a.startsWith('--') && projectRoot === undefined) projectRoot = a;
  }
  projectRoot = projectRoot ?? process.cwd();

  const list = useStdin ? readStdin() : pluginListFromClaude();
  console.log(JSON.stringify(resolveSiblings(list, projectRoot, { role, dedupe })));
  process.exit(0);
}
