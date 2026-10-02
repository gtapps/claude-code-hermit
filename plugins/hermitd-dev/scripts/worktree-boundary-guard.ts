// PreToolUse hook (Edit|Write). When the session runs inside a linked git worktree,
// block any edit whose target escapes the worktree into the main checkout. The guard is
// self-limiting: it exits 0 in any non-worktree session, so there is no profile gate.
// Fail-open — every error path exits 0 (a hook must never break the tool). Disable with
// WORKTREE_GUARD=off.

import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_STDIN = 1024 * 1024;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// True when `child` is `parent` itself or nested beneath it.
function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function main() {
  const guardOff = (process.env.WORKTREE_GUARD || '').trim().toLowerCase() === 'off';

  // Drain stdin to completion (avoids broken-pipe errors) with a size cap: past
  // the cap we stop buffering but keep consuming to EOF. This runs BEFORE the
  // WORKTREE_GUARD gate — exiting on the env switch without reading would leave
  // the pipe half-read for any payload larger than the pipe buffer. When the
  // guard is off the payload is never parsed, so consume without buffering.
  const chunks: Buffer[] = [];
  let total = 0;
  let oversize = false;
  for await (const chunk of process.stdin) {
    if (guardOff) continue;
    total += chunk.length;
    if (total > MAX_STDIN) { oversize = true; continue; }
    chunks.push(chunk);
  }
  if (guardOff) process.exit(0);
  if (oversize) process.exit(0);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) process.exit(0);

  let filePath: string;
  try {
    const input = JSON.parse(raw).tool_input || {};
    filePath = input.file_path;
  } catch { process.exit(0); }
  if (!filePath || typeof filePath !== 'string') process.exit(0);

  const cwd = process.cwd();

  // Detect linked-worktree context (the real gate). Fail open if git is unavailable or
  // this is not a repo.
  let gitDir: string, commonDir: string, worktreeRoot: string;
  try {
    // One rev-parse call emits one line per flag, in flag order (git resolves left to right).
    const revParse = git(['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'], cwd).split('\n');
    gitDir = revParse[0];
    commonDir = path.resolve(cwd, revParse[1]);
    if (gitDir === commonDir) process.exit(0); // main checkout, not a linked worktree
    worktreeRoot = revParse[2];
  } catch { process.exit(0); }

  const mainRoot = path.dirname(commonDir); // the main .git lives at <mainRoot>/.git
  const target = path.resolve(cwd, filePath);

  if (isUnder(target, worktreeRoot)) process.exit(0);
  // Carve-out: shared hermit state resolves up to the main checkout's gitignored
  // .hermit/ (tasks/, state/): those writes are legitimate.
  if (isUnder(target, path.join(mainRoot, '.hermit'))) process.exit(0);
  // Block: escapes into the main checkout (or a sibling worktree nested under it).
  if (isUnder(target, mainRoot)) {
    console.error(`[worktree-boundary-guard] BLOCKED: ${target} is in the main checkout, not this worktree (${worktreeRoot}). Edit inside the worktree. In a background session the harness isolates you into a worktree on your first edit — this block is not a rule violation, just re-attempt the edit against the worktree path.`);
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
