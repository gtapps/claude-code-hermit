// Unit tests for hermitDir() — the project-root resolver added in #384.
//
// IMPORTANT: each case explicitly controls CLAUDE_PROJECT_DIR and AGENT_DIR before
// importing the module, because the test process inherits the real env when run
// inside a CC session. An ambient CLAUDE_PROJECT_DIR would silently satisfy
// branch (2) and hide cwd-drift bugs the tests are meant to catch.
//
// Strategy: dynamically re-import cc-compat.ts for each case so the module-level
// `process.env` reads happen fresh. Bun re-evaluates dynamic imports per module
// instance only when the module hasn't been cached — so we manipulate env before
// each call and restore it after.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makeTmpHermit(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-test-'));
  fs.mkdirSync(path.join(tmp, '.claude-code-hermit', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude-code-hermit', 'config.json'), '{}');
  return tmp;
}

// Save + restore env vars per test
let savedEnv: Record<string, string | undefined> = {};
function saveEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = {};
}

// hermitDir() reads process.env at call time (not module load time), so we can
// import once and control env per-call.
const { hermitDir } = await import('../scripts/lib/cc-compat');

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('hermitDir()', () => {
  let tmp: string;
  let origCwd: string;

  beforeEach(() => {
    tmp = makeTmpHermit();
    origCwd = process.cwd();
    saveEnv('AGENT_DIR', 'CLAUDE_PROJECT_DIR');
    // Clear both so tests start from a clean slate
    delete process.env.AGENT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    restoreEnv();
    try { process.chdir(origCwd); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('(a) absolute AGENT_DIR wins over CLAUDE_PROJECT_DIR and drifted cwd', () => {
    const agentDir = path.join(tmp, '.claude-code-hermit');
    // Set a conflicting CLAUDE_PROJECT_DIR pointing somewhere else
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-other-'));
    try {
      fs.mkdirSync(path.join(other, '.claude-code-hermit'), { recursive: true });
      fs.writeFileSync(path.join(other, '.claude-code-hermit', 'config.json'), '{}');
      process.env.AGENT_DIR = agentDir;
      process.env.CLAUDE_PROJECT_DIR = other;
      // cwd is unrelated
      expect(hermitDir()).toBe(agentDir);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('(b) relative AGENT_DIR is ignored — falls through to CLAUDE_PROJECT_DIR', () => {
    // This is the legacy registration shape that CAUSED #384: AGENT_DIR=".claude-code-hermit"
    process.env.AGENT_DIR = '.claude-code-hermit'; // relative — must be ignored
    process.env.CLAUDE_PROJECT_DIR = tmp;
    expect(hermitDir()).toBe(path.join(tmp, '.claude-code-hermit'));
  });

  it.serial('(c) CLAUDE_PROJECT_DIR set, cwd drifted — env branch wins', () => {
    // Simulate the #384 trigger: cwd drifted inside .claude-code-hermit/
    delete process.env.AGENT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp;
    process.chdir(path.join(tmp, '.claude-code-hermit', 'state'));
    expect(hermitDir()).toBe(path.join(tmp, '.claude-code-hermit'));
  });

  it.serial('(d) no env vars, cwd drifted into subdir — walk-up recovers', () => {
    delete process.env.AGENT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    process.chdir(path.join(tmp, '.claude-code-hermit', 'state'));
    expect(hermitDir()).toBe(path.join(tmp, '.claude-code-hermit'));
  });

  it.serial('(e) no env vars, unrelated cwd — fail-open returns resolved .claude-code-hermit', () => {
    delete process.env.AGENT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    // Use a tmpdir with no hermit (walk-up finds nothing)
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-bare-'));
    try {
      process.chdir(bare);
      const result = hermitDir();
      // Should be path.resolve('.claude-code-hermit') from the bare dir
      expect(result).toBe(path.join(bare, '.claude-code-hermit'));
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it.serial('(b2) CLAUDE_PROJECT_DIR set but .claude-code-hermit subdir absent — falls to walk-up', () => {
    // existsSync guard: if CLAUDE_PROJECT_DIR doesn't actually have a .cch dir, skip it
    delete process.env.AGENT_DIR;
    const noHermit = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-noh-'));
    try {
      process.env.CLAUDE_PROJECT_DIR = noHermit; // no .claude-code-hermit inside
      process.chdir(path.join(tmp, '.claude-code-hermit', 'state'));
      // Walk-up from drifted cwd finds tmp's hermit dir
      expect(hermitDir()).toBe(path.join(tmp, '.claude-code-hermit'));
    } finally {
      fs.rmSync(noHermit, { recursive: true, force: true });
    }
  });
});
