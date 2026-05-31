'use strict';

// PreToolUse hook (Edit|Write). When the session runs inside a linked git worktree,
// block any edit whose target escapes the worktree into the main checkout. The guard is
// self-limiting: it exits 0 in any non-worktree session, so there is no profile gate.
// Fail-open — every error path exits 0 (a hook must never break the tool). Disable with
// WORKTREE_GUARD=off.

const path = require('path');
const { execFileSync } = require('child_process');

const MAX_STDIN = 1024 * 1024;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// True when `child` is `parent` itself or nested beneath it.
function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function main() {
  if ((process.env.WORKTREE_GUARD || '').trim().toLowerCase() === 'off') process.exit(0);

  // Drain stdin to completion (avoids broken-pipe errors) with a size cap.
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN) process.exit(0);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) process.exit(0);

  let filePath;
  try {
    const input = JSON.parse(raw).tool_input || {};
    filePath = input.file_path;
  } catch { process.exit(0); }
  if (!filePath || typeof filePath !== 'string') process.exit(0);

  const cwd = process.cwd();

  // Detect linked-worktree context (the real gate). Fail open if git is unavailable or
  // this is not a repo.
  let gitDir, commonDir, worktreeRoot;
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
  // .claude-code-hermit/ (SHELL.md, sessions/, state/) — those writes are legitimate.
  if (isUnder(target, path.join(mainRoot, '.claude-code-hermit'))) process.exit(0);
  // Block: escapes into the main checkout (or a sibling worktree nested under it).
  if (isUnder(target, mainRoot)) {
    console.error(`[worktree-boundary-guard] BLOCKED: ${target} is in the main checkout, not this worktree (${worktreeRoot}). Edit inside the worktree.`);
    process.exit(2);
  }

  process.exit(0);
}

main();
