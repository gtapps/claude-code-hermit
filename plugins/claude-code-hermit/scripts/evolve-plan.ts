// Read-only analyzer for the hermit-evolve skill. Computes the deterministic
// comparisons the skill would otherwise do in-context — version gap, the
// bounded CHANGELOG slice, new config keys, changed templates/bin, and the
// CLAUDE-APPEND block diff — and emits one JSON "plan" to stdout. The skill
// acts on the plan instead of reading and diffing whole files itself.
//
// Pure analyzer: never writes or copies. Fail-open: always exits 0; problems
// are recorded in the `errors` array (objects of {code, message}), never
// thrown. No stdin (skill-invoked, like doctor-check.ts / resolve-outbound-channel.ts).
//
// Usage: bun evolve-plan.ts [hermit-dir] --hatch-target=<local|committed>

import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from './lib/hash';

type Json = any;

type FileClass = 'missing' | 'unmodified' | 'customized-kept' | 'conflict';
interface ClassifiedFile { name: string; class: FileClass; boot_critical?: boolean; bootstrap?: boolean; }

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

// Marker-onward block: from the MARKER line to EOF or the next standalone
// "---" line. Returns null if the marker is absent. Used on both the template
// (which skips its own leading "---") and the target CLAUDE file, so the two
// are compared apples-to-apples.
function markerOnward(text: string): string | null {
  const idx = text.indexOf(MARKER);
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

function computeClaudeAppend(plan: Json, pluginRoot: string, hermitDir: string, hatchTarget: string, errors: Json[]) {
  let tmplText: string;
  try {
    tmplText = fs.readFileSync(path.join(pluginRoot, 'state-templates', 'CLAUDE-APPEND.md'), 'utf8');
  } catch (e: any) {
    errors.push({ code: 'claude_append_template_unreadable', message: e.message });
    return;
  }
  const tmplBlock = markerOnward(tmplText);
  if (tmplBlock === null) {
    errors.push({ code: 'claude_append_marker_missing', message: 'marker not found in template' });
    return;
  }

  const projectRoot = path.resolve(hermitDir, '..');
  const targetFile = path.join(projectRoot, hatchTarget === 'local' ? 'CLAUDE.local.md' : 'CLAUDE.md');
  let targetBlock: string | null = null;
  try {
    targetBlock = markerOnward(fs.readFileSync(targetFile, 'utf8'));
  } catch (e: any) {
    if (e && e.code !== 'ENOENT') {
      errors.push({ code: 'claude_target_unreadable', message: `${targetFile} unreadable: ${e.message}` });
      return;
    }
    // file missing -> append case
  }

  if (targetBlock === null) {
    plan.claude_append_changed = true; // marker absent -> append full template (skill handles)
    return;
  }
  const changed = normTrailing(targetBlock) !== normTrailing(tmplBlock);
  plan.claude_append_changed = changed;
  if (changed) plan.claude_append_old_block = targetBlock; // exact current text for a targeted Edit
}

function buildPlan({ hermitDir, pluginRoot, hatchTarget }: { hermitDir: string; pluginRoot: string; hatchTarget: string | null }): Json {
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

  return plan;
}

function parseArgs(argv: string[]) {
  let hermitDir: string | null = null;
  let hatchTarget: string | null = null;
  for (const a of argv) {
    if (a.startsWith('--hatch-target=')) hatchTarget = a.slice('--hatch-target='.length);
    else if (!a.startsWith('--') && hermitDir === null) hermitDir = a;
  }
  return { hermitDir: hermitDir || '.claude-code-hermit', hatchTarget };
}

export { buildPlan, cmpSemver, changelogSlice, newConfigKeys, markerOnward, classifyFiles, classifyDockerEntrypoint, classifyDockerTemplates };
export type { ClassifiedFile, FileClass };

if (import.meta.main) {
  const { hermitDir, hatchTarget } = parseArgs(process.argv.slice(2));
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
  let plan: Json;
  try {
    plan = buildPlan({ hermitDir: path.resolve(hermitDir), pluginRoot, hatchTarget });
  } catch (e: any) {
    plan = { errors: [{ code: 'fatal', message: e.message }] };
  }
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  process.exit(0);
}
