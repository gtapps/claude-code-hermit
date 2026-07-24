/**
 * Process-tree capture and cooperative termination for the stop/restart paths.
 *
 * The stop scripts historically equated "tmux session gone" with "claude dead",
 * which let a claude process that survived the tmux teardown keep running as an
 * orphan. These helpers capture the pane's descendant tree BEFORE the session is
 * killed (so attribution is unambiguous — they are our own pane's children, not
 * a pattern-match against other hermits on the box) and then verify the tree
 * actually exited, escalating no further than SIGTERM.
 *
 * Deliberately never SIGKILL: a hung claude is the operator's call. The contract
 * is "report the truth", not "guarantee death".
 */

import { spawnSync } from 'node:child_process';
import { pidAlive } from './lockfile';

// Read at call time (not module load) so tests can set the windows per-case.
const graceMs = () => Number(process.env.HERMIT_STOP_GRACE_MS) || 2000;
const termWaitMs = () => Number(process.env.HERMIT_TERM_WAIT_MS) || 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** pane_pid of every pane in the tmux session; [] when the session is absent. */
export function paneRootPids(sessionName: string): number[] {
  if (!sessionName) return [];
  const r = spawnSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], {
    encoding: 'utf-8',
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((l) => parseInt(l.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Collect `roots` plus all descendants via repeated `pgrep -P`, to a fixpoint.
 * `capped` is true when the traversal hit `cap` — the caller must treat a capped
 * result as UNVERIFIED (we cannot prove the whole tree died) rather than trust
 * a truncated snapshot.
 */
export function collectTree(roots: number[], cap = 100): { pids: number[]; capped: boolean } {
  const seen = new Set<number>();
  const queue = [...roots];
  let capped = false;
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    if (seen.size >= cap) {
      capped = true;
      break;
    }
    seen.add(pid);
    const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout) {
      for (const l of r.stdout.split('\n')) {
        const child = parseInt(l.trim(), 10);
        if (Number.isInteger(child) && child > 0 && !seen.has(child)) queue.push(child);
      }
    }
  }
  return { pids: [...seen], capped };
}

/**
 * Give the pids a grace period to exit on their own, then SIGTERM whatever is
 * still alive, wait once more, and return the pids that are STILL alive. Never
 * escalates past SIGTERM. Grace/wait windows are env-overridable for tests
 * (HERMIT_STOP_GRACE_MS, HERMIT_TERM_WAIT_MS).
 */
export async function terminateSurvivors(pids: number[]): Promise<number[]> {
  if (pids.length === 0) return [];
  // Nothing alive at call time (the common clean-stop case) — skip the grace
  // wait entirely; already-dead pids stay dead.
  if (!pids.some((p) => pidAlive(p))) return [];
  await sleep(graceMs());
  const alive = pids.filter((p) => pidAlive(p));
  if (alive.length === 0) return [];
  for (const p of alive) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {}
  }
  await sleep(termWaitMs());
  return alive.filter((p) => pidAlive(p));
}
