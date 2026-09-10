#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';

const [target, ...extra] = process.argv.slice(2);
if (!target || extra.length || !['settings.json', 'settings.local.json'].includes(path.basename(target))) {
  throw new Error('Usage: native-permissions.ts <project .claude/settings[.local].json>');
}
const settingsPath = path.resolve(target);
if (path.basename(path.dirname(settingsPath)) !== '.claude') throw new Error('Expected a project .claude settings file');

let settings: any;
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
catch (error: any) { if (error.code === 'ENOENT') settings = {}; else throw error; }
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings');
if (settings.permissions !== undefined && (!settings.permissions || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) {
  throw new Error('Invalid permissions');
}
for (const key of ['ask', 'allow', 'deny']) {
  const entries = settings.permissions?.[key];
  if (entries !== undefined && (!Array.isArray(entries) || entries.some((value: unknown) => typeof value !== 'string'))) {
    throw new Error(`Invalid permissions.${key}`);
  }
}

const rules: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../state-templates/native-permissions.json'), 'utf8')).ask;
const before = JSON.stringify(settings);
settings.permissions ??= {};
settings.permissions.ask = [...new Set([...(settings.permissions.ask ?? []), ...rules])];
if (JSON.stringify(settings) !== before) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
console.log('Native approval rules installed.');
