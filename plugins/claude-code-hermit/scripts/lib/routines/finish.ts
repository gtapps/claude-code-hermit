// `routines.ts finish <routine-id> [delivery] [--outcome-stdin]` — the single
// owner of a routine fire's terminal ledger row. Called unconditionally after the
// skill is invoked, replacing the old `log-event <id> fired`.
//
// With --outcome-stdin, stdin carries the fire's one-line outcome, appended under
// SHELL.md's `## Progress Log` as `[HH:MM] <line>`. Without the flag stdin is not
// read. An empty outcome writes nothing, and neither does a replayed fire: one
// row per real fire, contract or not.
//
// Why a finalizer instead of a verify-then-branch: the old contract asked the
// model to decide which event to log, so a fire's success was recorded from the
// dispatched subagent's self-report. This script decides, so the ledger reflects
// what is on disk. Same idiom as reflect-precheck.ts owning its own audit trail.
//
// Output (stdout, one line):
//   fired
//   failed|artifact-missing|<path>
//   failed|artifact-unchanged|<path>
//   failed|verification-error|<detail>
//
// The failure reason is encoded in the event string (failed-artifact-missing, …)
// rather than a separate column, because routine-metrics.jsonl's row shape is
// pinned to four keys. lib/routines/history.ts folds these into typed per-reason
// failure counts, so a contract miss reads as its own outcome rather than as an
// unexplained gap.
//
// Fail-closed on declared contracts, fail-open otherwise: a routine with no
// artifact contract keeps the legacy unconditional `fired`, while a routine that
// declared one never records success on a verification error — falling open
// there would recreate the exact false-green this exists to prevent.

import path from 'node:path';
import { hermitDir } from '../cc-compat';
import { readConfigRaw } from '../config-read';
import { appendToProgressLog } from '../progress-log';
import { currentHHMMOrUTC } from '../time';
import { logRoutineEvent } from './event';
import { lastRoutineEvent } from './history';
import { readRunRecord, markOutcome, statIdentity, identityChanged } from './run-record';

type Json = any;

const USAGE = 'Usage: routines.ts finish <routine-id> [delivery] [--outcome-stdin]';
const OUTCOME_FLAG = '--outcome-stdin';

// Function declaration, not an arrow: TS only uses a `never` return for
// control-flow narrowing when the callee is a declared name (same shape as
// precheck.ts's emit).
function emit(line: string): never {
  process.stdout.write(line + '\n');
  process.exit(0);
}

/** true/false when config is readable, null when it is not (caller falls back to the run record). */
function declaresContract(hermit: string, id: string): boolean | null {
  // Raw, not settled: "config unreadable" (null) must stay distinct from
  // "routine declares no contract" (false) — see the caller's comment.
  const config: Json = readConfigRaw(hermit);
  if (!config || !Array.isArray(config.routines)) return null;
  const entry = config.routines.find((r: Json) => r && r.id === id);
  return !!(entry && typeof entry.expect_artifact === 'string' && entry.expect_artifact.trim());
}

/**
 * The one-line outcome the skill composed, landed under `## Progress Log` as part
 * of the same call that closes the fire — the write the model used to make by hand,
 * now serialized against the log's other autonomous writers. Best-effort in both
 * directions: an empty payload writes nothing, and appendToProgressLog swallows its
 * own I/O errors, so SHELL.md can never change the routine's verdict.
 */
function appendOutcome(hermit: string, outcome: string): void {
  const line = outcome.split('\n').map(l => l.trim()).find(Boolean);
  if (!line) return;
  const timezone = readConfigRaw(hermit)?.timezone ?? 'UTC';
  // `- [HH:MM] …` is the shape every other Progress Log writer uses; without the
  // bullet the entry merges into the preceding one when SHELL.md is rendered.
  const body = line.replace(/^-\s*/, '');
  appendToProgressLog(path.join(hermit, 'sessions', 'SHELL.md'), `- [${currentHHMMOrUTC(timezone)}] ${body}`);
}

export function run(args: string[], outcome = ''): void {
  // The dispatcher already consumed the flag's stdin; strip it here so it can
  // never be taken as the delivery positional (the ledger accepts any string).
  const [id, deliveryArg] = args.filter(arg => arg !== OUTCOME_FLAG);
  const delivery = deliveryArg || 'cron-create';
  if (!id) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }

  let hermit: string;
  try {
    hermit = hermitDir();
  } catch {
    // Nothing to verify against and nowhere to log — never claim success.
    emit('failed|verification-error|hermit dir unresolvable');
  }

  const stamp = (event: string): void => {
    try {
      logRoutineEvent(id, event, hermit, delivery);
    } catch { /* a stamp failure must not crash the fire path */ }
  };

  /** Writes the terminal row, records the outcome for replay, and emits. */
  const terminal = (reason: string | null, detail: string): never => {
    stamp(reason ? `failed-${reason}` : 'fired');
    markOutcome(hermit, id, reason ?? 'fired');
    return emit(reason ? `failed|${reason}|${detail}` : 'fired');
  };

  const declared = declaresContract(hermit, id);

  // Config says this routine has no contract, so any record on disk is a leftover
  // from a fire made under an older config. Ignore it: replaying its `outcome`
  // would suppress this routine's terminal row on every future fire, leaving an
  // unbounded run of `started` rows and re-emitting a stale `failed|…` line the
  // skill escalates to the operator. Config unreadable (`null`) is not proof of
  // absence, so a record still applies there.
  const record = declared === false ? null : readRunRecord(hermit, id);

  // Already finalized — a re-triggered fire (the #464 case documented in
  // event.ts). Report the recorded outcome; write no second terminal row.
  if (record?.outcome) {
    return emit(
      record.outcome === 'fired' ? 'fired' : `failed|${record.outcome}|${record.resolved_path}`,
    );
  }

  // The record gate above only covers routines that declared a contract — a routine
  // without `expect_artifact` never gets a run record (precheck.ts writes one only for
  // a valid contract), so a replayed `finish` reaches this line with `record` null and
  // would append a second identical row. The ledger is the record-independent witness:
  // a real fire always has precheck's `started` as its latest event, so a terminal
  // latest event can only be a replay of the fire that wrote it. Terminal by prefix,
  // not `=== 'fired'`, because the declared-but-recordless path below is terminal too.
  const lastEvent = lastRoutineEvent(path.join(hermit, 'state', 'routine-metrics.jsonl'), id);
  const replayed = lastEvent === 'fired' || (lastEvent?.startsWith('failed-') ?? false);
  if (!replayed) appendOutcome(hermit, outcome);

  if (!record) {
    // No run record. If config is readable and this routine declared a contract,
    // precheck failed to write one — that is a verification error, not a success.
    // If config is unreadable we cannot tell, so keep legacy behavior rather than
    // holding every routine hostage to a transient read failure.
    if (declared === true) {
      stamp('failed-verification-error');
      return emit('failed|verification-error|no run record for a declared contract');
    }
    stamp('fired');
    return emit('fired');
  }

  const current = statIdentity(path.join(hermit, record.resolved_path));
  if (!current) return terminal('artifact-missing', record.resolved_path);
  if (!identityChanged(record.baseline, current)) return terminal('artifact-unchanged', record.resolved_path);
  return terminal(null, record.resolved_path);
}
