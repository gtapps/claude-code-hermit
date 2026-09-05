// `hermit-run memory-dir [<project-root>]` — prints the project's auto-memory
// directory as one JSON line: {"dir": <absolute>, "exists": <boolean>}.
//
// Claude Code keys that directory off the project root with its own path-key
// scheme and honours CLAUDE_CONFIG_DIR, so every consumer that derived it in
// prose got it wrong under a worktree or a container. The weekly review and the
// backup restore recipe ask this instead.
//
// The derivation matches Claude Code when the project root is the main git
// checkout or a plain directory. Three cases are not resolved, and the derived
// path is reported anyway: a hermit rooted in a repository subdirectory; a
// session running from a git worktree (Claude Code keys auto-memory off the
// main checkout, so the worktree path names a directory it never reads); and an
// install that sets `autoMemoryDirectory` or `CLAUDE_CODE_PROJECT_DIR_NAME`.

import fs from 'node:fs';
import path from 'node:path';

import { hermitDir, memoryDirFor } from './lib/cc-compat';

export function memoryDirInfo(projectRoot: string): { dir: string; exists: boolean } {
  const dir = memoryDirFor(path.resolve(projectRoot));
  return { dir, exists: fs.existsSync(dir) };
}

if (import.meta.main) {
  const projectRoot = process.argv[2] || path.dirname(hermitDir());
  console.log(JSON.stringify(memoryDirInfo(projectRoot)));
  process.exit(0);
}
