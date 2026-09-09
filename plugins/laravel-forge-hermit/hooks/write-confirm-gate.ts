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
// Fail-open on transient/unexpected input (per the hermit hook rule: a hook
// must never block Claude Code on a parse glitch). We exit non-zero (block)
// ONLY when we positively identify a write command lacking --confirm; if we
// can't parse or classify the call, we pass through and let the authoritative
// in-PHP gate handle it.
//
// classify() is the whole decision, exported so it can be tested as a function
// and so the inventories below can be asserted against the subcommands
// php/forge.php actually dispatches. main() owns only stdin, exit codes, and
// the stderr message.

import { readFileSync, writeSync } from 'node:fs';

export const SAFE_SUBCOMMANDS: readonly string[] = [
  'check', 'servers', 'server', 'sites', 'site', 'logs',
  'server-log', 'site-log', 'background-process-log',
  'deploy-history', 'deploy-log', 'deploy-status', 'deploy-watch',
  'preview-deploy', 'preview-reboot',
  'failed-deploys',
  // Generic dispatch. `execute` mutates, but its authority is the plan hash
  // plus Claude Code native approval, neither is visible in a Bash
  // command string, so gating it here would be theatre. It stays in PHP.
  'policy', 'call', 'preview', 'execute',
  'help', '--help',
];

// subcommand -> the read-only command that previews it. A map rather than a
// list so a new write subcommand cannot be added without naming its preview.
export const WRITE_SUBCOMMANDS: Readonly<Record<string, string>> = {
  'deploy': 'preview-deploy',
  'server-reboot': 'preview-reboot',
};

export type Classification =
  | { gate: 'pass' }
  | { gate: 'needs-confirm'; subcommand: string; preview: string };

const PASS: Classification = { gate: 'pass' };

export function classify(command: string): Classification {
  if (!command.includes('forge.php')) return PASS;

  const tokens = command.trim().split(/\s+/);
  const idx = tokens.findIndex(t => t === 'forge.php' || t.endsWith('/forge.php'));

  // forge.php is present but no subcommand token — pass through (e.g., --help).
  if (idx === -1 || idx + 1 >= tokens.length) return PASS;

  const subcommand = tokens[idx + 1]!;

  if (SAFE_SUBCOMMANDS.includes(subcommand)) return PASS;

  // Unknown subcommand — pass through (in-PHP gate handles it).
  const preview = WRITE_SUBCOMMANDS[subcommand];
  if (preview === undefined) return PASS;

  // Exact token, matching the in-PHP in_array() check.
  if (tokens.includes('--confirm')) return PASS;

  return { gate: 'needs-confirm', subcommand, preview };
}

function block(message: string): never {
  try { writeSync(2, `${message}\n`); } catch {}
  process.exit(2);
}

function main(): void {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // unparseable input — fail open, in-PHP gate is authoritative
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    process.exit(0); // unexpected payload shape — fail open
  }

  const p = payload as Record<string, unknown>;

  if (p['tool_name'] !== 'Bash') process.exit(0);

  const toolInput = p['tool_input'];
  if (typeof toolInput !== 'object' || toolInput === null) process.exit(0);

  const command = (toolInput as Record<string, unknown>)['command'];
  if (typeof command !== 'string') process.exit(0);

  const verdict = classify(command);
  if (verdict.gate === 'pass') process.exit(0);

  block(`forge.php ${verdict.subcommand} requires --confirm. Run ${verdict.preview} first to review the canonical target, then re-run with --confirm.`);
}

if (import.meta.main) {
  main();
}
