#!/usr/bin/env bun
// Install this plugin's fixed native asks. --migrate runs the one-time legacy conversion.
import fs from 'node:fs';
import path from 'node:path';

const [target, mode] = process.argv.slice(2);
if (!target || !['settings.json', 'settings.local.json'].includes(path.basename(target)) || (mode && mode !== '--migrate')) {
  throw new Error('Usage: native-permissions.ts <project .claude/settings[.local].json> [--migrate]');
}
const settingsPath = path.resolve(target);
if (path.basename(path.dirname(settingsPath)) !== '.claude') throw new Error('Expected a project .claude settings file');
const project = path.dirname(path.dirname(settingsPath));
const migrationFile = path.join(project, '.claude-code-hermit/state/claude-code-homeassistant-hermit-native-permissions-v1.json');
const migrate = mode === '--migrate' && !fs.existsSync(migrationFile);
const rules: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../state-templates/native-permissions.json'), 'utf8')).ask;
function read(file: string): any {
  let value: any;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid settings: ${file}`);
  return value;
}
function validate(settings: any): void {
  if (settings.permissions !== undefined && (!settings.permissions || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) throw new Error('Invalid permissions');
  for (const key of ['ask', 'deny']) {
    const entries = settings.permissions?.[key];
    if (entries !== undefined && (!Array.isArray(entries) || entries.some((v: unknown) => typeof v !== 'string'))) throw new Error(`Invalid permissions.${key}`);
  }
}
const files = new Map<string, any>();
files.set(settingsPath, read(settingsPath));
if (migrate) {
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(project, '.claude', name);
    if (fs.existsSync(file)) files.set(file, read(file));
  }
}
for (const settings of files.values()) validate(settings);
const stateFile = path.join(project, '.claude-code-hermit/config.json');
const config = migrate ? read(stateFile) : null;
for (const [file, settings] of files) {
  const before = JSON.stringify(settings);
  if (file === settingsPath) {
    settings.permissions ??= {};
    settings.permissions.ask = [...new Set([...(settings.permissions.ask ?? []), ...rules])];
  }
  if (JSON.stringify(settings) !== before) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  }
  const conflicts = settings.permissions?.deny?.filter((rule: string) => rules.includes(rule)) ?? [];
  if (conflicts.length) console.log(`Existing denies remain: ${conflicts.join(', ')}`);
}
// `config` is non-null only on the first --migrate (the marker gates it), which
// is what keeps this one-time. A second run must not re-flip a `strict` the
// operator deliberately set back after upgrading.
if (config && (config.ha_safety_mode === undefined || config.ha_safety_mode === 'strict')) {
  config.ha_safety_mode = 'ask';
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(config, null, 2) + '\n');
  console.log('Home Assistant sensitive actions now request native approval.');
}
// Only a --migrate run may claim the marker: writing it on a plain install
// would make the one-time legacy conversion a no-op for anyone who hatches
// before running the upgrade instruction.
if (migrate) {
  fs.mkdirSync(path.dirname(migrationFile), { recursive: true });
  fs.writeFileSync(migrationFile, JSON.stringify({ version: 1 }) + '\n');
}
console.log('Native approval rules installed.');
