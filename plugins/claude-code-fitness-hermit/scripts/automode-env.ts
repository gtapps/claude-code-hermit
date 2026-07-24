#!/usr/bin/env bun
/**
 * automode-env.ts — seeds one autoMode.environment entry naming Strava as a
 * trusted external service, so the Claude Code auto-mode classifier stops
 * treating the hermit's nightly unattended reads (fitness-brief,
 * weekly load review) as unrecognized outbound calls.
 *
 * Usage: bun automode-env.ts <target-file>   (target MUST be settings.local.json —
 * the classifier reads autoMode only from local/user/managed scope, never a
 * committed project .claude/settings.json)
 *
 * Additive, non-weakening: never removes existing keys or array entries; does
 * not inject "$defaults" into a pre-existing autoMode.environment array that
 * lacks it (that would override an operator's deliberate replacement).
 */

import fs from 'node:fs';
import path from 'node:path';

type Json = any;

const ENTRY =
  'Trusted external service: www.strava.com (API v3) — read-only activity and ' +
  'stream fetches by scripts/fitness-lab.ts and the strava MCP server; the hermit ' +
  'never writes to Strava.';

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
    console.error(`Refusing to overwrite ${filePath}: file exists but is not valid JSON (${(err as Error).message}).`);
    process.exit(1);
  }
}

function writeJson(filePath: string, data: Json): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const [, , targetFile] = process.argv;

if (!targetFile) {
  console.error('Usage: automode-env.ts <target-file>');
  process.exit(1);
}
if (path.basename(targetFile) !== 'settings.local.json') {
  console.error('automode-env.ts must target a settings.local.json file — autoMode is not read from committed project settings.');
  process.exit(1);
}

const settings = readTargetJson(targetFile);
settings.autoMode ??= {};
if (!Array.isArray(settings.autoMode.environment)) settings.autoMode.environment = ['$defaults'];
if (!settings.autoMode.environment.includes(ENTRY)) settings.autoMode.environment.push(ENTRY);
writeJson(targetFile, settings);
console.log('Seeded autoMode.environment entry for: www.strava.com');
