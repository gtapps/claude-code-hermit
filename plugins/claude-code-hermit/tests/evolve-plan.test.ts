// bun test port of tests/test-evolve-plan.sh — drives scripts/evolve-plan.ts
// (issue #211, the read-only pre-pass analyzer for hermit-evolve) against
// fixture project trees. Covers version gap, bounded CHANGELOG slice, deep
// config-key diff, template/bin byte-compare, separator-aware CLAUDE-APPEND
// diff, the no_config vs 0.0.0 distinction, and operator-value preservation.
// Also covers registry-driven sibling hermit plans (work_pending, gap, no-gap
// CLAUDE-APPEND drift, path-unresolved, detected-but-unregistered, leak guard).
//
// Usage: bun test tests/evolve-plan.test.ts   (from the plugin root)

import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

const MARKER = '<!-- claude-code-hermit: Session Discipline -->';
const SIBLING_MARKER = '<!-- claude-code-dev-hermit: Dev Workflow -->';

// Fake plugin root with plugin version 1.1.7 (shared, read-only across tests).
let PR: string;
// Fake sibling plugin root (claude-code-dev-hermit at v0.4.3).
let SP: string;
// Path to a file containing `[]` — passed as --plugin-list-json to keep existing
// tests hermetic (no live `claude plugin list` spawn needed for non-sibling tests).
let EMPTY_PLUGIN_LIST: string;

beforeAll(() => {
  PR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-evolve-pr-'));
  fs.mkdirSync(path.join(PR, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(PR, 'state-templates', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(PR, '.claude-plugin', 'plugin.json'), '{"version":"1.1.7"}\n');
  fs.writeFileSync(path.join(PR, 'CHANGELOG.md'), `# Changelog

## [1.1.7] - 2026-05-31
### Fixed
- newest change

### Upgrade Instructions
Run the evolve skill.

## [1.1.6] - 2026-05-28
### Added
- middle change

## [1.1.5] - 2026-05-25
### Added
- oldest change
`);
  fs.writeFileSync(path.join(PR, 'state-templates', 'config.json.template'), `{
  "_hermit_versions": {},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "quality_gate": {"tier": "budget"},
  "heartbeat": {"enabled": true, "waiting_timeout": null}
}
`);
  fs.writeFileSync(path.join(PR, 'state-templates', 'CLAUDE-APPEND.md'),
    `---\n\n${MARKER}\n## Session Discipline\n\nbody line\n`);
  fs.writeFileSync(path.join(PR, 'state-templates', 'SHELL.md.template'), 'SHELL TEMPLATE V1\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'SESSION-REPORT.md.template'), 'REPORT TEMPLATE\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'PROPOSAL.md.template'), 'PROPOSAL TEMPLATE\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'bin', 'hermit-run'), '#!/bin/sh\necho run\n');
  fs.mkdirSync(path.join(PR, 'state-templates', 'docker'), { recursive: true });
  fs.writeFileSync(path.join(PR, 'state-templates', 'docker', 'docker-entrypoint.hermit.sh.template'), 'ENTRYPOINT UPSTREAM\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'docker', 'docker-compose.hermit.yml.template'), 'COMPOSE UPSTREAM {{X}}\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'docker', 'Dockerfile.hermit.template'), 'DOCKERFILE UPSTREAM {{Y}}\n');

  // Sibling plugin root: claude-code-dev-hermit at v0.4.3.
  SP = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-evolve-sp-'));
  fs.mkdirSync(path.join(SP, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(SP, 'state-templates'), { recursive: true });
  fs.writeFileSync(path.join(SP, '.claude-plugin', 'plugin.json'), '{"version":"0.4.3"}\n');
  fs.writeFileSync(path.join(SP, 'CHANGELOG.md'), `# Changelog

## [0.4.3] - 2026-06-01
### Fixed
- sibling fix C

## [0.4.2] - 2026-05-20
### Added
- sibling add B

## [0.4.1] - 2026-05-10
### Fixed
- sibling fix A

## [0.4.0] - 2026-05-01
### Added
- initial sibling release
`);
  fs.writeFileSync(
    path.join(SP, 'state-templates', 'CLAUDE-APPEND.md'),
    `---\n\n${SIBLING_MARKER}\n## Dev Workflow\n\ndev body line\n`,
  );

  // Empty plugin list fixture — used by existing tests to avoid spawning claude.
  EMPTY_PLUGIN_LIST = path.join(os.tmpdir(), 'hermit-empty-plugin-list.json');
  fs.writeFileSync(EMPTY_PLUGIN_LIST, '[]\n');
});

afterAll(() => {
  try { fs.rmSync(PR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(EMPTY_PLUGIN_LIST); } catch {}
});

/** Run a test body against a throwaway project tree, always cleaning up. */
function withProj(fn: (proj: string) => Promise<void> | void) {
  return async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-evolve-proj-'));
    fs.mkdirSync(path.join(proj, '.claude-code-hermit'), { recursive: true });
    try { await fn(proj); } finally {
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
    }
  };
}

const hermitDir = (proj: string) => path.join(proj, '.claude-code-hermit');
const writeConfig = (proj: string, content: string) =>
  fs.writeFileSync(path.join(hermitDir(proj), 'config.json'), content);

/** Run evolve-plan and return the parsed plan.
 *  pluginListPath defaults to the empty-list fixture so tests don't spawn claude.
 *  Pass an explicit path for sibling tests that need a populated plugin list. */
async function runPlan(proj: string, hatchTarget?: string, pluginListPath?: string): Promise<any> {
  const args = [hermitDir(proj)];
  if (hatchTarget !== undefined) args.push(`--hatch-target=${hatchTarget}`);
  args.push(`--plugin-list-json=${pluginListPath ?? EMPTY_PLUGIN_LIST}`);
  const r = await runScript('evolve-plan.ts', { args, env: { CLAUDE_PLUGIN_ROOT: PR } });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

// -------------------------------------------------------
// 1. Version gap + bounded changelog slice
// -------------------------------------------------------

test('version gap: from 1.1.6 -> to 1.1.7, not up_to_date', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  const d = await runPlan(proj, 'local');
  expect(d.from).toBe('1.1.6');
  expect(d.to).toBe('1.1.7');
  expect(d.up_to_date).toBe(false);
  expect(d.errors).toEqual([]);
}));

test('changelog slice: only (1.1.6, 1.1.7], excludes older', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  const d = await runPlan(proj, 'local');
  expect(d.changelog_versions).toEqual(['1.1.7']);
  const s = d.changelog_slice;
  expect(s).toContain('newest change');
  expect(s).toContain('Upgrade Instructions');
  expect(s).not.toContain('middle change');
  expect(s).not.toContain('oldest change');
}));

// -------------------------------------------------------
// 2. Up to date
// -------------------------------------------------------

test('up_to_date true when config == plugin version', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.7"}}');
  const d = await runPlan(proj, 'local');
  expect(d.up_to_date).toBe(true);
  expect(d.changelog_versions).toEqual([]);
}));

// -------------------------------------------------------
// 3. New config keys: top-level + nested leaf reported, present omitted
// -------------------------------------------------------

test('new_config_keys: reports quality_gate + heartbeat.waiting_timeout, omits present', withProj(async (proj) => {
  writeConfig(proj, `{
  "_hermit_versions": {"claude-code-hermit": "1.1.6"},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "heartbeat": {"enabled": true}
}
`);
  const d = await runPlan(proj, 'local');
  const keys: Record<string, any> = {};
  for (const k of d.new_config_keys) keys[k.path] = k.default;
  expect(Object.keys(keys)).toContain('quality_gate');
  expect(keys['quality_gate']).toEqual({ tier: 'budget' });
  expect(Object.keys(keys)).toContain('heartbeat.waiting_timeout');
  expect(keys['heartbeat.waiting_timeout']).toBeNull();
  expect(Object.keys(keys)).not.toContain('model');
  expect(Object.keys(keys)).not.toContain('heartbeat.enabled');
}));

// -------------------------------------------------------
// 4. templates_changed / bin_changed: only differing/absent files
// -------------------------------------------------------

test('bootstrap (no manifest): diff + absent reported, identical skipped, manifest_bootstrap=true', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir(proj), 'bin'), { recursive: true });
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SHELL.md.template'), 'DIFFERENT CONTENT\n');
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SESSION-REPORT.md.template'), 'REPORT TEMPLATE\n'); // identical to upstream
  // PROPOSAL.md.template absent -> class=missing
  fs.writeFileSync(path.join(hermitDir(proj), 'bin', 'hermit-run'), '#!/bin/sh\necho CHANGED\n'); // differs
  const d = await runPlan(proj, 'local');

  expect(d.manifest_bootstrap).toBe(true);

  const tNames = d.templates_changed.map((f: any) => f.name);
  expect(tNames).toContain('SHELL.md.template');
  expect(tNames).toContain('PROPOSAL.md.template');
  expect(tNames).not.toContain('SESSION-REPORT.md.template'); // identical -> excluded

  const shell = d.templates_changed.find((f: any) => f.name === 'SHELL.md.template');
  expect(shell.class).toBe('unmodified'); // bootstrap: no manifest entry -> unmodified
  expect(shell.boot_critical).toBeUndefined();

  const proposal = d.templates_changed.find((f: any) => f.name === 'PROPOSAL.md.template');
  expect(proposal.class).toBe('missing');

  expect(d.bin_changed).toHaveLength(1);
  expect(d.bin_changed[0].name).toBe('hermit-run');
  expect(d.bin_changed[0].class).toBe('unmodified'); // bootstrap
  expect(d.bin_changed[0].boot_critical).toBe(true); // all bin/ are boot-critical
}));

// -------------------------------------------------------
// 4b. 3-way classification with manifest present
// -------------------------------------------------------

/** Write a template-manifest.json into the scratch project's state/ dir. */
function writeManifest(proj: string, files: Record<string, { sha256: string; plugin_version: string }>) {
  const stateDir = path.join(hermitDir(proj), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'template-manifest.json'), JSON.stringify({ version: 1, files }));
}

function writeRawManifest(proj: string, content: string) {
  const stateDir = path.join(hermitDir(proj), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'template-manifest.json'), content);
}

// Use real sha256 for fixtures — import the lib helper
import { sha256 } from '../scripts/lib/hash';

test('manifest: unmodified (on-disk == baseline, upstream changed) -> overwrite', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  const onDisk = 'OLD TEMPLATE\n';
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SHELL.md.template'), onDisk);
  // SESSION-REPORT identical to upstream -> excluded
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SESSION-REPORT.md.template'), 'REPORT TEMPLATE\n');
  // Manifest records the current on-disk hash as baseline (operator never touched it)
  writeManifest(proj, {
    'templates/SHELL.md.template': { sha256: sha256(Buffer.from(onDisk)), plugin_version: '1.1.5' },
  });
  const d = await runPlan(proj, 'local');
  expect(d.manifest_bootstrap).toBeUndefined();
  const shell = d.templates_changed.find((f: any) => f.name === 'SHELL.md.template');
  expect(shell).toBeDefined();
  expect(shell.class).toBe('unmodified');
}));

test('manifest: customized-kept (on-disk != baseline, upstream == baseline) -> kept', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  // Upstream template content (from the fake plugin root)
  const upstream = 'SHELL TEMPLATE V1\n';
  // Operator edited on-disk
  const onDisk = 'OPERATOR CUSTOMIZED\n';
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SHELL.md.template'), onDisk);
  // Manifest baseline == upstream (template hasn't changed since hatch)
  writeManifest(proj, {
    'templates/SHELL.md.template': { sha256: sha256(Buffer.from(upstream)), plugin_version: '1.1.6' },
  });
  const d = await runPlan(proj, 'local');
  const shell = d.templates_changed.find((f: any) => f.name === 'SHELL.md.template');
  expect(shell).toBeDefined();
  expect(shell.class).toBe('customized-kept');
}));

test('manifest: conflict (on-disk != baseline, upstream != baseline) -> conflict', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  const onDisk = 'OPERATOR EDIT\n';
  const originalBaseline = 'OLD TEMPLATE V0\n'; // neither upstream nor on-disk
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SHELL.md.template'), onDisk);
  writeManifest(proj, {
    'templates/SHELL.md.template': { sha256: sha256(Buffer.from(originalBaseline)), plugin_version: '1.1.0' },
  });
  const d = await runPlan(proj, 'local');
  const shell = d.templates_changed.find((f: any) => f.name === 'SHELL.md.template');
  expect(shell).toBeDefined();
  expect(shell.class).toBe('conflict');
}));

test('manifest: missing (on-disk absent) -> missing regardless of manifest', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'bin'), { recursive: true });
  // hermit-run absent -> class=missing, boot_critical=true
  writeManifest(proj, {
    'bin/hermit-run': { sha256: sha256(Buffer.from('OLD WRAPPER\n')), plugin_version: '1.1.6' },
  });
  const d = await runPlan(proj, 'local');
  const run = d.bin_changed.find((f: any) => f.name === 'hermit-run');
  expect(run).toBeDefined();
  expect(run.class).toBe('missing');
  expect(run.boot_critical).toBe(true);
}));

test('manifest-entry-absent: file on-disk but no manifest entry -> unmodified', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  // SHELL.md.template differs from upstream but has no manifest entry
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SHELL.md.template'), 'SOME CONTENT\n');
  writeManifest(proj, {}); // empty manifest (has entries for nothing)
  const d = await runPlan(proj, 'local');
  expect(d.manifest_bootstrap).toBeUndefined(); // manifest exists, just no entry
  const shell = d.templates_changed.find((f: any) => f.name === 'SHELL.md.template');
  expect(shell).toBeDefined();
  expect(shell.class).toBe('unmodified'); // no manifest entry -> seed-as-unmodified
}));

test('invalid manifest shape -> error before template/bin classification', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir(proj), 'bin'), { recursive: true });
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SHELL.md.template'), 'OPERATOR CUSTOMIZED\n');
  fs.writeFileSync(path.join(hermitDir(proj), 'bin', 'hermit-run'), '#!/bin/sh\necho customized\n');
  writeRawManifest(proj, '{"version":1}');

  const d = await runPlan(proj, 'local');
  expect(d.errors.map((e: any) => e.code)).toContain('manifest_invalid');
  expect(d.errors[0].message).toContain('files');
  expect(d.manifest_bootstrap).toBeUndefined();
  expect('templates_changed' in d).toBe(false);
  expect('bin_changed' in d).toBe(false);
}));

test('invalid manifest sha256 -> error before template/bin classification', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  writeRawManifest(proj, '{"version":1,"files":{"templates/SHELL.md.template":{"sha256":"abcdef"}}}');

  const d = await runPlan(proj, 'local');
  expect(d.errors.map((e: any) => e.code)).toContain('manifest_invalid');
  expect(d.errors[0].message).toContain('templates/SHELL.md.template');
  expect(d.manifest_bootstrap).toBeUndefined();
  expect('templates_changed' in d).toBe(false);
  expect('bin_changed' in d).toBe(false);
}));

// -------------------------------------------------------
// 5a. CLAUDE-APPEND identical (target has leading ---) -> not changed
// -------------------------------------------------------

test('CLAUDE-APPEND identical (modulo leading ---) -> changed=false, no old_block', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# My Project\n\nstuff\n\n---\n\n${MARKER}\n## Session Discipline\n\nbody line\n`);
  const d = await runPlan(proj, 'local');
  expect(d.claude_append_changed).toBe(false);
  // should omit old_block when unchanged
  expect('claude_append_old_block' in d).toBe(false);
}));

// -------------------------------------------------------
// 5b. CLAUDE-APPEND different -> changed + exact old_block
// -------------------------------------------------------

test('CLAUDE-APPEND different -> changed=true, old_block is exact marker-onward', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  const target = path.join(proj, 'CLAUDE.local.md');
  fs.writeFileSync(target,
    `# My Project\n\nstuff\n\n---\n\n${MARKER}\n## Session Discipline\n\nOLD body line\n`);
  const d = await runPlan(proj, 'local');
  expect(d.claude_append_changed).toBe(true);
  const ob: string = d.claude_append_old_block;
  expect(ob.startsWith(MARKER)).toBe(true);
  expect(ob).toContain('OLD body line');
  // must be an exact substring of the target file (so a targeted Edit will match)
  expect(fs.readFileSync(target, 'utf-8')).toContain(ob);
}));

// -------------------------------------------------------
// 5c. CLAUDE-APPEND marker absent -> changed (append case), no old_block
// -------------------------------------------------------

test('CLAUDE-APPEND marker absent -> changed=true (append), no old_block', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'), '# My Project\n\nno hermit block here\n');
  const d = await runPlan(proj, 'local');
  expect(d.claude_append_changed).toBe(true);
  // append case must omit old_block
  expect('claude_append_old_block' in d).toBe(false);
}));

// -------------------------------------------------------
// 6. no_config: missing config.json -> errors[no_config], no top-level error key
// -------------------------------------------------------

test('no_config: missing config.json -> errors[no_config], single contract', withProj(async (proj) => {
  const d = await runPlan(proj, 'local');
  const codes = d.errors.map((e: any) => e.code);
  expect(codes).toContain('no_config');
  // must not use a top-level error key
  expect('error' in d).toBe(false);
  // should not report a version when there is no config
  expect('from' in d).toBe(false);
}));

// -------------------------------------------------------
// 7. malformed config.json -> errors[config_json_invalid], not no_config
// -------------------------------------------------------

test('malformed config.json -> errors[config_json_invalid], not no_config', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":');
  const d = await runPlan(proj, 'local');
  const codes = d.errors.map((e: any) => e.code);
  expect(codes).toContain('config_json_invalid');
  expect(codes).not.toContain('no_config');
  // should not report a version when config is invalid
  expect('from' in d).toBe(false);
}));

// -------------------------------------------------------
// 8. missing _hermit_versions only -> from 0.0.0, clean errors
// -------------------------------------------------------

test('missing _hermit_versions -> from 0.0.0, errors empty', withProj(async (proj) => {
  writeConfig(proj, '{"model":"sonnet"}');
  const d = await runPlan(proj, 'local');
  expect(d.from).toBe('0.0.0');
  expect(d.errors).toEqual([]);
}));

// -------------------------------------------------------
// 9. Operator value preserved: present nested key (non-default) omitted
//    (script-level guard for idempotent Step 9 — never re-lists a set key)
// -------------------------------------------------------

test('operator value preserved: set quality_gate.tier not re-listed', withProj(async (proj) => {
  writeConfig(proj, `{
  "_hermit_versions": {"claude-code-hermit": "1.1.6"},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "quality_gate": {"tier": "balanced"},
  "heartbeat": {"enabled": true, "waiting_timeout": "30m"}
}
`);
  const d = await runPlan(proj, 'local');
  const paths = d.new_config_keys.map((k: any) => k.path);
  expect(paths).not.toContain('quality_gate');
  expect(paths).not.toContain('heartbeat.waiting_timeout');
}));

// -------------------------------------------------------
// 10. no_hatch_target: required flag missing -> errors[no_hatch_target]
// -------------------------------------------------------

test('no_hatch_target: missing flag -> errors[no_hatch_target], exit 0', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  const d = await runPlan(proj); // no --hatch-target flag (runPlan asserts exit 0)
  const codes = d.errors.map((e: any) => e.code);
  expect(codes).toContain('no_hatch_target');
}));

// -------------------------------------------------------
// 11. Docker template drift — F1 (entrypoint, manifest-managed) + F2 (report-only)
// -------------------------------------------------------

const deployDocker = (proj: string, f: { entrypoint?: string; compose?: string; dockerfile?: string }) => {
  if (f.entrypoint !== undefined) fs.writeFileSync(path.join(proj, 'docker-entrypoint.hermit.sh'), f.entrypoint);
  if (f.compose !== undefined) fs.writeFileSync(path.join(proj, 'docker-compose.hermit.yml'), f.compose);
  if (f.dockerfile !== undefined) fs.writeFileSync(path.join(proj, 'Dockerfile.hermit'), f.dockerfile);
};
const dockerManifest = (proj: string, hashes: Record<string, string>) =>
  writeManifest(proj, Object.fromEntries(
    Object.entries(hashes).map(([k, v]) => [k, { sha256: v, plugin_version: '1.1.6' }])));

test('docker: no deployment -> entrypoint null, templates empty', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  const d = await runPlan(proj, 'local');
  expect(d.docker_entrypoint).toBeNull();
  expect(d.docker_templates).toEqual([]);
}));

test('docker bootstrap (no manifest): entrypoint unmodified, templates unknown', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  deployDocker(proj, { entrypoint: 'ENTRYPOINT OLD\n', compose: 'rendered\n', dockerfile: 'rendered\n' });
  const d = await runPlan(proj, 'local');
  expect(d.manifest_bootstrap).toBe(true);
  expect(d.docker_entrypoint.class).toBe('unmodified');
  expect(d.docker_entrypoint.boot_critical).toBe(true);
  const statuses = Object.fromEntries(d.docker_templates.map((t: any) => [t.name, t.status]));
  expect(statuses['docker-compose.hermit.yml']).toBe('unknown');
  expect(statuses['Dockerfile.hermit']).toBe('unknown');
}));

test('docker with manifest: compose match omitted, stale Dockerfile -> changed, identical entrypoint -> null', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  deployDocker(proj, { entrypoint: 'ENTRYPOINT UPSTREAM\n', compose: 'rendered\n', dockerfile: 'rendered\n' });
  dockerManifest(proj, {
    'docker/docker-compose.hermit.yml.template': sha256(Buffer.from('COMPOSE UPSTREAM {{X}}\n')),
    'docker/Dockerfile.hermit.template': sha256(Buffer.from('DOCKERFILE OLD {{Y}}\n')), // stale baseline
  });
  const d = await runPlan(proj, 'local');
  expect(d.docker_entrypoint).toBeNull(); // on-disk identical to upstream
  const names = d.docker_templates.map((t: any) => t.name);
  expect(names).not.toContain('docker-compose.hermit.yml'); // upstream unchanged -> omitted
  expect(d.docker_templates).toContainEqual({ name: 'Dockerfile.hermit', status: 'changed' });
}));

test('docker entrypoint per-file bootstrap: manifest present but NO docker key + customized entrypoint -> unmodified + bootstrap (forces .bak)', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  deployDocker(proj, { entrypoint: 'ENTRYPOINT OPERATOR EDIT\n' }); // differs from upstream
  // Manifest exists (templates key) but has NO docker/ entrypoint baseline — the
  // exact data-loss scenario: an existing operator who never re-ran /docker-setup.
  dockerManifest(proj, { 'templates/SHELL.md.template': sha256(Buffer.from('x')) });
  const d = await runPlan(proj, 'local');
  expect(d.manifest_bootstrap).toBeUndefined(); // global bootstrap is FALSE (manifest present)
  expect(d.docker_entrypoint.class).toBe('unmodified');
  expect(d.docker_entrypoint.bootstrap).toBe(true); // -> Step 5c writes a recovery .bak
}));

test('docker entrypoint conflict: operator edited AND upstream moved', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  deployDocker(proj, { entrypoint: 'ENTRYPOINT OPERATOR EDIT\n' });
  dockerManifest(proj, { 'docker/docker-entrypoint.hermit.sh': sha256(Buffer.from('ENTRYPOINT BASELINE\n')) });
  const d = await runPlan(proj, 'local');
  expect(d.docker_entrypoint.class).toBe('conflict');
  expect(d.docker_entrypoint.boot_critical).toBe(true);
  expect(d.docker_entrypoint.bootstrap).toBeUndefined(); // baseline present -> not a bootstrap
}));

// -------------------------------------------------------
// 12. Sibling hermit plans — registry-driven from _hermit_versions
// -------------------------------------------------------

/** Write a plugin-list fixture JSON to a temp file and return its path. */
function writePluginList(entries: any[]): string {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-pl-')) + '/list.json';
  fs.writeFileSync(p, JSON.stringify(entries, null, 2));
  return p;
}

/** Build a plugin-list entry pointing sibling installPath to SP. */
function siblingEntry(projectPath: string, opts: { scope?: string; enabled?: boolean; name?: string } = {}): any {
  return {
    id: `${opts.name ?? 'claude-code-dev-hermit'}@claude-code-hermit`,
    version: '0.4.3',
    scope: opts.scope ?? 'local',
    enabled: opts.enabled ?? true,
    installPath: SP,
    projectPath,
  };
}

test('sibling with gap: siblings[] entry has up_to_date=false and changelog_slice', withProj(async (proj) => {
  // sibling registered at 0.4.1; installed at 0.4.3 -> gap
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.7', 'claude-code-dev-hermit': '0.4.1' },
  }));
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  expect(d.errors).toEqual([]);
  expect(d.siblings).toHaveLength(1);
  const s = d.siblings[0];
  expect(s.name).toBe('claude-code-dev-hermit');
  expect(s.from).toBe('0.4.1');
  expect(s.to).toBe('0.4.3');
  expect(s.up_to_date).toBe(false);
  expect(s.changelog_slice).toContain('sibling fix C');
  expect(s.changelog_slice).toContain('sibling add B');
  expect(s.changelog_slice).not.toContain('initial sibling release'); // 0.4.0 excluded (from=0.4.1)
  expect(d.work_pending).toBe(true); // sibling has gap -> work_pending=true even when core is up_to_date
}));

// Note: the assertion above already covers the Finding 2 regression.
// work_pending must be true when a sibling has a gap, even if core is up_to_date.
test('REGRESSION Finding 2: core current + sibling behind -> work_pending=true', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.7', 'claude-code-dev-hermit': '0.4.1' },
  }));
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  expect(d.up_to_date).toBe(true);         // core is current
  expect(d.siblings[0].up_to_date).toBe(false); // sibling is not
  expect(d.work_pending).toBe(true);        // must be true so skill does NOT short-circuit
}));

test('sibling no-gap: up_to_date=true, no changelog_slice, work_pending reflects core', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.6', 'claude-code-dev-hermit': '0.4.3' },
  }));
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  const s = d.siblings[0];
  expect(s.up_to_date).toBe(true);
  expect('changelog_slice' in s).toBe(false);
  // core has a gap (1.1.6 < 1.1.7), so work_pending stays true
  expect(d.work_pending).toBe(true);
}));

test('no-gap + changed CLAUDE-APPEND block -> claude_append_changed=true, no Edit intent implied', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.7', 'claude-code-dev-hermit': '0.4.3' },
  }));
  // Write a stale sibling block in the target CLAUDE.local.md
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# Project\n\n---\n\n${SIBLING_MARKER}\n## Dev Workflow\n\nSTALE dev body\n`);
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  const s = d.siblings[0];
  expect(s.up_to_date).toBe(true);             // no version gap
  expect(s.claude_append_changed).toBe(true);  // but block is stale
  // old_block is present so the skill can report what drifted (advisory only, no Edit for no-gap)
  expect(s.claude_append_old_block).toContain('STALE dev body');
  expect(d.work_pending).toBe(true);           // drift alone triggers work_pending
}));

test('gap + changed CLAUDE-APPEND block -> both up_to_date=false and claude_append_changed=true', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.7', 'claude-code-dev-hermit': '0.4.1' },
  }));
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# Project\n\n---\n\n${SIBLING_MARKER}\n## Dev Workflow\n\nOLD dev body\n`);
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  const s = d.siblings[0];
  expect(s.up_to_date).toBe(false);
  expect(s.claude_append_changed).toBe(true);
  expect(s.claude_append_old_block).toContain('OLD dev body');
}));

test('siblings_path_unresolved: registered sibling not found in plugin list', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.7', 'claude-code-dev-hermit': '0.4.1' },
  }));
  // Empty plugin list -> sibling can't be path-resolved
  const d = await runPlan(proj, 'local');
  expect(d.siblings).toHaveLength(0);
  expect(d.siblings_path_unresolved).toContain('claude-code-dev-hermit');
}));

test('siblings_detected_unregistered: project-effective hermit not in _hermit_versions', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.7' },
  }));
  // Plugin list has a hermit entry for this project, but it's not in _hermit_versions
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  expect(d.siblings).toHaveLength(0); // not in registry -> not in siblings[]
  expect(d.siblings_detected_unregistered).toContain('claude-code-dev-hermit');
}));

test('leak guard: duplicate hermit names in plugin list — only project-effective entry selected', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.7', 'claude-code-dev-hermit': '0.4.1' },
  }));
  // Two entries for the same sibling: one for this project, one for another project.
  const otherProjectPath = '/tmp/other-project-entirely';
  const otherSP = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-other-sp-'));
  try {
    fs.mkdirSync(path.join(otherSP, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(otherSP, '.claude-plugin', 'plugin.json'), '{"version":"9.9.9"}\n');
    const pl = writePluginList([
      { id: 'claude-code-dev-hermit@claude-code-hermit', version: '9.9.9', scope: 'local', enabled: true, installPath: otherSP, projectPath: otherProjectPath },
      siblingEntry(proj), // project-effective entry for this project at SP (v0.4.3)
    ]);
    const d = await runPlan(proj, 'local', pl);
    expect(d.siblings).toHaveLength(1);
    expect(d.siblings[0].install_path).toBe(SP);  // selected THIS project's entry
    expect(d.siblings[0].to).toBe('0.4.3');       // NOT 9.9.9 from the other project
  } finally {
    try { fs.rmSync(otherSP, { recursive: true, force: true }); } catch {}
  }
}));

test('leak guard: scope precedence — project scope wins over local when both match', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.7', 'claude-code-dev-hermit': '0.4.1' },
  }));
  // Two entries for same sibling at same projectPath: one local, one project scope.
  // Project scope should win (and SP is at 0.4.3).
  const localSP = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-local-sp-'));
  try {
    fs.mkdirSync(path.join(localSP, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(localSP, '.claude-plugin', 'plugin.json'), '{"version":"0.4.2"}\n');
    const pl = writePluginList([
      { id: 'claude-code-dev-hermit@claude-code-hermit', version: '0.4.2', scope: 'local', enabled: true, installPath: localSP, projectPath: proj },
      { id: 'claude-code-dev-hermit@claude-code-hermit', version: '0.4.3', scope: 'project', enabled: true, installPath: SP, projectPath: proj },
    ]);
    const d = await runPlan(proj, 'local', pl);
    expect(d.siblings[0].install_path).toBe(SP);
    expect(d.siblings[0].to).toBe('0.4.3');
  } finally {
    try { fs.rmSync(localSP, { recursive: true, force: true }); } catch {}
  }
}));

test('invalid --plugin-list-json: siblings empty, siblings_warnings set, core proceeds', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.6', 'claude-code-dev-hermit': '0.4.1' },
  }));
  const badPath = path.join(os.tmpdir(), 'hermit-bad-pl-' + Date.now() + '.json');
  fs.writeFileSync(badPath, 'NOT JSON {{');
  try {
    const d = await runPlan(proj, 'local', badPath);
    expect(d.errors).toEqual([]); // core errors must be clean
    expect(d.siblings).toHaveLength(0); // sibling resolution skipped
    expect(d.siblings_warnings).toBeDefined();
    expect(d.siblings_warnings[0]).toContain('plugin-list unavailable');
    // Core analysis still ran
    expect(d.from).toBe('1.1.6');
    expect(d.up_to_date).toBe(false);
  } finally {
    try { fs.rmSync(badPath); } catch {}
  }
}));

test('from > to (downgrade): treated as no-gap, warning emitted', withProj(async (proj) => {
  // Config claims 0.4.5 but installed is 0.4.3 — a rollback scenario.
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.7', 'claude-code-dev-hermit': '0.4.5' },
  }));
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  const s = d.siblings[0];
  expect(s.up_to_date).toBe(true);   // from(0.4.5) > to(0.4.3) -> no bump
  expect('changelog_slice' in s).toBe(false);
  expect(d.siblings_warnings?.some((w: string) => w.includes('downgrade'))).toBe(true);
}));

test('work_pending: all current + no drift -> false', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.1.7', 'claude-code-dev-hermit': '0.4.3' },
  }));
  // Write correct sibling block so drift=false
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# Project\n\n---\n\n${SIBLING_MARKER}\n## Dev Workflow\n\ndev body line\n`);
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  expect(d.up_to_date).toBe(true);
  expect(d.siblings[0].up_to_date).toBe(true);
  expect(d.siblings[0].claude_append_changed).toBe(false);
  expect(d.work_pending).toBe(false);
}));
