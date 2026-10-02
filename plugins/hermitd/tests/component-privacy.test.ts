// Contract tests for scripts/component-privacy.ts — the PostToolUse hook that
// keeps a hermit-created skill/agent private to this install (git-common-dir
// info/exclude) when hatch_target is local and the write came from the
// managed always-on session. Exercised as a subprocess (stdin in, exit code +
// filesystem effect out), the same boundary Claude Code sees.
//
// Usage: bun test tests/component-privacy.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { runScript } from './helpers/run';
import { setupWorkdir, setupGitWorkdir, type Workdir } from './helpers/workdir';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

function setTarget(dir: string, target: string) {
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  fs.writeFileSync(hermit(dir, 'state', 'hatch-options.json'), JSON.stringify({ target }));
}

function writePayload(dir: string, rel: string, content = 'stub\n') {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { tool_name: 'Write', tool_input: { file_path: rel, content } };
}

function commitTrackedFile(dir: string, rel: string, content = 'stub\n') {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  execFileSync('git', ['add', rel], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `add ${rel}`], { cwd: dir });
}

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

function withGitDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupGitWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const run = (payload: object, dir: string, env: Record<string, string> = {}) =>
  runScript('component-privacy.ts', {
    stdin: JSON.stringify(payload),
    cwd: dir,
    env: { HERMIT_MANAGED: '1', AGENT_DIR: hermit(dir), ...env },
  });

function excludeText(commonDir: string): string {
  try { return fs.readFileSync(path.join(commonDir, 'info', 'exclude'), 'utf-8'); } catch { return ''; }
}

describe('component-privacy', () => {
  test('untracked hermit-created skill, target local, HERMIT_MANAGED=1 — excluded', withGitDir(async (dir) => {
    setTarget(dir, 'local');
    const payload = writePayload(dir, '.claude/skills/x/SKILL.md');
    const r = await run(payload, dir);
    expect(r.exitCode).toBe(0);
    expect(excludeText(path.join(dir, '.git'))).toContain('.claude/skills/x/');
  }));

  test('idempotent — second write adds no duplicate line', withGitDir(async (dir) => {
    setTarget(dir, 'local');
    const payload = writePayload(dir, '.claude/skills/x/SKILL.md');
    await run(payload, dir);
    await run(payload, dir);
    const text = excludeText(path.join(dir, '.git'));
    expect(text.split('\n').filter(l => l === '.claude/skills/x/').length).toBe(1);
  }));

  test('already-tracked path — never excluded (safety invariant)', withGitDir(async (dir) => {
    setTarget(dir, 'local');
    const rel = '.claude/skills/tracked-one/SKILL.md';
    commitTrackedFile(dir, rel);
    const payload = { tool_name: 'Edit', tool_input: { file_path: rel } };
    const r = await run(payload, dir);
    expect(r.exitCode).toBe(0);
    expect(excludeText(path.join(dir, '.git'))).not.toContain('tracked-one');
  }));

  test('new file inside an already-tracked skill dir — dir never excluded', withGitDir(async (dir) => {
    setTarget(dir, 'local');
    const tracked = '.claude/skills/operator-skill/SKILL.md';
    commitTrackedFile(dir, tracked, 'operator-authored\n');
    const payload = writePayload(dir, '.claude/skills/operator-skill/reference.md');
    const r = await run(payload, dir);
    expect(r.exitCode).toBe(0);
    expect(excludeText(path.join(dir, '.git'))).not.toContain('operator-skill');
  }));

  test('hermit project in a repo subdirectory — rule is anchored at the repo root', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-sub-')));
    try {
      const proj = path.join(root, 'proj');
      fs.mkdirSync(proj, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
      setTarget(proj, 'local');
      fs.writeFileSync(hermit(proj, 'config.json'), '{}');
      const payload = writePayload(proj, '.claude/skills/sub/SKILL.md');
      const r = await run(payload, proj, { AGENT_DIR: hermit(proj) });
      expect(r.exitCode).toBe(0);
      expect(excludeText(path.join(root, '.git'))).toContain('proj/.claude/skills/sub/');
      const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf-8' });
      expect(status).not.toContain('.claude/skills/sub/SKILL.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('HERMIT_MANAGED unset — untouched', withGitDir(async (dir) => {
    setTarget(dir, 'local');
    const payload = writePayload(dir, '.claude/skills/y/SKILL.md');
    const r = await run(payload, dir, { HERMIT_MANAGED: '' });
    expect(r.exitCode).toBe(0);
    expect(excludeText(path.join(dir, '.git'))).not.toContain('.claude/skills/y/');
  }));

  test('target committed — untouched', withGitDir(async (dir) => {
    setTarget(dir, 'committed');
    const payload = writePayload(dir, '.claude/skills/z/SKILL.md');
    const r = await run(payload, dir);
    expect(r.exitCode).toBe(0);
    expect(excludeText(path.join(dir, '.git'))).not.toContain('.claude/skills/z/');
  }));

  test('path outside .claude/skills or .claude/agents — untouched', withGitDir(async (dir) => {
    setTarget(dir, 'local');
    const payload = writePayload(dir, 'src/index.ts');
    const r = await run(payload, dir);
    expect(r.exitCode).toBe(0);
    expect(excludeText(path.join(dir, '.git'))).not.toContain('src/index.ts');
  }));

  test('no git repo — exits 0, no throw, no file created', withDir(async (dir) => {
    setTarget(dir, 'local');
    const payload = writePayload(dir, '.claude/skills/w/SKILL.md');
    const r = await run(payload, dir);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
  }));

  test('repo with no .git/info dir — the dir is created and the rule still lands', withGitDir(async (dir) => {
    setTarget(dir, 'local');
    fs.rmSync(path.join(dir, '.git', 'info'), { recursive: true, force: true });
    const payload = writePayload(dir, '.claude/skills/noinfo/SKILL.md');
    const r = await run(payload, dir);
    expect(r.exitCode).toBe(0);
    expect(excludeText(path.join(dir, '.git'))).toContain('.claude/skills/noinfo/');
  }));

  test('worktree — rule lands in the main repo common dir, not the worktree git-dir', withGitDir(async (dir) => {
    setTarget(dir, 'local');
    const wtPath = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hermit-wt-'));
    fs.rmSync(wtPath, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '-b', 'wt-branch', wtPath], { cwd: dir });
    try {
      fs.mkdirSync(hermit(wtPath, 'state'), { recursive: true });
      fs.writeFileSync(hermit(wtPath, 'state', 'hatch-options.json'), JSON.stringify({ target: 'local' }));
      const payload = writePayload(wtPath, '.claude/skills/wt/SKILL.md');
      const r = await run(payload, wtPath, { AGENT_DIR: hermit(wtPath) });
      expect(r.exitCode).toBe(0);
      expect(excludeText(path.join(dir, '.git'))).toContain('.claude/skills/wt/');
      // git names the per-worktree admin dir after the worktree PATH, not the branch.
      expect(fs.existsSync(path.join(dir, '.git', 'worktrees', path.basename(wtPath), 'info', 'exclude'))).toBe(false);
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: dir });
    }
  }));

  test('hatch-options.json missing — exits 0, no throw', withGitDir(async (dir) => {
    const payload = writePayload(dir, '.claude/skills/v/SKILL.md');
    const r = await run(payload, dir);
    expect(r.exitCode).toBe(0);
    expect(excludeText(path.join(dir, '.git'))).not.toContain('.claude/skills/v/');
  }));
});
