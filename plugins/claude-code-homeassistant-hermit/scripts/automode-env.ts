#!/usr/bin/env bun
/**
 * automode-env.ts — seeds one autoMode.environment entry naming the operator's
 * Home Assistant instance as trusted, so the Claude Code auto-mode classifier
 * stops treating the hermit's nightly unattended HA reads (briefs, audits,
 * context refresh) as unrecognized outbound calls.
 *
 * Usage: bun automode-env.ts <target-file>   (target MUST be settings.local.json —
 * the classifier reads autoMode only from local/user/managed scope, never a
 * committed project .claude/settings.json)
 *
 * Reads the same HOMEASSISTANT_URL / HOMEASSISTANT_LOCAL_URL /
 * HOMEASSISTANT_REMOTE_URL vars curl-host-gate.ts trusts (from .env at
 * CLAUDE_PROJECT_DIR, then process.env — process env wins). No configured URL
 * -> exits with SKIP, no write (hatch reports this to the operator).
 *
 * Additive, non-weakening: never removes existing keys or array entries; does
 * not inject "$defaults" into a pre-existing autoMode.environment array that
 * lacks it (that would override an operator's deliberate replacement).
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadEnvFile } from '../src/config';

type Json = any;

function resolveHaHosts(): string[] {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // src/config.ts's loadEnvFile is this plugin's canonical .env parser (also
  // used by loadConfig() for these same HOMEASSISTANT_* vars) — reused here
  // instead of re-copying curl-host-gate.ts's naive parser (which is kept
  // separate only for byte-parity with a retired Python hook, a constraint
  // that doesn't apply here).
  const fileVars = loadEnvFile(projectDir);
  const envVars: Record<string, string | undefined> = { ...fileVars, ...process.env };

  const hosts: string[] = [];
  for (const key of ['HOMEASSISTANT_URL', 'HOMEASSISTANT_LOCAL_URL', 'HOMEASSISTANT_REMOTE_URL']) {
    const raw = envVars[key];
    if (!raw) continue;
    try {
      hosts.push(new URL(raw).host);
    } catch {
      // not a parseable URL — skip rather than seed garbage
    }
  }
  return [...new Set(hosts)];
}

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

const hosts = resolveHaHosts();
if (hosts.length === 0) {
  console.log('SKIP|no HA URL configured');
  process.exit(0);
}

const entry =
  `Trusted internal domains: the operator's Home Assistant instance at ${hosts.join(', ')} — ` +
  "the hermit's read queries (briefs, audits, context pulls) and ha_safety_mode-gated Assist " +
  'actuation target it.';

const settings = readTargetJson(targetFile);
settings.autoMode ??= {};
if (!Array.isArray(settings.autoMode.environment)) settings.autoMode.environment = ['$defaults'];
if (!settings.autoMode.environment.includes(entry)) settings.autoMode.environment.push(entry);
writeJson(targetFile, settings);
console.log(`Seeded autoMode.environment entry for: ${hosts.join(', ')}`);
