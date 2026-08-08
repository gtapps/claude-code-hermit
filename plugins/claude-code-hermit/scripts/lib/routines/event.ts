// `routines.ts log-event <routine-id> <event> [delivery]` — appends one line to
// state/routine-metrics.jsonl. Events: fired | skipped-waiting | skipped-paused |
// started. delivery: cron-create (default) | monitor.
//
// Ported from log-routine-event.sh. The emitted line is byte-identical to the
// shell version — same key order, same UTC second-precision stamp — because
// cost attribution, the doctor's routine-cost check, and several tests match on
// the literal `"routine_id":"<id>","event":"<e>"` substring.

import fs from 'node:fs';
import path from 'node:path';
import { utcISOStamp, localISOStamp } from '../time';
import { appendJsonlLine } from '../append-jsonl';

// Deliberately not an enum check: the shell version accepted any event string,
// and rejecting one here would refuse input that used to be recorded.
const USAGE = 'Usage: routines.ts log-event <routine-id> <event> [delivery]';

// CronCreate prompts fire with cwd set to the session's primary working
// directory, which may be a subdirectory of the hermit project root. Walk up to
// the nearest ancestor containing .claude-code-hermit/ so the relative path
// resolves correctly regardless of launch cwd.
function findHermitRoot(from: string): string | null {
  let dir = path.resolve(from);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.claude-code-hermit'))) return dir;
    dir = path.dirname(dir);
  }
  return fs.existsSync(path.join(dir, '.claude-code-hermit')) ? dir : null;
}

/**
 * Appends one routine event. Returns null on success, or an error message.
 *
 * `fromDir` is where the .claude-code-hermit/ walk-up starts — the in-process
 * callers (due.ts, precheck.ts) pass the project root they already resolved,
 * which is what they used to pass as the subprocess `cwd`. They now call this
 * directly rather than spawning, saving a process per stamp on the routine
 * fire path.
 */
export function logRoutineEvent(
  id: string,
  event: string,
  delivery = 'cron-create',
  fromDir: string = process.cwd(),
): string | null {
  const root = findHermitRoot(fromDir);
  if (!root) return `could not find .claude-code-hermit/ in any parent of ${fromDir}`;
  const metrics = path.join(root, '.claude-code-hermit', 'state', 'routine-metrics.jsonl');

  // Dedup guard (issue #464): heartbeat-restart re-invokes `hermit-routines
  // load` at its own prompt tail, which can re-trigger the cron and emit a
  // second `fired` with no intervening `started`. The prompt always logs
  // `started` immediately before `fired`, so a `fired` whose latest same-routine
  // event is already `fired` can only be the spurious re-trigger.
  if (event === 'fired') {
    try {
      const needle = `"routine_id":"${id}"`;
      const matching = fs.readFileSync(metrics, 'utf8').split('\n').filter(l => l.includes(needle));
      const last = matching[matching.length - 1];
      if (last && last.includes('"event":"fired"')) return null; // suppressed re-trigger
    } catch { /* no ledger yet — nothing to dedup against */ }
  }

  const err = appendJsonlLine(
    metrics,
    JSON.stringify({ ts: utcISOStamp(), routine_id: id, event, delivery }),
  );
  if (err) return err;

  // A routine that actually ran (as opposed to skipped-paused/skipped-waiting) is
  // real session activity. Without this, an always-on session cycling routines
  // via Monitor between operator turns never touches runtime.json's `updated_at`
  // — only session-archive.ts's open/close/heartbeat transitions do — so
  // evaluate-session.ts's stale-session nudge fires on a session that is working
  // exactly as designed, just not writing Progress Log lines for background
  // routine cycles. Touching updated_at here is fail-soft: a failure must not
  // block or fail the routine event itself.
  if (event === 'fired' || event === 'started') {
    try {
      const runtimePath = path.join(root, '.claude-code-hermit', 'state', 'runtime.json');
      const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
      runtime.updated_at = localISOStamp();
      const tmp = `${runtimePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(runtime, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmp, runtimePath);
    } catch { /* fail-soft — runtime.json missing/corrupt must not block the routine */ }
  }

  return null;
}

export function run(args: string[]): void {
  const [id, event, delivery] = args;
  if (!id || !event) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }
  const err = logRoutineEvent(id, event, delivery || 'cron-create');
  if (err) {
    process.stderr.write(`routines.ts log-event: ${err}\n`);
    process.exit(1);
  }
}
