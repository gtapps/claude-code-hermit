// Read-only analyzer for the hermit-evolve skill. Computes the deterministic
// comparisons the skill would otherwise do in-context — version gap, the
// bounded CHANGELOG slice, new config keys, changed templates/bin, and the
// CLAUDE-APPEND block diff — and emits one JSON "plan" to stdout. The skill
// acts on the plan instead of reading and diffing whole files itself.
//
// Also computes sibling hermit plans (registry-driven from _hermit_versions)
// so Step 7 doesn't rely on in-context LLM detection.
//
// Pure analyzer: never writes or copies. Fail-open: always exits 0; problems
// are recorded in the `errors` array (objects of {code, message}), never
// thrown. No stdin (skill-invoked, like doctor-check.ts / resolve-outbound-channel.ts).
//
// Usage: bun evolve-plan.ts [hermit-dir] --hatch-target=<local|committed>
//                           [--plugin-list-json=<path>]
//
// --plugin-list-json: inject claude plugin list --json output from a file (for
//   tests / when the main loop pre-resolves it). When absent, the script spawns
//   `claude plugin list --json` itself.

import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from './lib/hash';

type Json = any;

type FileClass = 'missing' | 'unmodified' | 'customized-kept' | 'conflict';
interface ClassifiedFile { name: string; class: FileClass; boot_critical?: boolean; bootstrap?: boolean; }

interface SiblingPlanEntry {
  name: string;
  install_path: string;
  from: string;
  to: string;
  up_to_date: boolean;
  changelog_slice?: string;
  changelog_versions?: string[];
  claude_append_changed?: boolean;
  claude_append_old_block?: string;
  marker?: string;
}

const MARKER = '<!-- claude-code-hermit: Session Discipline -->';
const TEMPLATE_FILES = [
  'SHELL.md.template',
  'SESSION-REPORT.md.template',
  'PROPOSAL.md.template',
];

// 3-way compare of X.Y.Z leading semver. Unparseable forms compare equal
// (don't second-guess), matching doctor-check.ts satisfiesRange's posture.
function cmpSemver(a: string, b: string): number {
  const pa = String(a).match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = String(b).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = parseInt(pa[i], 10) - parseInt(pb[i], 10);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readJSON(p: string): Json {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readTemplateManifestFiles(manifestPath: string): Record<string, { sha256: string }> {
  const raw = readJSON(manifestPath);
  if (!isPlainObject(raw) || !isPlainObject(raw.files)) {
    throw new Error('template-manifest.json: missing or invalid `files` object');
  }
  const badKeys = Object.entries(raw.files).filter(
    ([, v]: [string, any]) => !isPlainObject(v) || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)
  ).map(([k]) => k);
  if (badKeys.length > 0) {
    throw new Error(`template-manifest.json: invalid sha256 in: ${badKeys.join(', ')}`);
  }
  return raw.files as Record<string, { sha256: string }>;
}

// Strip trailing whitespace for equality comparison (a trailing newline must
// not register as a content change).
function normTrailing(s: string): string {
  return s.replace(/\s+$/, '');
}

// Slice of CHANGELOG.md entries in the half-open range (from, to], oldest-first.
// Headers look like "## [1.1.7] - 2026-05-31". Each entry spans from its header
// to the line before the next header. This is the read that replaces a full
// 47K-token CHANGELOG read and dodges the Read tool's 2000-line truncation.
function changelogSlice(text: string, from: string, to: string | null) {
  const lines = text.split('\n');
  const headerRe = /^## \[(\d+\.\d+\.\d+)\]/;
  const entries: Json[] = [];
  let cur: Json = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (m) {
      if (cur) {
        cur.end = i;
        entries.push(cur);
      }
      cur = { version: m[1], start: i, end: lines.length };
    }
  }
  if (cur) entries.push(cur);

  const inRange = entries.filter(
    (e: Json) => cmpSemver(from, e.version) < 0 && (to == null || cmpSemver(e.version, to) <= 0)
  );
  inRange.sort((a: Json, b: Json) => cmpSemver(a.version, b.version));

  const slice = inRange
    .map((e: Json) => normTrailing(lines.slice(e.start, e.end).join('\n')))
    .join('\n\n');
  return { slice, versions: inRange.map((e: Json) => e.version) };
}

// Deep diff of the template against the project config; reports ONLY keys
// missing from the project (operator values are never reported/overwritten).
// Parent object entirely absent -> emit the parent path with its full default
// subtree. Parent present but children missing -> emit the missing leaves as
// dotted paths. Arrays and scalars are leaves (no element-level merge), so a
// new default routine in a later version rides on Upgrade Instructions, as today.
function newConfigKeys(tmpl: Json, config: Json, prefix?: string, out?: Json[]): Json[] {
  out = out || [];
  prefix = prefix || '';
  if (!isPlainObject(tmpl)) return out;
  for (const key of Object.keys(tmpl)) {
    const tval = tmpl[key];
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const present = isPlainObject(config) && Object.prototype.hasOwnProperty.call(config, key);
    if (!present) {
      out.push({ path: fullPath, default: tval });
    } else if (isPlainObject(tval) && isPlainObject(config[key])) {
      newConfigKeys(tval, config[key], fullPath, out);
    }
    // present + leaf, or present with a type mismatch -> operator value kept, skip.
  }
  return out;
}

// 3-way classify a single file (already-read buffers) against the manifest
// baseline. Returns null when on-disk is byte-identical to upstream (nothing to
// do). dstBuf null -> `missing`. manifestKey is the lookup key in manifestFiles.
function classifyOne(
  name: string,
  srcBuf: Buffer,
  dstBuf: Buffer | null,
  manifestFiles: Record<string, { sha256: string }> | null,
  manifestKey: string,
  bootCritical: boolean,
): ClassifiedFile | null {
  // on-disk absent -> restore unconditionally (deleted wrapper / fresh install)
  if (dstBuf === null) {
    const e: ClassifiedFile = { name, class: 'missing' };
    if (bootCritical) e.boot_critical = true;
    return e;
  }

  // on-disk identical to upstream -> nothing to do
  if (srcBuf.equals(dstBuf)) return null;

  // on-disk differs from upstream -> 3-way classify via manifest baseline
  const baseline = manifestFiles ? manifestFiles[manifestKey] : null;

  let cls: FileClass;
  if (baseline == null) {
    // No manifest entry (bootstrap or file added after last hatch) ->
    // treat baseline as on-disk (seed-as-unmodified): safe to overwrite.
    cls = 'unmodified';
  } else {
    const onDiskHash = sha256(dstBuf);
    const baseHash = baseline.sha256;
    if (onDiskHash === baseHash) {
      cls = 'unmodified';          // operator never touched it; template moved
    } else {
      const upstreamHash = sha256(srcBuf);
      if (upstreamHash === baseHash) {
        cls = 'customized-kept';   // operator edited; template didn't change
      } else {
        cls = 'conflict';          // both sides diverged
      }
    }
  }

  const e: ClassifiedFile = { name, class: cls };
  if (bootCritical) e.boot_critical = true;
  return e;
}

// Classify each managed file against the pristine-baseline manifest.
//
// manifestFiles: the `files` map from state/template-manifest.json, or null
//   when the manifest is absent (bootstrap run — treat baseline as on-disk).
// keyPrefix:     path prefix used as the manifest key ("templates" or "bin").
// bootCritical:  true for bin/ wrappers (stale = broken hermit).
//
// Only files that need attention (on-disk absent or on-disk != upstream) are
// returned. Source missing -> skip (nothing to sync), same as before.
function classifyFiles(
  srcDir: string,
  dstDir: string,
  names: string[],
  manifestFiles: Record<string, { sha256: string }> | null,
  keyPrefix: string,
  bootCritical: boolean,
): ClassifiedFile[] {
  const result: ClassifiedFile[] = [];
  for (const name of names) {
    let srcBuf: Buffer;
    try {
      srcBuf = fs.readFileSync(path.join(srcDir, name));
    } catch {
      continue; // source missing -> nothing to sync
    }

    let dstBuf: Buffer | null;
    try {
      dstBuf = fs.readFileSync(path.join(dstDir, name));
    } catch {
      dstBuf = null;
    }

    const e = classifyOne(name, srcBuf, dstBuf, manifestFiles, `${keyPrefix}/${name}`, bootCritical);
    if (e) result.push(e);
  }
  return result;
}

// F1 — classify the deployed docker entrypoint. It is now placeholder-free
// (rendered == upstream byte-for-byte), so it joins the manifest system exactly
// like a boot-critical bin/ wrapper. Upstream is `<name>.template`; on-disk is
// the suffix-stripped file at project root. Returns null when the project has no
// deployed entrypoint (don't create docker files in a non-docker project).
function classifyDockerEntrypoint(
  stDir: string,
  projectRoot: string,
  manifestFiles: Record<string, { sha256: string }> | null,
): ClassifiedFile | null {
  let srcBuf: Buffer;
  try {
    srcBuf = fs.readFileSync(path.join(stDir, 'docker', 'docker-entrypoint.hermit.sh.template'));
  } catch {
    return null; // no upstream entrypoint template -> nothing to manage
  }
  let dstBuf: Buffer;
  try {
    dstBuf = fs.readFileSync(path.join(projectRoot, 'docker-entrypoint.hermit.sh'));
  } catch {
    return null; // no deployed entrypoint -> project isn't docker-deployed
  }
  const e = classifyOne(
    'docker-entrypoint.hermit.sh', srcBuf, dstBuf,
    manifestFiles, 'docker/docker-entrypoint.hermit.sh', true,
  );
  // Per-file bootstrap: the global manifest can exist (templates/bin seeded) while
  // the docker baseline is absent — it is recorded only by /docker-setup. With no
  // baseline, classifyOne falls back to `unmodified` (would overwrite silently),
  // but we cannot actually tell an operator edit from an old upstream version. Flag
  // it so Step 5c writes a one-time recovery .bak before overwriting. Only matters
  // when on-disk differs from upstream (e !== null); identical files return null.
  const hasBaseline = e !== null && manifestFiles != null
    && manifestFiles['docker/docker-entrypoint.hermit.sh'] != null;
  if (e !== null && !hasBaseline) e.bootstrap = true;
  return e;
}

// F2 — report-only upstream-drift signal for the wizard-rendered docker files
// (compose + Dockerfile). These carry placeholders, so rendered bytes never
// match upstream — we can only compare the UPSTREAM template hash against the
// baseline recorded by docker-setup. status: "changed" (upstream moved since
// last render) | "unknown" (no baseline recorded — pre-this-version deploy).
// Skips files with no rendered counterpart in the project (no docker deploy).
function classifyDockerTemplates(
  stDir: string,
  projectRoot: string,
  manifestFiles: Record<string, { sha256: string }> | null,
): Json[] {
  const out: Json[] = [];
  const files = [
    { tmpl: 'docker-compose.hermit.yml.template', rendered: 'docker-compose.hermit.yml' },
    { tmpl: 'Dockerfile.hermit.template', rendered: 'Dockerfile.hermit' },
  ];
  for (const f of files) {
    let srcBuf: Buffer;
    try {
      srcBuf = fs.readFileSync(path.join(stDir, 'docker', f.tmpl));
    } catch {
      continue; // no upstream template -> nothing to compare
    }
    if (!fs.existsSync(path.join(projectRoot, f.rendered))) continue; // not deployed
    const baseline = manifestFiles ? manifestFiles[`docker/${f.tmpl}`] : null;
    if (baseline == null) {
      out.push({ name: f.rendered, status: 'unknown' });
    } else if (sha256(srcBuf) !== baseline.sha256) {
      out.push({ name: f.rendered, status: 'changed' });
    }
    // upstream unchanged since last render -> omit
  }
  return out;
}

// Marker-onward block: from the marker line to EOF or the next standalone
// "---" line. Returns null if the marker is absent. Used on both the template
// (which skips its own leading "---") and the target CLAUDE file, so the two
// are compared apples-to-apples.
// When marker is omitted, defaults to the core MARKER constant.
function markerOnward(text: string, marker?: string): string | null {
  const m = marker ?? MARKER;
  const idx = text.indexOf(m);
  if (idx === -1) return null;
  const block = text.slice(idx);
  const lines = block.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return lines.slice(0, i).join('\n');
    }
  }
  return block;
}

// Extract the first HTML comment line from a CLAUDE-APPEND.md template.
// Used to determine a sibling hermit's CLAUDE-APPEND marker.
// Returns null if no HTML comment line is found.
function extractSiblingMarker(text: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('<!--') && t.endsWith('-->')) return t;
  }
  return null;
}

// Safe realpath: returns p unchanged if the path can't be resolved (ENOENT etc.)
function safeRealpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

// Internal: diff a CLAUDE-APPEND block against what's in the target file.
// tmplText: the template file content (already read by caller).
// marker: the HTML-comment marker line.
// targetFile: path to CLAUDE.local.md or CLAUDE.md.
// Returns null on error (error pushed); {changed, old_block?} on success.
function _diffClaudeAppendByText(
  tmplText: string,
  marker: string,
  targetFile: string,
  errors: Json[],
  codes: { markerMissing: string; targetUnreadable: string },
): { changed: boolean; old_block?: string } | null {
  const tmplBlock = markerOnward(tmplText, marker);
  if (tmplBlock === null) {
    errors.push({ code: codes.markerMissing, message: `marker "${marker}" not found in template` });
    return null;
  }

  let targetBlock: string | null = null;
  try {
    targetBlock = markerOnward(fs.readFileSync(targetFile, 'utf8'), marker);
  } catch (e: any) {
    if (e && e.code !== 'ENOENT') {
      errors.push({ code: codes.targetUnreadable, message: `${targetFile} unreadable: ${e.message}` });
      return null;
    }
    // file missing -> append case (targetBlock stays null)
  }

  if (targetBlock === null) {
    return { changed: true }; // file missing or marker absent — append case, no old_block
  }
  const changed = normTrailing(targetBlock) !== normTrailing(tmplBlock);
  const result: { changed: boolean; old_block?: string } = { changed };
  if (changed) result.old_block = targetBlock;
  return result;
}

function computeClaudeAppend(plan: Json, pluginRoot: string, hermitDir: string, hatchTarget: string, errors: Json[]) {
  let tmplText: string;
  try {
    tmplText = fs.readFileSync(path.join(pluginRoot, 'state-templates', 'CLAUDE-APPEND.md'), 'utf8');
  } catch (e: any) {
    errors.push({ code: 'claude_append_template_unreadable', message: e.message });
    return;
  }

  const projectRoot = path.resolve(hermitDir, '..');
  const targetFile = path.join(projectRoot, hatchTarget === 'local' ? 'CLAUDE.local.md' : 'CLAUDE.md');

  const result = _diffClaudeAppendByText(tmplText, MARKER, targetFile, errors, {
    markerMissing: 'claude_append_marker_missing',
    targetUnreadable: 'claude_target_unreadable',
  });
  if (result === null) return;
  plan.claude_append_changed = result.changed;
  if (result.changed && result.old_block !== undefined) {
    plan.claude_append_old_block = result.old_block;
  }
}

// Load the claude plugin list --json inventory.
// pluginListJsonPath: read from file when provided (tests / main-loop injection).
// When absent, spawns `claude plugin list --json` directly.
// Returns {list, error} — list is [] and error is set on any failure.
function loadPluginList(pluginListJsonPath: string | null): { list: any[]; error?: string } {
  if (pluginListJsonPath) {
    try {
      const text = fs.readFileSync(pluginListJsonPath, 'utf8');
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return { list: [], error: 'plugin-list-json is not a JSON array' };
      return { list: parsed };
    } catch (e: any) {
      return { list: [], error: `failed to read --plugin-list-json: ${e.message}` };
    }
  }

  try {
    const proc = Bun.spawnSync(['claude', 'plugin', 'list', '--json'], {
      env: process.env as Record<string, string>,
    });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr ? proc.stderr.toString().trim() : '';
      return { list: [], error: `claude plugin list exited ${proc.exitCode}${stderr ? ': ' + stderr : ''}` };
    }
    const text = proc.stdout.toString();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch (e: any) {
      return { list: [], error: `claude plugin list output not valid JSON: ${e.message}` };
    }
    if (!Array.isArray(parsed)) return { list: [], error: 'claude plugin list output is not a JSON array' };
    return { list: parsed };
  } catch (e: any) {
    return { list: [], error: `failed to spawn claude plugin list: ${e.message}` };
  }
}

// Extract the plugin name from a plugin id (format: "name@marketplace").
function _pluginName(id: string): string {
  return id.split('@')[0];
}

// Find the project-effective entry for `name` in a pre-filtered plugin slice.
// Scope precedence: project > local.
function resolveProjectEffectivePlugin(projectEffective: any[], name: string): any | null {
  const candidates = projectEffective.filter(e => _pluginName(String(e.id || '')) === name);
  const byScope = (scope: string) => candidates.find(e => e.scope === scope);
  return byScope('project') ?? byScope('local') ?? null;
}

// Compute per-sibling plan entries from _hermit_versions and the plugin list.
// Registered siblings (keys in _hermit_versions minus 'claude-code-hermit') are
// the authoritative membership set. The plugin list is used for path resolution only.
function computeSiblings(
  config: Json,
  pluginList: any[],
  hermitDir: string,
  hatchTarget: string,
  projectRoot: string,
  siblingWarnings: string[],
): { siblings: SiblingPlanEntry[]; siblings_path_unresolved: string[]; siblings_detected_unregistered: string[] } {
  const siblings: SiblingPlanEntry[] = [];
  const siblings_path_unresolved: string[] = [];
  const siblings_detected_unregistered: string[] = [];

  const versions: Record<string, string> = isPlainObject(config._hermit_versions)
    ? { ...config._hermit_versions }
    : {};
  const registeredNames = Object.keys(versions).filter(n => n !== 'claude-code-hermit');
  // CHANGELOG 1623 guard: pre-filter once to enabled project/local entries for this project.
  const realRoot = safeRealpath(projectRoot);
  const projectEffective = pluginList.filter(e =>
    e.enabled === true &&
    (e.scope === 'project' || e.scope === 'local') &&
    safeRealpath(String(e.projectPath || '')) === realRoot
  );

  const targetFile = path.join(projectRoot, hatchTarget === 'local' ? 'CLAUDE.local.md' : 'CLAUDE.md');

  for (const name of registeredNames) {
    const entry = resolveProjectEffectivePlugin(projectEffective, name);
    if (!entry) {
      siblings_path_unresolved.push(name);
      continue;
    }

    const installPath: string = String(entry.installPath || '');
    if (!installPath) {
      siblings_path_unresolved.push(name);
      continue;
    }

    const from = String(versions[name] || '0.0.0');

    // Read sibling's installed version from its plugin.json
    let to: string | null = null;
    try {
      const pj = readJSON(path.join(installPath, '.claude-plugin', 'plugin.json'));
      to = typeof pj.version === 'string' ? pj.version : null;
    } catch {
      siblings_path_unresolved.push(name);
      continue;
    }

    if (to === null) {
      siblings_path_unresolved.push(name);
      continue;
    }

    // Downgrade guard: from > to. Treat as no-gap (don't bump), surface as warning.
    const gap = cmpSemver(from, to);
    const upToDate = gap >= 0; // from >= to -> nothing to upgrade
    if (gap > 0) {
      siblingWarnings.push(`${name}: installed=${to} < config=${from} (downgrade — skipping bump)`);
    }

    const sibling: SiblingPlanEntry = { name, install_path: installPath, from, to, up_to_date: upToDate };

    // CHANGELOG slice — only needed when there's a version gap
    if (!upToDate) {
      try {
        const cl = fs.readFileSync(path.join(installPath, 'CHANGELOG.md'), 'utf8');
        const { slice, versions: vers } = changelogSlice(cl, from, to);
        sibling.changelog_slice = slice;
        sibling.changelog_versions = vers;
      } catch {
        siblingWarnings.push(`${name}: CHANGELOG.md unreadable at ${installPath}`);
      }
    }

    // CLAUDE-APPEND drift — computed for all siblings so no-gap drift can be
    // reported as advisory (block-drifted). Edit is only applied on a version gap.
    const claudeAppendPath = path.join(installPath, 'state-templates', 'CLAUDE-APPEND.md');
    let tmplText: string | null = null;
    try {
      tmplText = fs.readFileSync(claudeAppendPath, 'utf8');
    } catch {
      // No CLAUDE-APPEND.md for this sibling — skip block comparison
    }

    if (tmplText !== null) {
      const marker = extractSiblingMarker(tmplText);
      if (marker !== null) {
        sibling.marker = marker;
        const localErrors: Json[] = [];
        const diffResult = _diffClaudeAppendByText(tmplText, marker, targetFile, localErrors, {
          markerMissing: `sibling_${name}_marker_missing`,
          targetUnreadable: `sibling_${name}_target_unreadable`,
        });
        if (localErrors.length > 0) {
          siblingWarnings.push(...localErrors.map((e: Json) => `${name}: ${e.message}`));
        }
        if (diffResult !== null) {
          sibling.claude_append_changed = diffResult.changed;
          if (diffResult.changed && diffResult.old_block !== undefined) {
            sibling.claude_append_old_block = diffResult.old_block;
          }
        }
      }
    }

    siblings.push(sibling);
  }

  // Detect project-effective hermit plugins not in the registry (opt-in opportunity).
  // "Hermit" = name contains "hermit" but is NOT "claude-code-hermit".
  const registeredSet = new Set(registeredNames);
  const effectiveHermitNames = new Set<string>();
  for (const e of projectEffective) {
    const n = _pluginName(String(e.id || ''));
    if (n !== 'claude-code-hermit' && n.includes('hermit')) {
      effectiveHermitNames.add(n);
    }
  }
  for (const n of effectiveHermitNames) {
    if (!registeredSet.has(n)) {
      siblings_detected_unregistered.push(n);
    }
  }

  return { siblings, siblings_path_unresolved, siblings_detected_unregistered };
}

function buildPlan({ hermitDir, pluginRoot, hatchTarget, pluginListJsonPath }: {
  hermitDir: string;
  pluginRoot: string;
  hatchTarget: string | null;
  pluginListJsonPath?: string | null;
}): Json {
  const errors: Json[] = [];
  const plan: Json = { errors };

  if (hatchTarget !== 'local' && hatchTarget !== 'committed') {
    errors.push({ code: 'no_hatch_target', message: '--hatch-target=<local|committed> is required' });
    return plan;
  }
  plan.hatch_target = hatchTarget;

  const configPath = path.join(hermitDir, 'config.json');
  let config: Json;
  try {
    config = readJSON(configPath);
  } catch (e: any) {
    if (e && e.code === 'ENOENT') {
      errors.push({ code: 'no_config', message: 'config.json not found' });
    } else if (e && e.name === 'SyntaxError') {
      errors.push({ code: 'config_json_invalid', message: `config.json is not valid JSON: ${e.message}` });
    } else {
      errors.push({ code: 'config_unreadable', message: `config.json unreadable: ${e.message}` });
    }
    return plan;
  }

  let to: string | null = null;
  try {
    to = readJSON(path.join(pluginRoot, '.claude-plugin', 'plugin.json')).version || null;
  } catch (e: any) {
    errors.push({ code: 'plugin_json_unreadable', message: e.message });
  }
  const from = (isPlainObject(config._hermit_versions) && config._hermit_versions['claude-code-hermit']) || '0.0.0';
  plan.from = from;
  plan.to = to;
  plan.up_to_date = to != null && cmpSemver(from, to) >= 0;

  try {
    const cl = fs.readFileSync(path.join(pluginRoot, 'CHANGELOG.md'), 'utf8');
    const { slice, versions } = changelogSlice(cl, from, to);
    plan.changelog_slice = slice;
    plan.changelog_versions = versions;
  } catch (e: any) {
    errors.push({ code: 'changelog_unreadable', message: e.message });
  }

  try {
    const tmpl = readJSON(path.join(pluginRoot, 'state-templates', 'config.json.template'));
    plan.new_config_keys = newConfigKeys(tmpl, config);
  } catch (e: any) {
    errors.push({ code: 'config_template_unreadable', message: e.message });
  }

  // Read pristine-baseline manifest. Absence = bootstrap run.
  const manifestPath = path.join(hermitDir, 'state', 'template-manifest.json');
  let manifestFiles: Record<string, { sha256: string }> | null = null;
  try {
    manifestFiles = readTemplateManifestFiles(manifestPath);
  } catch (e: any) {
    if (e && e.code === 'ENOENT') {
      plan.manifest_bootstrap = true;
    } else {
      const code = e && e.name === 'SyntaxError' ? 'manifest_parse_error' : 'manifest_invalid';
      errors.push({ code, message: e.message });
      return plan;
    }
  }

  const stDir = path.join(pluginRoot, 'state-templates');
  plan.templates_changed = classifyFiles(stDir, path.join(hermitDir, 'templates'), TEMPLATE_FILES, manifestFiles, 'templates', false);

  const binSrc = path.join(stDir, 'bin');
  let binNames: string[] = [];
  try {
    binNames = fs.readdirSync(binSrc, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch (e) {
    // no bin dir in source -> nothing to sync (not an operator-facing error)
  }
  plan.bin_changed = classifyFiles(binSrc, path.join(hermitDir, 'bin'), binNames, manifestFiles, 'bin', true);

  // Docker drift. F1: the placeholder-free entrypoint is manifest-managed like a
  // boot-critical bin/ wrapper. F2: compose/Dockerfile are report-only (rendered,
  // so only upstream-template drift is detectable). Both fail open to safe defaults.
  const projectRoot = path.resolve(hermitDir, '..');
  try {
    plan.docker_entrypoint = classifyDockerEntrypoint(stDir, projectRoot, manifestFiles);
  } catch (e: any) {
    plan.docker_entrypoint = null;
    errors.push({ code: 'docker_entrypoint_classify_failed', message: e.message });
  }
  try {
    plan.docker_templates = classifyDockerTemplates(stDir, projectRoot, manifestFiles);
  } catch (e: any) {
    plan.docker_templates = [];
    errors.push({ code: 'docker_templates_classify_failed', message: e.message });
  }

  computeClaudeAppend(plan, pluginRoot, hermitDir, hatchTarget, errors);

  // Sibling hermit plans — registry-driven from _hermit_versions.
  // Plugin list load failures are non-fatal: core upgrade proceeds; siblings[] will be empty.
  const siblingWarnings: string[] = [];
  const { list: pluginList, error: pluginListError } = loadPluginList(pluginListJsonPath ?? null);
  if (pluginListError) {
    siblingWarnings.push(`plugin-list unavailable: ${pluginListError}`);
  }

  const siblingResult = computeSiblings(config, pluginList, hermitDir, hatchTarget, projectRoot, siblingWarnings);
  plan.siblings = siblingResult.siblings;
  plan.siblings_path_unresolved = siblingResult.siblings_path_unresolved;
  plan.siblings_detected_unregistered = siblingResult.siblings_detected_unregistered;
  if (siblingWarnings.length > 0) plan.siblings_warnings = siblingWarnings;

  // work_pending: true when core or any sibling needs attention (version gap or
  // CLAUDE-APPEND drift). Drives the short-circuit in SKILL.md Step 1 —
  // "already up to date" only when nothing to do for core OR any registered sibling.
  const siblingWorkNeeded = plan.siblings.some(
    (s: SiblingPlanEntry) => !s.up_to_date || s.claude_append_changed
  );
  plan.work_pending = !plan.up_to_date || siblingWorkNeeded;

  return plan;
}

function parseArgs(argv: string[]) {
  let hermitDir: string | null = null;
  let hatchTarget: string | null = null;
  let pluginListJsonPath: string | null = null;
  for (const a of argv) {
    if (a.startsWith('--hatch-target=')) hatchTarget = a.slice('--hatch-target='.length);
    else if (a.startsWith('--plugin-list-json=')) pluginListJsonPath = a.slice('--plugin-list-json='.length);
    else if (!a.startsWith('--') && hermitDir === null) hermitDir = a;
  }
  return { hermitDir: hermitDir || '.claude-code-hermit', hatchTarget, pluginListJsonPath };
}

export { buildPlan, cmpSemver, changelogSlice, newConfigKeys, markerOnward, classifyFiles, classifyDockerEntrypoint, classifyDockerTemplates };
export type { ClassifiedFile, FileClass };

if (import.meta.main) {
  const { hermitDir, hatchTarget, pluginListJsonPath } = parseArgs(process.argv.slice(2));
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
  let plan: Json;
  try {
    plan = buildPlan({ hermitDir: path.resolve(hermitDir), pluginRoot, hatchTarget, pluginListJsonPath });
  } catch (e: any) {
    plan = { errors: [{ code: 'fatal', message: e.message }] };
  }
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  process.exit(0);
}
