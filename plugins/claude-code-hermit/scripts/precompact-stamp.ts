process.stdout.on('error', () => {});

// PreCompact hook — stamps SHELL.md's Progress Log with a breadcrumb before Claude Code
// compacts context (manual /compact, or native auto-compaction), so the next session can
// see a mid-arc compaction happened. This is a trace only — it does not rescue observations
// that lived only in context (not deterministically extractable) and it never blocks
// compaction (side-effect only, always exit 0, no stdout).
//
// PreCompact does NOT fire on /clear — the watchdog's own emergency /clear (700k tokens)
// flushes the same breadcrumb directly in hermit-watchdog.ts's maybeContextClear.
//
// Only writes when the payload is a genuine PreCompact event with a recognized trigger
// (hook_event_name === "PreCompact", trigger ∈ {"auto","manual"}). Malformed/unexpected
// stdin is a no-op — never guess a breadcrumb from an absent/garbage trigger.

import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { flushResetBreadcrumb } from './lib/progress-log';
import { currentHHMMOrUTC } from './lib/time';

type Json = any;

function readJSON(raw: string): Json | null {
  try { return JSON.parse(raw); } catch { return null; }
}

function readConfigTimezone(agentDir: string): string {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentDir, 'config.json'), 'utf-8'));
    return config.timezone ?? 'UTC';
  } catch { return 'UTC'; }
}

function main(raw: string): void {
  const payload = readJSON(raw);
  if (!payload || payload.hook_event_name !== 'PreCompact') return;
  const trigger = payload.trigger;
  if (trigger !== 'auto' && trigger !== 'manual') return;

  const agentDir = hermitDir();
  const shellPath = path.join(agentDir, 'sessions', 'SHELL.md');
  const hhmm = currentHHMMOrUTC(readConfigTimezone(agentDir));
  flushResetBreadcrumb(shellPath, { kind: 'compacted', trigger, hhmm });
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try { main(buf); } catch { /* fail-open */ }
    process.exit(0);
  });
} catch {
  process.exit(0);
}
