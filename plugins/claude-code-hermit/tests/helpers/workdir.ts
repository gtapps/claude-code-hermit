// Throwaway workdir scaffolding — TypeScript port of tests/lib.sh
// setup_workdir / setup_git_workdir / cleanup.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const fixturesDir = path.resolve(import.meta.dir, '../fixtures');

export interface Workdir {
  dir: string;
  cleanup(): void;
}

export function setupWorkdir(): Workdir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-hooks-'));
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.copyFileSync(
    path.join(fixturesDir, 'shell-session.md'),
    path.join(dir, '.claude-code-hermit', 'sessions', 'SHELL.md'),
  );
  fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'OPERATOR.md'), '');
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// Test-body factory: wraps a test in a throwaway workdir, always cleaning up.
// Safe under `bun test --concurrent` — each call gets its own mkdtemp dir and
// cleans up only its own dir. Usage: test('name', withDir(async (dir) => {...}))
export function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

// Batch-cleanup factory for the freshDir()/tmpdirs pattern duplicated across
// several test files (each mkdtemps eagerly per-test but defers all removal to
// a single afterAll). Safe under `bun test --concurrent`: cleanup runs only
// after every test in the file has finished, so no concurrently-running
// test's dir is ever deleted out from under it.
// Usage: const { freshDir, cleanup } = freshDirFactory('hermit-foo-'); afterAll(cleanup);
export function freshDirFactory(prefix: string) {
  const tmpdirs: string[] = [];
  return {
    freshDir(): string {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tmpdirs.push(d);
      return d;
    },
    cleanup(): void {
      for (const d of tmpdirs.splice(0)) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

// Same as setupWorkdir but initialises a git repo (needed by session-diff).
export function setupGitWorkdir(): Workdir {
  const wd = setupWorkdir();
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: wd.dir, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=test', '-c', 'user.email=test@test', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'init');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@test', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'add fixtures');
  fs.writeFileSync(path.join(wd.dir, 'newfile.txt'), 'new\n');
  git('add', 'newfile.txt');
  return wd;
}
