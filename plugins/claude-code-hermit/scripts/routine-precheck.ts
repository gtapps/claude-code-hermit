// routine-precheck.ts — consolidates a routine fire's pre-dispatch gate (waiting-check +
// pause-check) and the `started` stamp into one script call, replacing 2-3 separate
// model-issued tool calls per fire with one. Mirrors reflect-precheck.ts's / heartbeat-
// precheck.ts's verdict-token contract. Delegates the JSONL write to log-routine-event.sh,
// which stays the single writer — the #464 dedup guard and JSONL schema live in exactly
// one place.
// Usage: bun routine-precheck.ts <routine-id> <rdw:true|false> [delivery]
// Output (stdout, one line): SKIP | PROCEED
// Side effect: stamps skipped-waiting | skipped-paused | started via log-routine-event.sh.
// Exit 0 always — fail-open to PROCEED on any read error (a malformed runtime.json must
// never silently kill a routine).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hermitDir } from './lib/cc-compat';
import { isPaused } from './lib/pause';

function emit(verdict: string): never {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

const id = process.argv[2];
const rdw = process.argv[3] === 'true';
const delivery = process.argv[4] || 'cron-create';

if (!id) emit('PROCEED');

let HERMIT_ROOT: string;
try {
  HERMIT_ROOT = hermitDir();
} catch {
  emit('PROCEED'); // fail-open: can't resolve the hermit dir → never silently kill the routine
}
const PROJECT_ROOT = path.dirname(HERMIT_ROOT);
const LOG_SCRIPT = path.join(import.meta.dir, 'log-routine-event.sh');

function stamp(event: string): void {
  try {
    execFileSync(LOG_SCRIPT, [id, event, delivery], { cwd: PROJECT_ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* fail-open — a stamp failure must not block the routine */ }
}

function sessionStateIsWaiting(): boolean {
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(HERMIT_ROOT, 'state', 'runtime.json'), 'utf-8'));
    return runtime.session_state === 'waiting';
  } catch {
    return false; // fail-open: unreadable/missing runtime.json reads as not-waiting
  }
}

if (!rdw && sessionStateIsWaiting()) {
  stamp('skipped-waiting');
  emit('SKIP');
}

let paused = false;
try {
  paused = isPaused(HERMIT_ROOT).paused;
} catch {
  paused = false; // fail-open: unresolvable pause state reads as unpaused (see header contract)
}
if (paused) {
  stamp('skipped-paused');
  emit('SKIP');
}

stamp('started');
emit('PROCEED');
