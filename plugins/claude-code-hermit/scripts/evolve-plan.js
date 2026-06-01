'use strict';

// Read-only analyzer for the hermit-evolve skill. Computes the deterministic
// comparisons the skill would otherwise do in-context — version gap, the
// bounded CHANGELOG slice, new config keys, changed templates/bin, and the
// CLAUDE-APPEND block diff — and emits one JSON "plan" to stdout. The skill
// acts on the plan instead of reading and diffing whole files itself.
//
// Pure analyzer: never writes or copies. Fail-open: always exits 0; problems
// are recorded in the `errors` array (objects of {code, message}), never
// thrown. No stdin (skill-invoked, like doctor-check.js / resolve-outbound-channel.js).
//
// Usage: node evolve-plan.js [hermit-dir] --hatch-target=<local|committed>

const fs = require('fs');
const path = require('path');

const MARKER = '<!-- claude-code-hermit: Session Discipline -->';
const TEMPLATE_FILES = [
  'SHELL.md.template',
  'SESSION-REPORT.md.template',
  'PROPOSAL.md.template',
];

// 3-way compare of X.Y.Z leading semver. Unparseable forms compare equal
// (don't second-guess), matching doctor-check.js satisfiesRange's posture.
function cmpSemver(a, b) {
  const pa = String(a).match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = String(b).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = parseInt(pa[i], 10) - parseInt(pb[i], 10);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Strip trailing whitespace for equality comparison (a trailing newline must
// not register as a content change).
function normTrailing(s) {
  return s.replace(/\s+$/, '');
}

// Slice of CHANGELOG.md entries in the half-open range (from, to], oldest-first.
// Headers look like "## [1.1.7] - 2026-05-31". Each entry spans from its header
// to the line before the next header. This is the read that replaces a full
// 47K-token CHANGELOG read and dodges the Read tool's 2000-line truncation.
function changelogSlice(text, from, to) {
  const lines = text.split('\n');
  const headerRe = /^## \[(\d+\.\d+\.\d+)\]/;
  const entries = [];
  let cur = null;
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
    (e) => cmpSemver(from, e.version) < 0 && (to == null || cmpSemver(e.version, to) <= 0)
  );
  inRange.sort((a, b) => cmpSemver(a.version, b.version));

  const slice = inRange
    .map((e) => normTrailing(lines.slice(e.start, e.end).join('\n')))
    .join('\n\n');
  return { slice, versions: inRange.map((e) => e.version) };
}

// Deep diff of the template against the project config; reports ONLY keys
// missing from the project (operator values are never reported/overwritten).
// Parent object entirely absent -> emit the parent path with its full default
// subtree. Parent present but children missing -> emit the missing leaves as
// dotted paths. Arrays and scalars are leaves (no element-level merge), so a
// new default routine in a later version rides on Upgrade Instructions, as today.
function newConfigKeys(tmpl, config, prefix, out) {
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

// Basenames whose project copy differs from (or is missing relative to) the
// template. Source missing -> nothing to sync (skip). Byte comparison only;
// contents never enter the plan.
function changedFiles(srcDir, dstDir, names) {
  const changed = [];
  for (const name of names) {
    let srcBuf;
    try {
      srcBuf = fs.readFileSync(path.join(srcDir, name));
    } catch (e) {
      continue;
    }
    let dstBuf;
    try {
      dstBuf = fs.readFileSync(path.join(dstDir, name));
    } catch (e) {
      changed.push(name);
      continue;
    }
    if (!srcBuf.equals(dstBuf)) changed.push(name);
  }
  return changed;
}

// Marker-onward block: from the MARKER line to EOF or the next standalone
// "---" line. Returns null if the marker is absent. Used on both the template
// (which skips its own leading "---") and the target CLAUDE file, so the two
// are compared apples-to-apples.
function markerOnward(text) {
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

function computeClaudeAppend(plan, pluginRoot, hermitDir, hatchTarget, errors) {
  let tmplText;
  try {
    tmplText = fs.readFileSync(path.join(pluginRoot, 'state-templates', 'CLAUDE-APPEND.md'), 'utf8');
  } catch (e) {
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
  let targetBlock = null;
  try {
    targetBlock = markerOnward(fs.readFileSync(targetFile, 'utf8'));
  } catch (e) {
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

function buildPlan({ hermitDir, pluginRoot, hatchTarget }) {
  const errors = [];
  const plan = { errors };

  if (hatchTarget !== 'local' && hatchTarget !== 'committed') {
    errors.push({ code: 'no_hatch_target', message: '--hatch-target=<local|committed> is required' });
    return plan;
  }
  plan.hatch_target = hatchTarget;

  const configPath = path.join(hermitDir, 'config.json');
  let config;
  try {
    config = readJSON(configPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      errors.push({ code: 'no_config', message: 'config.json not found' });
    } else if (e && e.name === 'SyntaxError') {
      errors.push({ code: 'config_json_invalid', message: `config.json is not valid JSON: ${e.message}` });
    } else {
      errors.push({ code: 'config_unreadable', message: `config.json unreadable: ${e.message}` });
    }
    return plan;
  }

  let to = null;
  try {
    to = readJSON(path.join(pluginRoot, '.claude-plugin', 'plugin.json')).version || null;
  } catch (e) {
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
  } catch (e) {
    errors.push({ code: 'changelog_unreadable', message: e.message });
  }

  try {
    const tmpl = readJSON(path.join(pluginRoot, 'state-templates', 'config.json.template'));
    plan.new_config_keys = newConfigKeys(tmpl, config);
  } catch (e) {
    errors.push({ code: 'config_template_unreadable', message: e.message });
  }

  const stDir = path.join(pluginRoot, 'state-templates');
  plan.templates_changed = changedFiles(stDir, path.join(hermitDir, 'templates'), TEMPLATE_FILES);

  const binSrc = path.join(stDir, 'bin');
  let binNames = [];
  try {
    binNames = fs.readdirSync(binSrc, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch (e) {
    // no bin dir in source -> nothing to sync (not an operator-facing error)
  }
  plan.bin_changed = changedFiles(binSrc, path.join(hermitDir, 'bin'), binNames);

  computeClaudeAppend(plan, pluginRoot, hermitDir, hatchTarget, errors);

  return plan;
}

function parseArgs(argv) {
  let hermitDir = null;
  let hatchTarget = null;
  for (const a of argv) {
    if (a.startsWith('--hatch-target=')) hatchTarget = a.slice('--hatch-target='.length);
    else if (!a.startsWith('--') && hermitDir === null) hermitDir = a;
  }
  return { hermitDir: hermitDir || '.claude-code-hermit', hatchTarget };
}

if (require.main === module) {
  const { hermitDir, hatchTarget } = parseArgs(process.argv.slice(2));
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
  let plan;
  try {
    plan = buildPlan({ hermitDir: path.resolve(hermitDir), pluginRoot, hatchTarget });
  } catch (e) {
    plan = { errors: [{ code: 'fatal', message: e.message }] };
  }
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  process.exit(0);
} else {
  module.exports = { buildPlan, cmpSemver, changelogSlice, newConfigKeys, markerOnward, changedFiles };
}
