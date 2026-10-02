// Resolve the nearest .hermit dir that has a config.json:
// CLAUDE_PROJECT_DIR when it names one, else a walk up from startDir (max 8
// levels). Returns that dir, or null when none is found.
//
// Returning null (rather than a fail-open default path) is load-bearing:
// git-push-guard falls back to the built-in protected-branch list on null instead
// of blocking. The guards read config here. Do NOT change this to core's fail-open hermitDir() default.
//
// The env check is sentinel-gated and falls through on a miss, so a stale
// CLAUDE_PROJECT_DIR degrades to the walk (today's behavior) rather than to null
// or to some unrelated project's store. Hook stdin carries a `cwd`, but it is the
// session's drifted shell cwd — identical to this process's own — so it anchors
// nothing and is deliberately not consulted.
//
// INVARIANT: mirrors core's cc-compat.ts hermitDir() shape (same 8-level cap,
// same config.json sentinel, same worktree-projection skip, env checked before
// the walk) — if you change the walk or the precedence here, check that file too.
// One deliberate difference: core's CLAUDE_PROJECT_DIR branch accepts a bare
// `.hermit/` while this one requires the config.json sentinel, so a
// CLAUDE_PROJECT_DIR naming a scaffolded-but-unhatched project resolves there for
// core and falls through to the walk here.

import fs from 'node:fs';
import path from 'node:path';

// A worktree's projected `.hermit/` — never a resolution target.
// `.worktreeinclude`'s managed block copies config.json into a worktree so
// skills can Read it at the relative path they expect, but never `state/`:
// hermit state is main-rooted and shared across worktrees. So the sentinel
// without `state/` means a projection of a real root further up, and the walk
// continues to it. Mirrored in core's cc-compat.ts: fix one, fix both.
function isWorktreeProjection(cchDir: string): boolean {
  return fs.existsSync(path.join(cchDir, 'config.json')) && !fs.existsSync(path.join(cchDir, 'state'));
}

export function findHermitDir(startDir: string): string | null {
  const proj = process.env.CLAUDE_PROJECT_DIR;
  const fromEnv = proj ? path.join(proj, '.hermit') : null;
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'config.json')) && !isWorktreeProjection(fromEnv)) {
    return fromEnv;
  }
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const cch = path.join(dir, '.hermit');
    if (fs.existsSync(path.join(cch, 'config.json')) && !isWorktreeProjection(cch)) return cch;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
