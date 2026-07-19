#!/usr/bin/env bun
// PreToolUse hook: block error-api.ts resolve/mute calls lacking --confirm.
//
// The PreToolUse Bash hook receives JSON on stdin with shape:
//   { tool_name, tool_input: { command: string }, ... }
//
// Strategy: look for "error-api.ts" in the command string, extract the
// subcommand token that follows it, and gate on "resolve" / "mute". Read
// subcommands (check, issues, issue, latest-event, help) pass through
// unconditionally. The in-CLI --confirm refusal is the authoritative gate;
// this hook is defense-in-depth.
//
// Fail-open on transient/unexpected input (per the hermit hook rule: a hook
// must never block Claude Code on a parse glitch). We exit non-zero (block)
// ONLY when we positively identify a write command lacking --confirm.

import { readFileSync, writeSync } from 'node:fs';

function block(message: string): never {
  try {
    writeSync(2, `${message}\n`);
  } catch {}
  process.exit(2);
}

function main(): void {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // unparseable input — fail open, in-CLI gate is authoritative
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    process.exit(0);
  }

  const p = payload as Record<string, unknown>;

  if (p['tool_name'] !== 'Bash') process.exit(0);

  const toolInput = p['tool_input'];
  if (typeof toolInput !== 'object' || toolInput === null) process.exit(0);

  const command = (toolInput as Record<string, unknown>)['command'];
  if (typeof command !== 'string') process.exit(0);

  if (!command.includes('error-api.ts')) process.exit(0);

  const tokens = command.trim().split(/\s+/);
  const idx = tokens.findIndex((t) => t === 'error-api.ts' || t.endsWith('/error-api.ts'));

  if (idx === -1 || idx + 1 >= tokens.length) {
    process.exit(0); // present but no subcommand token — pass through
  }

  const subcommand = tokens[idx + 1]!;

  const SAFE_SUBCOMMANDS = [
    'check',
    'issues',
    'issue',
    'latest-event',
    'help',
    '--help',
  ];
  if (SAFE_SUBCOMMANDS.includes(subcommand)) {
    process.exit(0);
  }

  const WRITE_SUBCOMMANDS = ['resolve', 'mute'];
  if (!WRITE_SUBCOMMANDS.includes(subcommand)) {
    process.exit(0); // unknown subcommand — pass through (in-CLI gate handles it)
  }

  if (tokens.includes('--confirm')) {
    // exact token, matching the in-CLI args.includes('--confirm') check
    process.exit(0);
  }

  block(
    `error-api.ts ${subcommand} requires --confirm. Surface the target issue to the operator, ` +
      `get explicit approval, then re-run with --confirm.`,
  );
}

if (import.meta.main) {
  main();
}
