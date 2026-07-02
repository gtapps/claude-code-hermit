#!/usr/bin/env bun
/**
 * Deterministic config.json assembly for /hatch Step 5.
 *
 * Step 5 is otherwise a ~40-line hand-assembly algorithm the LLM follows to merge
 * state-templates/config.json.template with wizard answers — the last hand-transcription
 * surface on hatch. This collapses it into one deterministic call: the wizard still owns
 * every AskUserQuestion, but the template->config transform is code, not prose the model
 * re-derives every run.
 *
 * Usage: bun hatch-config.ts <PROJECT_ROOT> [--reinit]   (answers JSON on stdin)
 *
 * Fresh (no --reinit): base = state-templates/config.json.template. Substitutes
 * {project_name}, then overlays answers.
 *
 * Re-init (--reinit): base = the EXISTING .claude-code-hermit/config.json (strict read —
 * malformed JSON refuses without touching the file). This is what makes re-init
 * non-destructive: any key the overlay steps below don't touch (custom operator keys,
 * push_notifications, docker settings, monitors, ...) survives untouched because it was
 * never cleared to begin with.
 *
 * _hermit_versions: the core version is read from THIS script's own plugin.json, never
 * from the answers payload — an operator-supplied version could otherwise advance
 * `_hermit_versions["claude-code-hermit"]` on re-init and erase the upgrade gap
 * hermit-evolve's evolve-plan.ts reads to discover pending migrations. Every entry
 * (core + any activated sibling) is stamped add-if-absent, never bumped — mirrors
 * evolve-finalize.ts's sibling-version contract.
 *
 * Validation: this script does not re-implement answer validation. It overlays by
 * presence (Object.hasOwn, never truthiness, so `remote:false`/`null` apply) and lets
 * the imported validate(config) reject the assembled output — the same guard the
 * PostToolUse hook runs on every config.json write.
 *
 * Prints the written config.json to stdout on success.
 */

import fs from 'node:fs';
import path from 'node:path';
import { validate } from './validate-config';

type Json = any;

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
const TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template');

function die(msg: string): never {
  console.error(`hatch-config: ${msg}`);
  process.exit(1);
}

// --- CLI args ---
const projectRoot = process.argv[2];
if (!projectRoot) die('usage: bun hatch-config.ts <PROJECT_ROOT> [--reinit]  (answers JSON on stdin)');
const reinit = process.argv.slice(3).some((a) => a === '--reinit' || a === '--reinit=true');

// --- stdin: answers payload ---
function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let answers: Json;
try {
  answers = JSON.parse(readStdinSync() || '{}');
} catch (e: any) {
  die(`answers payload on stdin is not valid JSON: ${e.message}`);
}

// --- read own plugin version (never from the answers payload — see header) ---
let coreVersion: string;
try {
  const ownPluginJson = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  coreVersion = ownPluginJson.version;
} catch (e: any) {
  die(`could not read this plugin's own plugin.json: ${e.message}`);
}

// --- load base: template (fresh) or existing config, strictly (re-init) ---
const hermitDir = path.join(projectRoot, '.claude-code-hermit');
const configPath = path.join(hermitDir, 'config.json');
const exists = fs.existsSync(configPath);

if (reinit && !exists) die(`--reinit passed but no existing config.json found at ${configPath}`);
if (!reinit && exists) die(`config.json already exists at ${configPath} — pass --reinit to update it`);

let config: Json;
if (reinit) {
  // Strict read: malformed JSON refuses without writing anything, preserving the
  // file's exact bytes (mirrors apply-settings.ts's readTargetJson, not its
  // permissive readJson which would silently discard the file as `{}`).
  const raw = fs.readFileSync(configPath, 'utf8');
  if (raw.trim() === '') die(`config.json exists but is empty — fix or remove it, then re-run with --reinit`);
  try {
    config = JSON.parse(raw);
  } catch (e: any) {
    die(`refusing to modify ${configPath}: existing file is not valid JSON (${e.message}). Fix or remove it, then re-run.`);
  }
} else {
  try {
    config = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  } catch (e: any) {
    die(`could not read config.json.template: ${e.message}`);
  }
  if (!answers.project_name) die('fresh hatch requires answers.project_name to substitute tmux_session_name');
  config.tmux_session_name = String(config.tmux_session_name).replace('{project_name}', answers.project_name);
}

// --- scalar overlay (present-by-hasOwn, both modes) ---
const SCALAR_KEYS = [
  'agent_name', 'language', 'timezone', 'sign_off',
  'escalation', 'remote', 'idle_behavior', 'permission_mode',
];
for (const key of SCALAR_KEYS) {
  if (Object.hasOwn(answers, key)) config[key] = answers[key];
}

// --- routines: upsert/remove morning + evening by id, never touch other routines ---
function timeToCron(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${m} ${h} * * *`;
}

if (Object.hasOwn(answers, 'routines')) {
  const routinesAnswer = answers.routines || {};
  config.routines = Array.isArray(config.routines) ? config.routines : [];
  config.routines = config.routines.filter((r: Json) => r.id !== 'morning' && r.id !== 'evening');
  if (routinesAnswer.enabled) {
    if (routinesAnswer.morning_time) {
      config.routines.push({
        id: 'morning', schedule: timeToCron(routinesAnswer.morning_time),
        skill: 'claude-code-hermit:brief --morning', enabled: true, run_during_waiting: true,
      });
    }
    if (routinesAnswer.evening_time) {
      config.routines.push({
        id: 'evening', schedule: timeToCron(routinesAnswer.evening_time),
        skill: 'claude-code-hermit:brief --evening', enabled: true, run_during_waiting: true,
      });
    }
  }
}

// --- _hermit_versions: add-if-absent only, never bump (Finding 1) ---
config._hermit_versions =
  config._hermit_versions && typeof config._hermit_versions === 'object' ? config._hermit_versions : {};

function stampIfAbsent(key: string, version: string): void {
  if (!Object.hasOwn(config._hermit_versions, key)) config._hermit_versions[key] = version;
}

stampIfAbsent('claude-code-hermit', coreVersion);
if (Object.hasOwn(answers, 'activated_hermit') && answers.activated_hermit) {
  stampIfAbsent(answers.activated_hermit.slug, answers.activated_hermit.version);
}

// --- boot_skill: only touched when a hermit was (re)activated this run ---
if (Object.hasOwn(answers, 'activated_hermit')) {
  config.boot_skill = answers.activated_hermit ? (answers.activated_hermit.boot_skill ?? null) : null;
}

// --- scheduled_checks: reconcile core-owned ids, preserve custom/domain entries ---
// Canonical mapping — mirrors hatch/SKILL.md Phase 4 (also listed at SKILL.md:178/222;
// update all three when a new scheduled-check-contributing plugin is added).
const SCHEDULED_CHECK_MAP: Record<string, Json[]> = {
  'claude-code-setup': [
    {
      id: 'automation-recommender', plugin: 'claude-code-setup',
      skill: '/claude-code-setup:claude-automation-recommender',
      enabled: true, trigger: 'interval', interval_days: 7,
    },
  ],
  'claude-md-management': [
    {
      id: 'md-audit', plugin: 'claude-md-management',
      skill: '/claude-md-management:claude-md-improver',
      enabled: true, trigger: 'interval', interval_days: 7,
    },
    {
      id: 'md-revise', plugin: 'claude-md-management',
      skill: '/claude-md-management:revise-claude-md',
      enabled: true, trigger: 'session',
    },
  ],
};
const CORE_OWNED_SCHEDULED_CHECK_IDS = new Set(
  Object.values(SCHEDULED_CHECK_MAP).flat().map((e) => e.id),
);

if (Object.hasOwn(answers, 'scheduled_checks_plugins')) {
  config.scheduled_checks = Array.isArray(config.scheduled_checks) ? config.scheduled_checks : [];
  // Drop any existing core-owned entries, then re-add per the (possibly changed)
  // selection — this reconciles additions/removals while leaving any custom/domain
  // entry (an id outside CORE_OWNED_SCHEDULED_CHECK_IDS) untouched.
  config.scheduled_checks = config.scheduled_checks.filter(
    (c: Json) => !CORE_OWNED_SCHEDULED_CHECK_IDS.has(c.id),
  );
  for (const plugin of answers.scheduled_checks_plugins as string[]) {
    const entries = SCHEDULED_CHECK_MAP[plugin];
    if (entries) config.scheduled_checks.push(...entries);
  }
}

// --- channels: field-level merge, preserve learned/unknown state on re-init ---
if (Object.hasOwn(answers, 'channels')) {
  config.channels = config.channels && typeof config.channels === 'object' ? config.channels : {};
  for (const [name, ans] of Object.entries<Json>(answers.channels)) {
    const existing = config.channels[name] && typeof config.channels[name] === 'object' ? config.channels[name] : {};
    const merged: Json = { ...existing };
    if (Object.hasOwn(ans, 'enabled')) merged.enabled = ans.enabled;
    else if (!Object.hasOwn(merged, 'enabled')) merged.enabled = true;
    if (!Object.hasOwn(merged, 'dm_channel_id')) merged.dm_channel_id = null;
    if (!Object.hasOwn(merged, 'state_dir')) merged.state_dir = `.claude.local/channels/${name}`;
    if (Object.hasOwn(ans, 'allowed_users')) merged.allowed_users = ans.allowed_users;
    if (Object.hasOwn(ans, 'morning_brief_time')) {
      merged.morning_brief = { enabled: true, time: ans.morning_brief_time };
    }
    config.channels[name] = merged;
  }
  // push_notifications is deliberately never touched here — stays at whatever the
  // base (template default `true`, or the existing re-init value) already carries.
}

// --- output-level validation guard ---
const { errors } = validate(config);
if (errors.length > 0) {
  console.error('hatch-config: assembled config.json failed validation:');
  for (const e of errors) console.error(`  FAIL  ${e}`);
  process.exit(1);
}

// --- atomic write: serialize -> .tmp -> rename (mirrors evolve-finalize.ts) ---
fs.mkdirSync(hermitDir, { recursive: true });
const tmp = configPath + '.tmp';
try {
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, configPath);
} catch (e: any) {
  try { fs.unlinkSync(tmp); } catch {}
  die(`write failed: ${e.message}`);
}

console.log(JSON.stringify(config));
process.exit(0);
