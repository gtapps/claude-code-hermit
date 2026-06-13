// Regression tests for #384 — hook cwd-drift bug class.
//
// Each test simulates the exact failure mode: hook fires with cwd pinned inside
// .claude-code-hermit/ (the paulinho field-report trigger). Before the fix,
// validate-config would read .claude-code-hermit/.claude-code-hermit/config.json
// (ENOENT → exit 2). The others would silently write to wrong paths.
//
// Env discipline: opts.env overrides process.env in run.ts (spread order is
// { ...process.env, ...opts.env }), so setting a key here wins over the ambient
// CC session value. To force walk-up (branch 3 of hermitDir), we point
// CLAUDE_PROJECT_DIR at a nonexistent path and AGENT_DIR to a relative value.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { setupGitWorkdir } from './helpers/workdir';

// -------------------------------------------------------------------------
// Fixture
// -------------------------------------------------------------------------

let tmpRoot: string;       // project root — contains .claude-code-hermit/
let hermitDir: string;     // tmpRoot/.claude-code-hermit
let driftedCwd: string;    // tmpRoot/.claude-code-hermit/state  (the bug's cwd)

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
  hermitDir = path.join(tmpRoot, '.claude-code-hermit');
  driftedCwd = path.join(hermitDir, 'state');
  fs.mkdirSync(driftedCwd, { recursive: true });
  // Minimal config.json
  fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({
    agent_name: null, language: null, timezone: null,
    escalation: 'conservative', channels: {}, env: {},
    heartbeat: { enabled: false }, routines: [], quality_gate: { tier: 'balanced' },
  }));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Force hermitDir() walk-up branch: CLAUDE_PROJECT_DIR nonexistent, AGENT_DIR relative
function driftEnv(): Record<string, string> {
  return {
    AGENT_DIR: '.claude-code-hermit',           // relative — ignored by hermitDir()
    CLAUDE_PROJECT_DIR: '/nonexistent-path',    // existsSync fails — falls to walk-up
  };
}

// -------------------------------------------------------------------------
// Tier 1: validate-config (the reported bug)
// -------------------------------------------------------------------------

describe('validate-config with drifted cwd (#384 regression)', () => {
  it('exits 0 for valid config when cwd is inside .claude-code-hermit/', async () => {
    // Before fix: readFileSync(path.resolve('.claude-code-hermit/config.json')) from
    // driftedCwd = .../state → read .../state/.claude-code-hermit/config.json → ENOENT → exit 2
    // After fix: reads filePath (absolute from payload) directly → exit 0
    const payload = JSON.stringify({
      tool: 'Edit',
      tool_input: { file_path: path.join(hermitDir, 'config.json') },
    });
    const result = await runScript('validate-config.ts', {
      stdin: payload,
      cwd: driftedCwd,    // drifted: inside .claude-code-hermit/state
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('[config-validate] OK');
  });

  it('still exits 2 for invalid config (double-path fix does not break validation)', async () => {
    const badConfig = JSON.stringify({ escalation: 'bad-value', channels: {}, env: {}, heartbeat: {}, routines: [], quality_gate: {} });
    const badConfigPath = path.join(hermitDir, 'config-bad.json');
    fs.writeFileSync(badConfigPath, badConfig);
    const payload = JSON.stringify({
      tool: 'Edit',
      // Spoof basename as config.json so the basename gate passes
      tool_input: { file_path: path.join(path.dirname(badConfigPath), 'config.json') },
    });
    // Write bad config to the path the hook will read
    fs.writeFileSync(path.join(hermitDir, 'config.json'), badConfig);
    try {
      const result = await runScript('validate-config.ts', {
        stdin: payload,
        cwd: driftedCwd,
      });
      expect(result.exitCode).toBe(2);
    } finally {
      // Restore valid config
      fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({
        agent_name: null, language: null, timezone: null,
        escalation: 'conservative', channels: {}, env: {},
        heartbeat: { enabled: false }, routines: [], quality_gate: { tier: 'balanced' },
      }));
    }
  });
});

// -------------------------------------------------------------------------
// Tier 2: record-operator-action (payload-less hook, uses hermitDir)
// -------------------------------------------------------------------------

describe('record-operator-action with drifted cwd', () => {
  it('writes last-operator-action.json to the correct hermit dir via walk-up', async () => {
    const statePath = path.join(hermitDir, 'state', 'last-operator-action.json');
    // Remove if exists from a previous run
    try { fs.unlinkSync(statePath); } catch {}

    const payload = JSON.stringify({ prompt: 'hello' });
    const result = await runScript('record-operator-action.ts', {
      stdin: payload,
      cwd: driftedCwd,
      env: driftEnv(),   // force walk-up: no absolute AGENT_DIR, no valid CLAUDE_PROJECT_DIR
    });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(statePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(typeof written.at).toBe('string');

    // Sanity: confirm the wrong doubled path was NOT created
    const wrongPath = path.join(driftedCwd, '.claude-code-hermit', 'state', 'last-operator-action.json');
    expect(fs.existsSync(wrongPath)).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Tier 2: generate-summary (has file_path — anchors on payload)
// -------------------------------------------------------------------------

describe('generate-summary with drifted cwd', () => {
  it('regenerates state-summary.md in the correct state dir from absolute filePath', async () => {
    // Seed the state files generate-summary reads
    const stateDir = path.join(hermitDir, 'state');
    fs.writeFileSync(path.join(stateDir, 'alert-state.json'), JSON.stringify({}));

    const editedFile = path.join(stateDir, 'alert-state.json');
    const payload = JSON.stringify({
      tool: 'Edit',
      tool_input: { file_path: editedFile },
    });

    const summaryPath = path.join(stateDir, 'state-summary.md');
    // Remove if exists from a previous run
    try { fs.unlinkSync(summaryPath); } catch {}

    const result = await runScript('generate-summary.ts', {
      stdin: payload,
      cwd: driftedCwd,
    });

    expect(result.exitCode).toBe(0);
    // Confirm it wrote to the correct absolute path (not doubled)
    expect(fs.existsSync(summaryPath)).toBe(true);

    const wrongSummary = path.join(driftedCwd, '.claude-code-hermit', 'state', 'state-summary.md');
    expect(fs.existsSync(wrongSummary)).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Tier 2: session-diff (debounce reads state/runtime.json — driven via stop-pipeline)
// -------------------------------------------------------------------------
//
// session-diff's run() debounce reads state/runtime.json to decide whether to
// skip the sidecar rewrite. Before the fix that path resolved via cwd, so a
// drifted cwd made the read ENOENT → forceRefresh=true → the sidecar was rewritten
// even when the debounce should have skipped. run() is only reachable through
// stop-pipeline (the import.meta.main entry bypasses the debounce), so we drive it
// there with a git-backed workdir (setupGitWorkdir seeds an uncommitted file, so
// the bug path's captureDiff is non-empty and the rewrite is observable).

describe('session-diff debounce with drifted cwd (#384 regression)', () => {
  it('skips the sidecar rewrite when cwd is inside .claude-code-hermit/ (runtime.json resolved via hermitDir)', async () => {
    const wd = setupGitWorkdir();
    try {
      const cch = path.join(wd.dir, '.claude-code-hermit');
      // walk-up anchor: hermitDir() recovers the root via config.json
      fs.writeFileSync(path.join(cch, 'config.json'), '{}');
      fs.writeFileSync(path.join(cch, 'state', 'runtime.json'), '{"session_state":"in_progress"}');
      const sidecar = path.join(cch, 'state', 'session-diff.json');
      fs.writeFileSync(sidecar, '{"changed_files":[],"captured_at":"2026-01-01T00:00:00Z"}');
      // Backdate 5s — still inside the 60s debounce window, so a rewrite is detectable.
      const past = new Date(Date.now() - 5000);
      fs.utimesSync(sidecar, past, past);
      const before = fs.statSync(sidecar).mtimeMs;

      await runScript('stop-pipeline.ts', {
        stdin: '{}',
        cwd: path.join(cch, 'state'),              // drifted: inside .claude-code-hermit/
        env: {
          ...driftEnv(),                           // force walk-up (relative AGENT_DIR + nonexistent CLAUDE_PROJECT_DIR)
          AGENT_HOOK_PROFILE: 'standard',
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        },
      });

      // After fix: in_progress + fresh sidecar → debounce skip → mtime unchanged.
      // Before fix: runtime.json unreadable → forceRefresh → captureDiff rewrites it.
      expect(fs.statSync(sidecar).mtimeMs).toBe(before);
    } finally {
      wd.cleanup();
    }
  });
});
