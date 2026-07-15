// routine-due.ts — deterministic scheduler for monitor-mode routines. Polled every
// interval by routine-monitor.sh. Owns all gating (pause/waiting/idle), all state writes
// (state/routine-schedule.json cursors, state/routine-monitor-liveness.json), and emits
// a single ROUTINE_DUE line only for routines that should actually wake the session.
//
// Usage: bun routine-due.ts <hermit-dir>
// Output (stdout): nothing, or exactly one line:
//   ROUTINE_DUE [hermit-routine:<id1>] [hermit-routine:<id2>] ...
// The bracketed markers are load-bearing — cost-tracker.ts classifySource reads this
// ROUTINE_DUE line to attribute the wake turn: one id → routine:<id>, ≥2 ids (a co-fire)
// → the routine:multi bucket. Also load-bearing: record-operator-action.ts
// isRoutinePrompt() drops this line; tests/auto-close.test.ts drift guard syncs it.
//
// State model (state/routine-schedule.json): { "<id>": { "last_consumed_mark": "<ISO minute>" } }
// A routine is due when a cron-matching minute mark exists in (last_consumed_mark, now],
// lower-bounded at now-24h. Gate order per due routine: paused → waiting(!rdw) → in_progress
// (defer, no consume) → emit (consume). Missing entry inits to now, fires nothing — exact
// CronCreate-death parity, no catch-up (operator-confirmed).
//
// heartbeat-restart is hardcoded excluded — it stays the CronCreate re-arm anchor.
//
// Exit 0 always. All errors fail-soft: emit nothing, still write liveness, stderr only —
// a corrupt config must not print an error line every poll.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isPaused } from './lib/pause';
import { validateCronSchedule, ROUTINE_ID_RE } from './validate-config';
import { makeTzFormatter, partsFromFormatter, compileCron, cronMatchesCompiled } from './lib/cron-match';
import { readJson as readJSON } from './lib/cli';

type Json = any;

const ANCHOR_ID = 'heartbeat-restart';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const hermitDir = process.argv[2];
if (!hermitDir) process.exit(0);

const stateDir = path.join(hermitDir, 'state');
const projectRoot = path.dirname(hermitDir);
const schedulePath = path.join(stateDir, 'routine-schedule.json');
const livenessPath = path.join(stateDir, 'routine-monitor-liveness.json');
const logScript = path.join(import.meta.dir, 'log-routine-event.sh');

function now(): Date {
  if (process.env.HERMIT_NOW) {
    const d = new Date(process.env.HERMIT_NOW);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function floorToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS);
}

function writeJSONAtomic(p: string, value: Json): boolean {
  // Test-only seam: force the schedule persist to fail (leaving liveness writable) so a
  // test can reach the skip branches with a valid cursor, then verify the persist-before-
  // stamp ordering. Scoped to schedulePath so it never affects liveness or other writes.
  if (process.env.HERMIT_DUE_FORCE_PERSIST_FAIL && p === schedulePath) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

function writeLiveness(): void {
  writeJSONAtomic(livenessPath, { last_peek_at: new Date().toISOString() });
}

function stamp(id: string, event: string): void {
  try {
    execFileSync(logScript, [id, event, 'monitor'], { cwd: projectRoot, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* fail-open — a stamp failure must not block the routine */ }
}

// Exit early on any hard failure — always write liveness first so the doctor still
// sees a live proof-of-life even on a bad run.
function finish(lines: string[]): never {
  writeLiveness();
  if (lines.length) process.stdout.write(lines.join(' ') + '\n');
  process.exit(0);
}

const nowDate = now();
const nowMinute = floorToMinute(nowDate);
const windowFloor = new Date(nowMinute.getTime() - WINDOW_MS);

const config = readJSON(path.join(hermitDir, 'config.json'));
if (!config) finish([]);

const timezone: string | null = typeof config.timezone === 'string' ? config.timezone : null;
// One formatter per poll, reused across every candidate minute. null on a bad tz — the
// per-candidate scan then finds no match (fail-soft), but cursor init/reset and pruning
// below still run exactly as before.
const tzFormatter = makeTzFormatter(timezone);
const routines: Json[] = Array.isArray(config.routines) ? config.routines : [];
const eligible = routines.filter((r: Json) =>
  r && r.enabled === true && r.id && r.skill && r.schedule && r.id !== ANCHOR_ID);

let runtime: Json = readJSON(path.join(stateDir, 'runtime.json'));
const sessionState: string | null = runtime && typeof runtime.session_state === 'string' ? runtime.session_state : null;

let paused = false;
try {
  paused = isPaused(hermitDir).paused;
} catch {
  paused = false; // fail-open: unresolvable pause state reads as unpaused
}

const schedule: Json = readJSON(schedulePath) || {};
let scheduleChanged = false;
const dueIds: string[] = [];
// Skip stamps are deferred and flushed only after the schedule persists — a failed persist
// must not leave a skipped-* row whose cursor advance was rolled back (phantom ledger rows).
const pendingStamps: Array<[string, string]> = [];

for (const routine of eligible) {
  const id: string = routine.id;
  if (!ROUTINE_ID_RE.test(id)) {
    process.stderr.write(`routine-due: skipping routine with invalid id "${id}"\n`);
    continue;
  }
  if (validateCronSchedule(routine.schedule)) {
    process.stderr.write(`routine-due: skipping routine "${id}" — invalid schedule "${routine.schedule}"\n`);
    continue;
  }
  // Parse the cron once per routine (invariant across the minute scan). Non-null here since
  // validateCronSchedule already accepted it — the guard just satisfies the type checker.
  const compiled = compileCron(routine.schedule);
  if (!compiled) continue;

  const entry = schedule[id];
  let cursor: Date | null = entry && typeof entry.last_consumed_mark === 'string'
    ? new Date(entry.last_consumed_mark)
    : null;
  if (!cursor || isNaN(cursor.getTime()) || cursor.getTime() > nowMinute.getTime()) {
    // Missing, corrupt, or future (clock skew) — initialize to now, fire nothing.
    schedule[id] = { last_consumed_mark: nowMinute.toISOString() };
    scheduleChanged = true;
    continue;
  }

  const from = cursor.getTime() < windowFloor.getTime() ? windowFloor : cursor;

  let latestMatch: Date | null = null;
  for (let t = from.getTime() + MINUTE_MS; t <= nowMinute.getTime(); t += MINUTE_MS) {
    const candidate = new Date(t);
    const parts = tzFormatter ? partsFromFormatter(tzFormatter, candidate) : null;
    if (parts && cronMatchesCompiled(compiled, parts)) latestMatch = candidate;
  }

  if (!latestMatch) {
    // No match in (from, now]: advance the cursor to nowMinute so the next poll re-scans only
    // new minutes instead of re-walking this dead window every interval. Safe — nothing
    // matched up to now, and anything before windowFloor is intentionally abandoned (no
    // catch-up). Guard against a redundant write when the cursor is already at nowMinute.
    if (cursor.getTime() < nowMinute.getTime()) {
      schedule[id] = { last_consumed_mark: nowMinute.toISOString() };
      scheduleChanged = true;
    }
    continue;
  }

  const rdw = routine.run_during_waiting === true;

  if (paused) {
    schedule[id] = { last_consumed_mark: latestMatch.toISOString() };
    scheduleChanged = true;
    pendingStamps.push([id, 'skipped-paused']);
    continue;
  }
  if (sessionState === 'waiting' && !rdw) {
    schedule[id] = { last_consumed_mark: latestMatch.toISOString() };
    scheduleChanged = true;
    pendingStamps.push([id, 'skipped-waiting']);
    continue;
  }
  if (sessionState === 'in_progress') {
    // Defer: do NOT consume — next poll re-derives from the untouched cursor.
    continue;
  }

  schedule[id] = { last_consumed_mark: latestMatch.toISOString() };
  scheduleChanged = true;
  dueIds.push(id);
}

// Prune entries for ids no longer enabled/non-anchor.
const eligibleIds = new Set(eligible.map((r: Json) => r.id));
for (const id of Object.keys(schedule)) {
  if (!eligibleIds.has(id)) {
    delete schedule[id];
    scheduleChanged = true;
  }
}

if (scheduleChanged) {
  const persisted = writeJSONAtomic(schedulePath, schedule);
  if (!persisted) {
    // Ordering contract: persist before emit AND before stamping. A failed write must not
    // emit or stamp — otherwise the subprocess-side dedup/ledger guarantee is void.
    process.stderr.write(`routine-due: failed to persist ${schedulePath} — emitting nothing this poll\n`);
    finish([]);
  }
}

// Persist succeeded (or nothing changed) — now flush the deferred skip stamps.
for (const [id, event] of pendingStamps) stamp(id, event);

finish(dueIds.length ? [`ROUTINE_DUE ${dueIds.map(id => `[hermit-routine:${id}]`).join(' ')}`] : []);
