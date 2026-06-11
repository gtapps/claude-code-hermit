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
