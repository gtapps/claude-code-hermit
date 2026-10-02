// `routines.ts precheck` — consolidates a routine fire's pre-dispatch gate (pause-check) and the `started` stamp into one script call, replacing 2-3 separate
// model-issued tool calls per fire with one. Mirrors reflect-precheck.ts's /
// `heartbeat.ts precheck`'s verdict-token contract. Delegates the JSONL write to lib/routines/event.ts,
// which stays the single writer — the #464 dedup guard and JSONL schema live in exactly
// one place.
// Usage: bun routines.ts precheck <routine-id> [delivery]
// Output (stdout): SKIP | PROCEED, optionally followed by one `REFLECT RUN|<phases-json>`
// line carrying the reflect gate's verdict so the skill does not re-run that script
// (which would append its observation rows a second time).
// Side effect: stamps skipped-paused | skipped-precheck |
// precheck-error | started via logRoutineEvent().
// Exit 0 always — fail-open to PROCEED on any read error (a malformed runtime.json must
// never silently kill a routine).

import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from '../cc-compat';
import { readConfigRaw } from '../config-read';
import { isPaused } from '../pause';
import { logRoutineEvent } from './event';
import { clearRunRecord, resolveArtifactPath, statIdentity, validateExpectArtifact, writeRunRecord } from './run-record';
import { utcISOStamp } from '../time';
import { BUILTIN_REFLECT, readReflectGate, runGate } from './gate';

type Json = any;

function emit(verdict: string): never {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

const id = process.argv[2];
const delivery = process.argv[3] || 'cron-create';

if (!id) emit('PROCEED');

let HERMIT_ROOT: string;
try {
  HERMIT_ROOT = hermitDir();
} catch {
  emit('PROCEED'); // fail-open: can't resolve the hermit dir → never silently kill the routine
}

function stamp(event: string, detail?: string): void {
  try {
    logRoutineEvent(id, event, HERMIT_ROOT, delivery, detail);
  } catch { /* fail-open — a stamp failure must not block the routine */ }
}

/** The routine's config entry, or null when config is unreadable / the id is gone. */
function routineEntry(): Json | null {
  try {
    const config: Json = readConfigRaw(HERMIT_ROOT);
    if (!config || !Array.isArray(config.routines)) return null;
    return config.routines.find((r: Json) => r && r.id === id) || null;
  } catch {
    return null;
  }
}

/**
 * The declared wake gate, at the point where it still has a say.
 *
 * Two deliveries, two different jobs:
 *   monitor      — `due` already ran the gate before it emitted, so running it again
 *                  here would be a second execution of operator code per fire. The
 *                  only thing left to do is hand reflect its phases, which `due`
 *                  parked keyed by the fire's cron mark.
 *   cron-create  — there is no `due` in fallback mode, so this is the gate's only
 *                  chance. The wake has already been paid for; behavior parity, not
 *                  cost parity (the doctor says so out loud).
 *
 * Returns the extra line to print after PROCEED, or exits on a SKIP verdict.
 */
function gateLine(routine: Json | null): string | null {
  if (!routine || routine.precheck === undefined || routine.precheck === null) return null;

  if (delivery === 'monitor') {
    if (String(routine.precheck).trim() !== BUILTIN_REFLECT) return null;
    const cached = readReflectGate(HERMIT_ROOT, id);
    // No cache match means a monitor from before this feature, or a race with a
    // re-registered schedule. Falling through to a bare PROCEED is safe: the skill
    // still has its own precheck path for exactly that case.
    if (!cached || !cached.phases || cached.mark !== consumedMark()) return null;
    return `REFLECT ${cached.phases}`;
  }

  const gate = runGate(routine, HERMIT_ROOT, consumedMark() || utcISOStamp());
  if (gate.verdict === 'skip') {
    stamp('skipped-precheck');
    emit('SKIP');
  }
  if (gate.verdict === 'error') stamp('precheck-error', gate.detail);
  return gate.phases ? `REFLECT ${gate.phases}` : null;
}

/** The cron mark `due` consumed for this fire — the key a cached reflect verdict is under. */
function consumedMark(): string | null {
  try {
    const schedule = JSON.parse(fs.readFileSync(path.join(HERMIT_ROOT, 'state', 'routine-schedule.json'), 'utf-8'));
    const mark = schedule?.[id]?.last_consumed_mark;
    return typeof mark === 'string' ? mark : null;
  } catch {
    return null;
  }
}

/**
 * For a routine declaring `expect_artifact`, freeze this fire's contract: the
 * `{date}` token resolved against `config.timezone` NOW (a routine crossing local
 * midnight must be checked against the path it was meant to write, not the next
 * day's), plus the target's current filesystem identity. `routines.ts finish`
 * compares against that baseline instead of against the `started` timestamp,
 * which utcISOStamp() truncates to whole seconds.
 *
 * Silent no-op on any read failure — the gate above has already decided this fire
 * proceeds, and `finish` treats a missing record for a declared contract as a
 * verification error anyway. A routine that no longer declares a contract, or
 * declares an invalid one, has its stale record dropped instead: leaving a
 * previous fire's `outcome` behind would make `finish` replay it forever.
 */
function captureArtifactBaseline(): void {
  try {
    // Raw, not settled: unreadable config must stay distinct from "no contract"
    // (a settled empty routines list would clear run records here).
    const config: any = readConfigRaw(HERMIT_ROOT);
    if (!config || !Array.isArray(config.routines)) return;
    const entry = config.routines.find((r: any) => r && r.id === id);
    const pattern = entry?.expect_artifact;
    // Re-validated here, not just in validate-config.ts: that validator is a
    // PostToolUse advisory, so a hand-edited config can put a traversal or
    // absolute path on disk that would otherwise resolve outside the state dir.
    if (validateExpectArtifact(pattern)) {
      clearRunRecord(HERMIT_ROOT, id);
      return;
    }

    const timezone = typeof config.timezone === 'string' ? config.timezone : null;
    const resolved = resolveArtifactPath(pattern.trim(), timezone);
    writeRunRecord(HERMIT_ROOT, id, {
      started_ts: utcISOStamp(),
      resolved_path: resolved,
      baseline: statIdentity(path.join(HERMIT_ROOT, resolved)),
    });
  } catch { /* fail-open: a broken capture must not block the routine */ }
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

// Runs before the `started` stamp: a gate SKIP means this fire never opened, so it
// must not leave an attempt the ledger would later read as abandoned.
const reflectLine = gateLine(routineEntry());

stamp('started');
captureArtifactBaseline();
emit(reflectLine ? `PROCEED\n${reflectLine}` : 'PROCEED');
