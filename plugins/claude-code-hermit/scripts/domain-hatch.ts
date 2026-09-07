#!/usr/bin/env bun
// domain-hatch.ts — the shared protocol every domain hatch runs, over
// lib/domain-hatch/.
//
// Reached from a domain plugin as:
//   .claude-code-hermit/bin/hermit-run domain-hatch <verb> <plugin-id> [args]
// A domain plugin's own ${CLAUDE_PLUGIN_ROOT} is
// <cache>/<marketplace>/<plugin>/<version>/ and cannot resolve core's, so the
// project-resident bin/hermit-run dispatcher is the route in.
//
// Usage:
//   bun domain-hatch.ts preflight <plugin-id>
//     Read-only. Prints one JSON verdict: which of the two stale-core cases
//     applies (if any), whether this is a full run or a re-verify, the resolved
//     CLAUDE target, and what the CLAUDE-APPEND block needs. Every resolution
//     outcome exits 0 — including a failure, which comes back as
//     `{ok:false,error,message}` with no `action`, because callers read the
//     fields, not the code. The argv checks below are the one exception: they
//     reject a malformed invocation before preflight runs, exiting 1 on the
//     same `{ok:false,error,message}` shape every domain hatch already has a
//     "relay `message` and stop" branch for.
//
//   bun domain-hatch.ts ensure-target <plugin-id> --target <local|committed>
//     Creates or repairs state/hatch-options.json. Core owns this file; the
//     verb exists so domain hatches stop carrying their own copy of the
//     detection and stamping rules.
//
//   bun domain-hatch.ts sync-block <plugin-id> [--rendered-stdin]
//     Appends the plugin's CLAUDE-APPEND block when absent, replaces it only
//     when rendered content is piped in and differs, refuses on a duplicated
//     marker. Version-driven refresh stays hermit-evolve's.
//
// stateDir/projectRoot are always derived from hermitDir(), never argv: this
// script is reachable through a pre-approved
// `Bash(.claude-code-hermit/bin/hermit-run domain-hatch <verb> *)` grant that
// covers every argument, so a `--state-dir`/`--project-root` override would
// have let one such call point ensure-target/sync-block at another project's
// state or CLAUDE.md. The plugin list is always live for the same reason: a
// forged list (the removed `--plugin-list-file` test seam) steers
// resolvePlugin() -> installPath -> planBlock(), which reads the CLAUDE-APPEND
// block from that path and writes it into the operator's CLAUDE.md — a forged
// list is attacker-authored content landing in the file that steers the agent.
// Tests exercise this at the library boundary (lib/domain-hatch/*) with
// explicit roots instead of shelling out to this CLI with overrides.
//
// Every verb's argv beyond <plugin-id> is allow-listed below; anything else
// exits 1 with `unexpected_args` rather than being silently ignored.
//
// Verb dispatch is lazy: preflight is the hot path (every hatch run, including
// the re-verify that changes nothing) and has no business loading the block
// writer to do its job.
//
// Mutating verbs exit 1 on failure, matching micro-proposal.ts /
// apply-settings.ts / hatch-config.ts. preflight is inspection and exits 0.

import path from 'node:path';
import { hermitDir } from './lib/cc-compat';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + '\n');
}

function die(code: string, message: string): never {
  out({ ok: false, error: code, message });
  process.exit(1);
}

const argv = process.argv.slice(2);
const verb = argv[0];
const pluginId = argv[1];
const rest = argv.slice(2);

if (!verb || !pluginId) {
  process.stderr.write('Usage: domain-hatch.ts <preflight|ensure-target|sync-block> <plugin-id> [args]\n');
  process.exit(1);
}

// A plugin id is a bare plugin name — reject anything that could be read as a
// path. hermit-exec.sh checks the script name but forwards the rest of argv
// untouched, so this is the only place the identity argument is validated.
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginId)) {
  die('invalid_plugin_id', `not a plugin id: ${pluginId}`);
}

const stateDir = hermitDir();
const projectRoot = path.resolve(stateDir, '..');

async function readStdinIfFlagged(flag: string): Promise<string | undefined> {
  if (!argv.includes(flag)) return undefined;
  let buf = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

if (verb === 'preflight') {
  if (rest.length) die('unexpected_args', `preflight takes no args beyond <plugin-id>: ${rest.join(' ')}`);
  const { preflight } = await import('./lib/domain-hatch/preflight');
  out(preflight({ pluginId, hermitDir: stateDir, projectRoot, corePluginRoot: PLUGIN_ROOT }));
  process.exit(0);
}

if (verb === 'ensure-target') {
  if (rest.length !== 2 || rest[0] !== '--target') {
    die('unexpected_args', `ensure-target takes exactly --target <local|committed>: ${rest.join(' ')}`);
  }
  const target = rest[1];
  if (target !== 'local' && target !== 'committed') {
    die('bad_target', '--target must be local or committed');
  }
  const [{ ensureHatchTarget }, { resolvePlugin, isResolveError, pluginList }, { coreScope }] = await Promise.all([
    import('./lib/domain-hatch/target'),
    import('./lib/domain-hatch/resolve'),
    import('./resolve-siblings'),
  ]);
  const list = pluginList();
  // The only thing this verb takes from the resolution is a version string for
  // the stamp, and that already has a fallback. Failing the whole write when
  // `claude plugin list` cannot be read would leave hatch-options.json
  // unwritten and every later consumer re-asking the Visibility question — a
  // far worse outcome than a `0.0.0` stamp. The plugin id is regex-validated
  // above and only ever lands in core's own state dir as a string field.
  const resolved = resolvePlugin(list, pluginId, projectRoot);
  const unresolved = isResolveError(resolved);
  const scope = coreScope(list as any, projectRoot);
  const res = ensureHatchTarget(stateDir, {
    target,
    core_scope: scope.core_scope,
    stampedBy: `${pluginId}:hatch`,
    version: unresolved ? '0.0.0' : (resolved.version ?? '0.0.0'),
  });
  out(unresolved ? { ...res, resolve_warning: resolved.message } : res);
  process.exit(res.ok ? 0 : 1);
}

if (verb === 'sync-block') {
  if (rest.length && rest.join(' ') !== '--rendered-stdin') {
    die('unexpected_args', `sync-block takes only an optional --rendered-stdin: ${rest.join(' ')}`);
  }
  const [{ planBlock, applyBlock, splitResident, planResidentRemoval }, { readTargetState, targetFile }, { resolvePlugin, isResolveError, pluginList }, { coreScope }] =
    await Promise.all([
      import('./lib/domain-hatch/block'),
      import('./lib/domain-hatch/target'),
      import('./lib/domain-hatch/resolve'),
      import('./resolve-siblings'),
    ]);
  const list = pluginList();
  const resolved = resolvePlugin(list, pluginId, projectRoot);
  if (isResolveError(resolved)) die(resolved.error, resolved.message);

  const state = readTargetState(stateDir, coreScope(list as any, projectRoot), projectRoot);
  if (!state.target) {
    die('no_target', 'hatch-options.json has no usable target; run ensure-target first');
  }

  const rendered = await readStdinIfFlagged('--rendered-stdin');
  const foreign = list
    .map((e: any) => String(e?.id ?? '').split('@')[0])
    .filter((n: string) => n && n !== pluginId);

  const target = path.join(projectRoot, targetFile(state.target));
  const original = planBlock(resolved.installPath, pluginId, target, foreign, rendered);
  if (['no-template', 'no-marker', 'needs-rendering', 'ambiguous'].includes(original.action)) {
    const result = applyBlock(original);
    out(result);
    process.exit(1);
  }
  const template = rendered ?? await Bun.file(path.join(resolved.installPath, 'state-templates', 'CLAUDE-APPEND.md')).text();
  const split = splitResident(template);
  const shared = planBlock(resolved.installPath, pluginId, target, foreign, split.shared, rendered !== undefined);
  const residentPath = path.join(stateDir, 'RESIDENT.md');
  const resident = split.resident
    ? planBlock(resolved.installPath, pluginId, residentPath, foreign, split.resident, rendered !== undefined)
    : planResidentRemoval(original, residentPath, foreign);
  if (resident.action === 'ambiguous') {
    out({ ...applyBlock(resident), resident: resident.action });
    process.exit(1);
  }
  const result = applyBlock(shared);
  const residentResult = applyBlock(resident);
  // `written` covers both files: a run that only refreshed RESIDENT.md is still a
  // write, and reporting the shared block's `false` would read as "nothing changed".
  out({
    ...result,
    ok: result.ok && residentResult.ok,
    written: result.written || residentResult.written,
    resident: residentResult.action,
  });
  process.exit(result.ok && residentResult.ok ? 0 : 1);
}

process.stderr.write(`domain-hatch.ts: unknown verb "${verb}"\n`);
process.exit(1);
