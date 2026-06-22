#!/usr/bin/env bun
// PreToolUse hook: block forge.php deploy/server-reboot calls lacking --confirm.
//
// Probe (gating step 4) confirmed the PreToolUse Bash hook receives JSON on
// stdin with shape: { tool_name, tool_input: { command: string }, ... }
//
// Strategy: look for "forge.php" in the command string, extract the
// subcommand token that follows it, and gate on "deploy" / "server-reboot".
// preview-deploy and preview-reboot are distinct tokens — they pass through
// unconditionally (they are read-only). The in-PHP --confirm refusal is the
// authoritative gate; this hook is defense-in-depth.
//
// Fail-closed: malformed stdin or a parse error blocks the call.

import { readFileSync, writeSync } from 'node:fs';

function fail(message: string): never {
  try { writeSync(2, `${message}\n`); } catch {}
  process.exit(2);
}

function main(): void {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    fail('write-confirm-gate: failed to parse hook input');
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    fail('write-confirm-gate: invalid hook payload');
  }

  const p = payload as Record<string, unknown>;

  if (p['tool_name'] !== 'Bash') process.exit(0);

  const toolInput = p['tool_input'];
  if (typeof toolInput !== 'object' || toolInput === null) process.exit(0);

  const command = (toolInput as Record<string, unknown>)['command'];
  if (typeof command !== 'string') process.exit(0);

  if (!command.includes('forge.php')) process.exit(0);

  const tokens = command.trim().split(/\s+/);
  const idx = tokens.findIndex(t => t === 'forge.php' || t.endsWith('/forge.php'));

  if (idx === -1 || idx + 1 >= tokens.length) {
    // forge.php is present but no subcommand token — pass through (e.g., --help).
    process.exit(0);
  }

  const subcommand = tokens[idx + 1]!;

  const SAFE_SUBCOMMANDS = [
    'check', 'servers', 'server', 'sites', 'site', 'logs',
    'server-log', 'deploy-history', 'deploy-log',
    'preview-deploy', 'preview-reboot',
    'failed-deploys', 'call',
    'help', '--help',
  ];
  if (SAFE_SUBCOMMANDS.includes(subcommand)) {
    process.exit(0);
  }

  const WRITE_SUBCOMMANDS = ['deploy', 'server-reboot'];
  if (!WRITE_SUBCOMMANDS.includes(subcommand)) {
    // Unknown subcommand — pass through (in-PHP gate handles it).
    process.exit(0);
  }

  if (command.includes('--confirm')) {
    process.exit(0);
  }

  const preview = subcommand === 'deploy' ? 'preview-deploy' : 'preview-reboot';
  fail(`forge.php ${subcommand} requires --confirm. Run ${preview} first to review the canonical target, then re-run with --confirm.`);
}

if (import.meta.main) {
  main();
}
