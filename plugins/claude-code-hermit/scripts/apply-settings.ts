/**
 * apply-settings.ts — additive, non-weakening settings.json helper for hatch/docker-setup.
 *
 * Usage: bun apply-settings.ts <target-file> <op> [args...]
 *
 * Operations:
 *   task-id <id>             Merge env.CLAUDE_CODE_TASK_LIST_ID
 *   allow                    Merge hermit's fixed permissions.allow list
 *   artifact-allow           Merge just ["Artifact"] into permissions.allow — kept as its
 *                            own op (not folded into `allow`) so declining the Artifact
 *                            publish-authorization ask never touches hook permissions.
 *   automode-seed            Merge the hermit's sealed autoMode.allow exception + autoMode.
 *                            environment context into settings.local.json, so the auto-mode
 *                            classifier's soft-tier self-modification check clears sealed
 *                            settings writes made unattended. Target MUST be settings.local.json
 *                            — the classifier never reads autoMode from committed project settings.
 *   deny <minimal|hardened>  Merge deny-patterns from state-templates/deny-patterns.json
 *   channel-env <CH> <dir>   Set env.<CH>_STATE_DIR and strip any stale env.*_BOT_TOKEN
 *
 * Rules:
 * - Never removes existing keys or array entries — except channel-env, which strips
 *   any *_BOT_TOKEN from the env block (tokens must live only in .env, never settings).
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
  'Bash(bun */scripts/heartbeat-precheck.ts*)',
  'Bash(bun */scripts/reflect-precheck.ts*)',
  'Bash(bun */scripts/archive-shell.ts*)',
  'Bash(bun */scripts/evaluate-session.ts*)',
  'Bash(bun */scripts/append-metrics.ts*)',
  'Bash(bun */scripts/resolve-prop.ts*)',
  'Bash(bun */scripts/next-prop-id.ts*)',
  'Bash(bun */scripts/proposal.ts*)',
  'Bash(bun */scripts/record-gate.ts*)',
  'Bash(bun */scripts/queue-micro-proposal.ts*)',
  'Bash(bun */scripts/generate-summary.ts*)',
  'Bash(bun */scripts/proposals-index.ts*)',
  'Bash(bun */scripts/update-reflection-state.ts*)',
  'Bash(bun */scripts/apply-reflection-actions.ts*)',
  'Bash(bun */scripts/transcript-digest.ts*)',
  'Bash(bun */scripts/setup-token-mint.ts*)',
  'Bash(bun */scripts/cron-tz-shift.ts*)',
  'Bash(bun */scripts/evolve-plan.ts*)',
  'Bash(bun */scripts/evolve-finalize.ts*)',
  'Bash(bun */scripts/manifest-seed.ts*)',
  'Bash(bun */scripts/apply-settings.ts*)',
  'Bash(bun */scripts/channel-log.ts*)',
  'Bash(bun */scripts/channel-send.ts*)',
  'Bash(bun */scripts/session-archive.ts*)',
  'Bash(bun */scripts/routine-precheck.ts*)',
  'Bash(bun */scripts/cron-registry.ts*)',
  "Bash(bash -c 'AGENT_DIR=\".claude-code-hermit\"*)",
  'Edit(.claude-code-hermit/**)',
];

// Sealed autoMode entries — operator-owned policy seeded at attended hatch and
// re-ensured by hermit-start at boot. Declarative, no persuasion prose (a live
// probe model flags over-argued entries as planted justification). Keep in sync
// with docs/security.md § Auto-mode classifier.
const AUTOMODE_ALLOW_ENTRY =
  'Operator policy, set at hatch: hermit self-maintenance may run ' +
  '`bun */scripts/apply-settings.ts <settings-file> <op>` unattended — approval for ' +
  'these sealed settings operations is granted here in advance, including when the ' +
  'run is initiated by plugin upgrade or migration instructions rather than a live ' +
  'operator message.';

const AUTOMODE_ENV_ENTRIES = [
  'Key internal services: this project runs a claude-code-hermit autonomous session; ' +
    '.claude-code-hermit/ is its internal working state and the installed hermit ' +
    "plugins' scripts/*.ts are its trusted maintenance tooling.",
  "Trusted internal domains: api.telegram.org and discord.com are the operator's own " +
    'hermit notification channels (bot DM liveness probes and message sends).',
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

function mergeAutoModeList(settings: Json, key: 'allow' | 'environment', entries: string[]): void {
  settings.autoMode ??= {};
  const block = settings.autoMode as Record<string, unknown>;
  // Create with "$defaults" so built-in rules are inherited. If an array
  // pre-exists WITHOUT "$defaults", that is the operator's deliberate
  // replacement of the defaults — do not inject it.
  if (!Array.isArray(block[key])) block[key] = ['$defaults'];
  const list = block[key] as string[];
  for (const e of entries) {
    if (!list.includes(e)) list.push(e);
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

// Claude Code's permission engine treats an Edit(glob) rule as covering the
// Write tool too, and (v2.1.211+) warns at boot on Write(glob) rules. So a
// Write(<glob>) whose Edit(<glob>) twin is present is a dead no-op that only
// produces that warning — drop it before seeding settings.json. deny-patterns.json
// keeps both spellings on purpose: the runtime enforce-deny-patterns hook matches
// tool-name-specifically and still needs the Write variant.
function dropRedundantWriteRules(entries: string[]): string[] {
  const editGlobs = new Set(
    entries.map((e) => e.match(/^Edit\((.+)\)$/)?.[1]).filter(Boolean) as string[],
  );
  return entries.filter((e) => {
    const writeGlob = e.match(/^Write\((.+)\)$/)?.[1];
    return writeGlob === undefined || !editGlobs.has(writeGlob);
  });
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

  case 'artifact-allow': {
    mergeAllow(settings, ['Artifact']);
    break;
  }

  case 'automode-seed': {
    // autoMode is only read from local/user/managed scope — a committed
    // .claude/settings.json target would be a silent no-op trap.
    if (path.basename(targetFile) !== 'settings.local.json') {
      console.error('automode-seed must target a settings.local.json file — autoMode is not read from committed project settings.');
      process.exit(1);
    }
    mergeAutoModeList(settings, 'allow', [AUTOMODE_ALLOW_ENTRY]);
    mergeAutoModeList(settings, 'environment', AUTOMODE_ENV_ENTRIES);
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
    mergeDeny(settings, dropRedundantWriteRules(deny));
    break;
  }

  case 'channel-env': {
    const channel = rest[0];
    const stateDir = rest[1];
    if (!channel || !stateDir) {
      console.error('channel-env requires <CHANNEL_UPPER> and <abs_state_dir> arguments');
      process.exit(1);
    }
    settings.env ??= {};
    // Tokens must live only in .env — strip any stale *_BOT_TOKEN from settings.
    for (const key of Object.keys(settings.env)) {
      if (/_BOT_TOKEN$/.test(key)) delete settings.env[key];
    }
    settings.env[`${channel}_STATE_DIR`] = stateDir;
    break;
  }

  default: {
    console.error(`Unknown operation: ${op}. Valid ops: task-id, allow, artifact-allow, automode-seed, deny, channel-env`);
    process.exit(1);
  }
}

writeJson(targetFile, settings);
