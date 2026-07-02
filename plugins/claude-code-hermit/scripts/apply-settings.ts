/**
 * apply-settings.ts — additive, non-weakening settings.json helper for hatch/docker-setup.
 *
 * Usage: bun apply-settings.ts <target-file> <op> [args...]
 *
 * Operations:
 *   task-id <id>             Merge env.CLAUDE_CODE_TASK_LIST_ID
 *   allow                    Merge hermit's fixed permissions.allow list
 *   deny <minimal|hardened>  Merge deny-patterns from state-templates/deny-patterns.json
 *   sandbox <standard|off>   Merge sandbox profile from state-templates/sandbox-profiles.json
 *
 * Rules:
 * - Never removes existing keys or array entries.
 * - Permission sets are read from state-templates — callers cannot inject arbitrary JSON.
 * - Safe to call under AGENT_HOOK_PROFILE=strict: writes via fs, not the Edit/Write tools.
 */

import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');

// Fixed allow-list — sealed here; cannot be extended by callers.
// Keep in sync with the "Required permissions" list in skills/hatch/SKILL.md Step 8.
const HERMIT_ALLOW = [
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(bun */scripts/cost-tracker.ts*)',
  'Bash(bun */scripts/suggest-compact.ts*)',
  'Bash(bun */scripts/heartbeat-precheck.ts*)',
  'Bash(bun */scripts/reflect-precheck.ts*)',
  'Bash(bun */scripts/archive-shell.ts*)',
  'Bash(bun */scripts/run-with-profile.ts*)',
  'Bash(bun */scripts/evaluate-session.ts*)',
  'Bash(bun */scripts/append-metrics.ts*)',
  'Bash(bun */scripts/generate-summary.ts*)',
  'Bash(bun */scripts/update-reflection-state.ts*)',
  'Bash(bun */scripts/cron-tz-shift.ts*)',
  'Bash(bun */scripts/evolve-plan.ts*)',
  'Bash(bun */scripts/evolve-finalize.ts*)',
  'Bash(bun */scripts/manifest-seed.ts*)',
  'Bash(bun */scripts/apply-settings.ts*)',
  'Bash(bun */scripts/channel-log.ts*)',
  "Bash(bash -c 'AGENT_DIR=\".claude-code-hermit\"*)",
  'Edit(.claude-code-hermit/**)',
  'Write(.claude-code-hermit/**)',
];

// Hardened extras — a subset of always_on patterns safe to persist to settings.
// Excludes docker/kubectl/ssh: valid in devops contexts on the host; hook-enforced at runtime.
// Matches what hatch Step 9 "hardened" option produces.
const HARDENED_DENY_EXTRAS = [
  'Bash(npm publish*)',
  'Bash(git push --force*)',
  'Bash(git push origin main*)',
  'Bash(git reset --hard*)',
  'Bash(*--no-verify*)',
];

type Json = any;

function readJson(filePath: string): Json {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

// Strict read for the operator's target settings file: an existing-but-malformed
// file must abort, never fall through to {} — otherwise the additive merge below
// would overwrite the whole file with only hermit's subset, silently discarding
// the operator's settings.
function readTargetJson(filePath: string): Json {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(
      `Refusing to overwrite ${filePath}: file exists but is not valid JSON ` +
        `(${(err as Error).message}). Fix or remove it, then re-run.`,
    );
    process.exit(1);
  }
}

function writeJson(filePath: string, data: Json): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function mergeAllow(settings: Json, entries: string[]): void {
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  const existing = new Set<string>(settings.permissions.allow);
  for (const e of entries) {
    if (!existing.has(e)) settings.permissions.allow.push(e);
  }
}

function mergeDeny(settings: Json, entries: string[]): void {
  settings.permissions ??= {};
  settings.permissions.deny ??= [];
  const existing = new Set<string>(settings.permissions.deny);
  for (const e of entries) {
    if (!existing.has(e)) settings.permissions.deny.push(e);
  }
}

function mergeSandbox(settings: Json, profile: Json): void {
  settings.sandbox ??= {};
  // Never overwrite operator-intent keys that are already set.
  const OPERATOR_KEYS = new Set([
    'enabled', 'filesystem', 'network',
    'failIfUnavailable', 'autoAllowBashIfSandboxed', 'allowUnsandboxedCommands',
  ]);
  for (const [k, v] of Object.entries(profile)) {
    if (OPERATOR_KEYS.has(k) && settings.sandbox[k] !== undefined) continue;
    settings.sandbox[k] = v;
  }
}

const [, , targetFile, op, ...rest] = process.argv;

if (!targetFile || !op) {
  console.error('Usage: apply-settings.ts <target-file> <op> [args...]');
  process.exit(1);
}

const settings = readTargetJson(targetFile);

switch (op) {
  case 'task-id': {
    const id = rest[0];
    if (!id) { console.error('task-id requires an id argument'); process.exit(1); }
    settings.env ??= {};
    settings.env['CLAUDE_CODE_TASK_LIST_ID'] = id;
    break;
  }

  case 'allow': {
    mergeAllow(settings, HERMIT_ALLOW);
    break;
  }

  case 'deny': {
    const profile = rest[0];
    if (profile !== 'minimal' && profile !== 'hardened') {
      console.error(`deny requires 'minimal' or 'hardened', got: ${profile ?? '(none)'}`);
      process.exit(1);
    }
    const patternsFile = path.join(PLUGIN_ROOT, 'state-templates', 'deny-patterns.json');
    const patterns = readJson(patternsFile);
    const deny = [
      ...(patterns.default ?? []),
      ...(profile === 'hardened' ? HARDENED_DENY_EXTRAS : []),
    ];
    mergeDeny(settings, deny);
    break;
  }

  case 'sandbox': {
    const profileName = rest[0];
    if (profileName !== 'standard' && profileName !== 'off') {
      console.error(`sandbox requires 'standard' or 'off', got: ${profileName ?? '(none)'}`);
      process.exit(1);
    }
    const profilesFile = path.join(PLUGIN_ROOT, 'state-templates', 'sandbox-profiles.json');
    const profiles = readJson(profilesFile);
    const profile: Json = { ...profiles[profileName] };
    if (!profile || Object.keys(profile).length === 0) {
      console.error(`sandbox profile '${profileName}' not found in ${profilesFile}`);
      process.exit(1);
    }
    // For 'standard', merge filesystem.denyRead from deny-patterns.json
    if (profileName === 'standard') {
      const patternsFile = path.join(PLUGIN_ROOT, 'state-templates', 'deny-patterns.json');
      const patterns = readJson(patternsFile);
      const denyRead = patterns.sandbox?.filesystem?.denyRead;
      if (denyRead) profile.filesystem = { denyRead };
    }
    mergeSandbox(settings, profile);
    break;
  }

  default: {
    console.error(`Unknown operation: ${op}. Valid ops: task-id, allow, deny, sandbox`);
    process.exit(1);
  }
}

writeJson(targetFile, settings);
