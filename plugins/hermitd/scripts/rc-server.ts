// rc-server.ts — the hermit's spawn gate over `claude remote-control`.
//
// Server mode lets a phone spawn NEW sessions into this project; it is a
// separate leg from the hermit's own `--remote-control` flag (which makes the
// hermit itself reachable). The server runs as a hermit-owned tmux child and
// never auto-starts: these verbs are reached only through the rc-gate skill,
// which the operator invokes.
//
// Launched with `--spawn worktree --no-create-session-in-dir` so the project
// folder stays single-session and every phone spawn lands in its own worktree.
// Trade documented upstream: with that flag the server's sessions archive when
// it stops.
//
// Reached via: .hermit/bin/hermitd-run rc-server <subcommand>
// Subcommands: start | stop | status | gc | sweep
//
// Status is a single one-shot pane capture, never a tail: the server's TUI
// redraws its status line continuously and floods any log follower.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmuxSessionAlive, capturePane as tmuxCapturePane } from './lib/tmux';

const TMUX_SESSION = 'hermit-rc-gate';
const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 1000;

const URL_RE = /https?:\/\/claude\.ai\/code\?environment=\S+/;
const CAPACITY_RE = /Capacity[:\s]+(\d+)\s*\/\s*(\d+)/i;
const READY_RE = /\bReady\b/;
const LOGIN_RE = /must be logged in|claude\.ai subscription|please run \/login/i;

function sh(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function sessionAlive(): boolean {
  return tmuxSessionAlive(TMUX_SESSION);
}

// The shared helper caps the capture at 5s, so a wedged server can't hang a verb.
function capturePane(): string {
  return tmuxCapturePane(TMUX_SESSION) ?? '';
}

function repoRoot(): string {
  const r = sh('git', ['rev-parse', '--show-toplevel']);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
}

/**
 * Status read off an already-captured pane, so callers holding one don't re-spawn tmux.
 *
 * A live tmux session is not by itself proof the server is serving: `start`
 * leaves the session running when it times out, so 'ready' has to come from the
 * same signal `start` waits on, not from mere liveness.
 */
function statusFromPane(pane: string): string {
  const cap = pane.match(CAPACITY_RE);
  if (cap && Number(cap[1]) > 0) return `connected ${cap[1]}/${cap[2]}`;
  if (READY_RE.test(pane) || URL_RE.test(pane)) return 'ready';
  return 'starting';
}

/** Gate status, followed by live spawn worktrees when any can be inspected. */
function statusLine(): string {
  const status = sessionAlive() ? statusFromPane(capturePane()) : 'down';
  const worktrees = bridgeWorktrees(repoRoot());
  if (worktrees.length === 0) return status;
  const cwds = liveCwds();
  if (cwds === null) return status;
  const live = worktrees.filter(({ dir }) => inUse(cwds, dir)).map(({ name }) => name);
  return `${status}\nspawns: ${live.length} live${live.length ? ` (${live.join(', ')})` : ''}`;
}

function start(): number {
  if (sessionAlive()) {
    const pane = capturePane();
    const url = pane.match(URL_RE);
    console.log(statusFromPane(pane) + (url ? ` ${url[0]}` : '') + ' (already open)');
    return 0;
  }

  const cmd = 'claude remote-control --spawn worktree --no-create-session-in-dir';
  const r = sh('tmux', ['new-session', '-d', '-s', TMUX_SESSION, '-c', repoRoot(), cmd]);
  if (r.status !== 0) {
    console.error(`[rc-server] tmux new-session failed: ${r.stderr.trim() || 'unknown error'}`);
    return 1;
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    Bun.sleepSync(POLL_MS);
    if (!sessionAlive()) {
      console.error('[rc-server] the server exited during startup — run `status` after retrying, or check `tmux capture-pane`.');
      return 1;
    }
    const pane = capturePane();
    // Auth is the one failure worth naming: Remote Control rejects setup-token
    // installs outright, and no workaround exists on this side.
    if (LOGIN_RE.test(pane)) {
      sh('tmux', ['kill-session', '-t', TMUX_SESSION]);
      console.error("[rc-server] Remote Control needs a claude.ai /login on this machine; this install's auth doesn't support it.");
      return 1;
    }
    const url = pane.match(URL_RE);
    if (url || READY_RE.test(pane)) {
      console.log(`ready${url ? ` ${url[0]}` : ''}`);
      return 0;
    }
  }

  console.error(`[rc-server] no Ready line after ${READY_TIMEOUT_MS / 1000}s — session left running; inspect with \`tmux attach -t ${TMUX_SESSION}\`.`);
  return 1;
}

/**
 * cwds of every live process, for deciding whether a bridge worktree is still
 * in use. Returns null when no liveness signal can be obtained: gc then refuses
 * to delete rather than guessing.
 */
function liveCwds(): Set<string> | null {
  return process.platform === 'darwin' ? darwinLiveCwds() : procLiveCwds();
}

/** Linux and friends: read each process's cwd symlink out of procfs. */
function procLiveCwds(): Set<string> | null {
  let pids: string[];
  try {
    pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n));
  } catch {
    return null;
  }
  const cwds = new Set<string>();
  for (const pid of pids) {
    try { cwds.add(fs.readlinkSync(`/proc/${pid}/cwd`)); } catch {}
  }
  return cwds;
}

/**
 * macOS has no procfs, so lsof is the supported way to read process cwds.
 * `-d cwd` restricts to the cwd descriptor and `-F pn` asks for machine-readable
 * output: one `p<pid>` line per process followed by its `n<path>`.
 *
 * lsof exits non-zero when it could not examine *some* process, which is the
 * normal case for an unprivileged user, so the exit code is not a failure
 * signal here. Those unreadable processes belong to other users and so cannot
 * be holding one of this hermit's worktrees. A missing lsof does not throw:
 * spawnSync reports it through `error` and leaves stdout null, so it lands on
 * the same failure path. Either way null is returned, which keeps the
 * refuse-to-delete posture rather than reporting "nothing is live" and
 * sweeping every worktree.
 */
function darwinLiveCwds(): Set<string> | null {
  let out: string;
  try {
    // Bounded: lsof walks every process on the box, so unlike the targeted git and
    // tmux calls elsewhere in this file it is worth a ceiling. -n/-P suppress the
    // hostname and port-name lookups that are the usual reason lsof stalls; they
    // do not affect the cwd paths this reads.
    const r = spawnSync('lsof', ['-n', '-P', '-d', 'cwd', '-F', 'pn'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    // `error`/`signal` mean the listing is incomplete, not empty: spawnSync
    // returns whatever lsof had already buffered before the timeout kill. A
    // truncated set is worse than none: every process lsof had not reached yet
    // would read as dead and gc would sweep a live worktree.
    if (r.error || r.signal) return null;
    out = r.stdout ?? '';
  } catch {
    return null;
  }
  if (!out.trim()) return null;
  const cwds = new Set<string>();
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) cwds.add(line.slice(1));
  }
  return cwds.size ? cwds : null;
}

function inUse(cwds: Set<string>, dir: string): boolean {
  for (const c of cwds) if (c === dir || c.startsWith(dir + path.sep)) return true;
  return false;
}

function bridgeWorktrees(root: string): Array<{ name: string; dir: string }> {
  const wtDir = path.join(root, '.claude', 'worktrees');
  try {
    // Directories only: a stray `bridge-*` file is not a worktree, and the
    // automatic sweep would otherwise fail to remove it on every single tick.
    return fs.readdirSync(wtDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('bridge-'))
      .map(e => ({ name: e.name, dir: path.join(wtDir, e.name) }));
  } catch {
    return [];
  }
}

/**
 * The unattended sweep leaves worktrees younger than this alone.
 *
 * `git worktree add` finishes before the spawned session has chdir-ed into the
 * new worktree, and in that window the tree is clean and no process holds it —
 * both of gc's guards pass. That was harmless while gc only ran when the
 * operator asked for it; on a timer it means a tick can delete a phone spawn
 * that is still starting, along with its branch. Operator-invoked `gc`/`stop`
 * keep sweeping everything: they run when the operator knows what is spawning.
 */
const AUTO_SWEEP_MIN_AGE_MS = 120_000;

/** Worktree age, from the `.git` file `git worktree add` writes once at creation. */
function worktreeAgeMs(dir: string): number {
  try {
    return Date.now() - fs.statSync(path.join(dir, '.git')).mtimeMs;
  } catch {
    return Infinity; // not a worktree we created — no reason to hold the sweep back
  }
}

/**
 * Branch checked out in each worktree, by worktree path. Read rather than
 * derived: a worktree's directory name and its branch name are independent, so
 * guessing one from the other leaves stray branches behind.
 */
function worktreeBranches(root: string): Map<string, string> {
  const byPath = new Map<string, string>();
  let current = '';
  for (const line of sh('git', ['-C', root, 'worktree', 'list', '--porcelain']).stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice(9);
    else if (line.startsWith('branch ')) byPath.set(current, line.slice(7).replace(/^refs\/heads\//, ''));
  }
  return byPath;
}

/**
 * Sweep worktrees left behind by phone-spawned sessions. Archiving a spawned
 * session from the Claude app reads as a crash to the server and orphans a
 * *locked* worktree, so unlock comes first and `git worktree remove` needs a
 * --force fallback.
 *
 * A dirty worktree is never swept. Once the lock is gone the only thing
 * `remove` still refuses is uncommitted work, so the --force fallback would be
 * a delete of exactly that. An orphan holding a spawned session's unsaved work
 * is the operator's to resolve; gc reports it and moves on. Committed work is
 * covered separately, by deleting the branch with -d rather than -D.
 *
 * `auto` marks the unattended timer sweep (the `sweep` verb): it reports
 * nothing on success and skips brand-new worktrees, per AUTO_SWEEP_MIN_AGE_MS.
 */
function gc(auto = false): number {
  const root = repoRoot();
  const worktrees = bridgeWorktrees(root);
  if (worktrees.length === 0) return 0;

  const cwds = liveCwds();
  if (cwds === null) {
    console.error('[rc-server] cannot determine session liveness (no readable /proc, and no usable lsof on darwin) — skipping gc.');
    return 0;
  }

  const branches = worktreeBranches(root);
  let removed = 0;
  for (const { name, dir } of worktrees) {
    if (inUse(cwds, dir)) continue;
    if (auto && worktreeAgeMs(dir) < AUTO_SWEEP_MIN_AGE_MS) continue;
    // Untracked files count: a spawned session's new files are usually the work.
    if (sh('git', ['-C', dir, 'status', '--porcelain']).stdout.trim()) {
      if (!auto) console.log(`kept ${name} (uncommitted changes)`);
      continue;
    }
    sh('git', ['-C', root, 'worktree', 'unlock', dir]); // absent lock → non-zero, ignored
    if (
      sh('git', ['-C', root, 'worktree', 'remove', dir]).status !== 0 &&
      sh('git', ['-C', root, 'worktree', 'remove', '--force', dir]).status !== 0
    ) {
      console.error(`[rc-server] could not remove ${name} — left in place.`);
      continue;
    }
    // -d, not -D: the dirty check above only catches *uncommitted* work, so a
    // session that committed and never pushed still reads as clean here. -d
    // refuses an unmerged branch, leaving a stray local branch rather than
    // destroying the commits behind it.
    const branch = branches.get(dir);
    if (branch) sh('git', ['-C', root, 'branch', '-d', branch]);
    if (!auto) console.log(`removed ${name}`);
    removed++;
  }
  if (removed) sh('git', ['-C', root, 'worktree', 'prune']);
  return 0;
}

function stop(): number {
  if (sessionAlive()) {
    sh('tmux', ['kill-session', '-t', TMUX_SESSION]);
    console.log('closed');
  } else {
    console.log('down');
  }
  return gc();
}

function main(argv: string[]): number {
  switch (argv[0]) {
    case 'start': return start();
    case 'stop': return stop();
    case 'status': console.log(statusLine()); return 0;
    case 'gc': return gc();
    case 'sweep': return gc(true);
    default:
      console.error('Usage: hermitd-run rc-server <start|stop|status|gc|sweep>');
      return 2;
  }
}

process.exit(main(process.argv.slice(2)));
