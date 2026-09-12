#!/usr/bin/env bun
// Install this plugin's fixed native asks without changing operator settings.
import fs from 'node:fs';
import path from 'node:path';

const [target, ...extra] = process.argv.slice(2);
if (!target || !['settings.json', 'settings.local.json'].includes(path.basename(target)) || extra.length > 0) {
  throw new Error('Usage: native-permissions.ts <project .claude/settings[.local].json>');
}
const settingsPath = path.resolve(target);
if (path.basename(path.dirname(settingsPath)) !== '.claude') throw new Error('Expected a project .claude settings file');
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
const settings = read(settingsPath);
validate(settings);
const before = JSON.stringify(settings);
settings.permissions ??= {};
settings.permissions.ask = [...new Set([...(settings.permissions.ask ?? []), ...rules])];
if (JSON.stringify(settings) !== before) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
const conflicts = settings.permissions.deny?.filter((rule: string) => rules.includes(rule)) ?? [];
if (conflicts.length) console.log(`Existing denies remain: ${conflicts.join(', ')}`);
console.log('Native approval rules installed.');
