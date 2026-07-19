// session-archive.ts is the deterministic replacement for the session-mgr subagent
// (agents/session-mgr.md, deleted). It owns every session-lifecycle write: idle
// transitions, operator/auto close, session open, and interrupted-transition recovery.
//
// This suite is the safety gate the PR-2 plan required before any skill cuts over to
// the script: durability (atomic writes, corrupt/ioerror handling), the explicit
// ok:boolean outcome contract, S-NNN/frontmatter/reset correctness, the transition_mode
// branch (+ legacy-marker fallback) that lets `recover` pick the right cleanup path,
// and the exhaustive recovery matrix.
//
// Golden-equivalence note: rather than live-dispatching the session-mgr subagent
// against real hermit state to capture a byte-for-byte reference (risky — this repo's
// own .claude-code-hermit/ is the maintainer's live dev session, and the Agent tool has
// no way to redirect a dispatched subagent's cwd to an isolated scratch directory), this
// suite verifies STRUCTURAL equivalence against the spec instead: every frontmatter key
// and section heading session-mgr.md/SESSION-REPORT.md.template define, produced from
// the same deterministic field-extraction rules the agent spec itself gave (regex/
// copy-through, no free-form composition). This is the safer of the two bars the PR-2
// plan allowed for, chosen without needing to prove or disprove LLM output stability.
//
// Usage: bun test tests/session-archive.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';
import { readFrontmatter } from '../scripts/lib/frontmatter';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const sessionsDir = (dir: string) => hermit(dir, 'sessions');
const statePath = (dir: string) => hermit(dir, 'state', 'runtime.json');
const shellPath = (dir: string) => hermit(dir, 'sessions', 'SHELL.md');

const SHELL_TEMPLATE = fs.readFileSync(
  path.join(import.meta.dir, '..', 'state-templates', 'SHELL.md.template'), 'utf-8'
);

interface Tmp { dir: string; cleanup(): void }

function makeDir(): Tmp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-archdur-'));
  fs.mkdirSync(hermit(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  fs.mkdirSync(hermit(dir, 'templates'), { recursive: true });
  fs.writeFileSync(hermit(dir, 'templates', 'SHELL.md.template'), SHELL_TEMPLATE);
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ escalation: 'balanced', timezone: 'UTC' }));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function withTmp(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const t = makeDir();
    try { await fn(t.dir); } finally { t.cleanup(); }
  };
}

async function archive(dir: string, mode: string, payload: string, now: string) {
  const r = await runScript('session-archive.ts', {
    args: ['archive', `--mode=${mode}`, `--state-dir=${hermit(dir)}`],
    stdin: payload,
    env: { HERMIT_NOW: now },
  });
  return JSON.parse(r.stdout.trim());
}

async function open(dir: string, payload: string, now: string) {
  const r = await runScript('session-archive.ts', {
    args: ['open', `--state-dir=${hermit(dir)}`],
    stdin: payload,
    env: { HERMIT_NOW: now },
  });
  return JSON.parse(r.stdout.trim());
}

async function recover(dir: string, now: string) {
  const r = await runScript('session-archive.ts', {
    args: ['recover', `--state-dir=${hermit(dir)}`],
    env: { HERMIT_NOW: now },
  });
  return JSON.parse(r.stdout.trim());
}

function writeRuntime(dir: string, obj: object) {
  fs.writeFileSync(statePath(dir), JSON.stringify(obj));
}
function readRuntime(dir: string): any {
  return JSON.parse(fs.readFileSync(statePath(dir), 'utf-8'));
}
function writeShell(dir: string, content: string) {
  fs.writeFileSync(shellPath(dir), content);
}
function readShell(dir: string): string {
  return fs.readFileSync(shellPath(dir), 'utf-8');
}

const BASIC_CLOSE_PAYLOAD =
  'Status: completed\nBlockers: none\nLessons: none\nChanged: none\nArtifacts: none\n' +
  'Cost: $0.4231 (152689 tokens)\nClosed Via: operator\nNext Start Point: pick up here\n';

// Seeds .claude/cost-log.jsonl next to the hermit dir — costLogPath(hermit(dir))
// resolves to path.join(dir, '.claude', 'cost-log.jsonl').
function seedCostLog(dir: string, entries: Array<{ timestamp: string; estimated_cost_usd: number; total_tokens: number }>) {
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'cost-log.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// =============================================================================
describe('durability', () => {
  test('open + archive leave no .tmp sibling anywhere under the hermit dir', withTmp(async (dir) => {
    await open(dir, 'Task: test task\n', '2026-07-09T12:00:00Z');
    await archive(dir, 'idle', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const leaked = walk(hermit(dir)).filter(f => f.includes('.tmp'));
    expect(leaked).toEqual([]);
  }));

  test('corrupt runtime.json is quarantined, never silently clobbered', withTmp(async (dir) => {
    fs.writeFileSync(statePath(dir), '{not valid json');
    const result = await recover(dir, '2026-07-09T12:00:00Z');
    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('runtime-corrupt-quarantined');
    const files = fs.readdirSync(hermit(dir, 'state'));
    expect(files.some(f => f.startsWith('runtime.json.corrupt-'))).toBe(true);
  }));

  test('ioerror on runtime.json read declines to write, leaves state untouched', withTmp(async (dir) => {
    // A directory at the runtime.json path forces EISDIR on read — the tri-state
    // reader must classify this as ioerror and refuse to write, not seed {} over it.
    fs.rmSync(statePath(dir), { force: true });
    fs.mkdirSync(statePath(dir));
    const result = await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('runtime-ioerror');
    expect(fs.statSync(statePath(dir)).isDirectory()).toBe(true);
  }));

  test('missing runtime.json seeds cleanly via open (first run)', withTmp(async (dir) => {
    const result = await open(dir, 'Task: first ever task\n', '2026-07-09T12:00:00Z');
    expect(result.ok).toBe(true);
    expect(result.session_id).toBe('S-001');
    expect(readRuntime(dir).session_state).toBe('in_progress');
  }));
});

// =============================================================================
describe('outcome contract', () => {
  test('archive requires --mode', withTmp(async (dir) => {
    const r = await runScript('session-archive.ts', { args: ['archive', `--state-dir=${hermit(dir)}`], stdin: BASIC_CLOSE_PAYLOAD });
    const result = JSON.parse(r.stdout.trim());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('requires --mode');
  }));

  test('archive with missing SHELL.md returns ok:false, not a thrown error', withTmp(async (dir) => {
    const result = await archive(dir, 'close', BASIC_CLOSE_PAYLOAD, '2026-07-09T12:00:00Z');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('shell-missing');
  }));

  test('unparseable stdin payload returns ok:false', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    const result = await archive(dir, 'idle', 'this is just prose, no recognized keys at all', '2026-07-09T13:00:00Z');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('payload-unparseable');
  }));

  test('unknown verb returns ok:false listing valid verbs', withTmp(async (dir) => {
    const r = await runScript('session-archive.ts', { args: ['bogus'] });
    const result = JSON.parse(r.stdout.trim());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('archive, open, recover');
  }));

  test('a clean archive returns ok:true with session_id and report_path', withTmp(async (dir) => {
    await open(dir, 'Task: ship it\n', '2026-07-09T12:00:00Z');
    const result = await archive(dir, 'close', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    expect(result.ok).toBe(true);
    expect(result.session_id).toBe('S-001');
    expect(fs.existsSync(result.report_path)).toBe(true);
  }));
});

// =============================================================================
describe('S-NNN resolution', () => {
  test('zero reports exist -> S-001 (the first-run edge case)', withTmp(async (dir) => {
    const result = await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    expect(result.session_id).toBe('S-001');
  }));

  test('increments from the highest existing NNN', withTmp(async (dir) => {
    fs.writeFileSync(path.join(sessionsDir(dir), 'S-007-REPORT.md'), '---\nid: S-007\n---\n');
    fs.writeFileSync(path.join(sessionsDir(dir), 'S-012-REPORT.md'), '---\nid: S-012\n---\n');
    const result = await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    expect(result.session_id).toBe('S-013');
  }));

  test('filename invariant: re-archiving the same session overwrites in place, never a dated duplicate', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    const first = await archive(dir, 'close', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    expect(first.session_id).toBe('S-001');
    // Simulate a re-archive of the same session (e.g. a retried close): runtime
    // still names S-001 as the target because nothing advanced session_id further.
    writeRuntime(dir, { session_state: 'in_progress', session_id: 'S-001' });
    writeShell(dir, SHELL_TEMPLATE.replace('S-NNN (assigned on close)', 'S-001'));
    const second = await archive(dir, 'close', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:05:00Z');
    expect(second.session_id).toBe('S-001');
    const reportFiles = fs.readdirSync(sessionsDir(dir)).filter(f => /^S-001.*REPORT/.test(f));
    expect(reportFiles).toEqual(['S-001-REPORT.md']);
  }));
});

// =============================================================================
// Precedence: measured cost-log window (runtime.opened_at present) -> legacy
// payload Cost line (window unmeasurable) -> 0/0. `.status.json` is a cumulative
// running total and must NEVER be read for cost (that was the #615 bug: an
// auto-closed 0-duration session got stamped with the hermit's lifetime spend).
describe('cost precedence', () => {
  test('payload Cost line used when no opened_at (window unmeasurable)', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    // Simulate a session opened by pre-rollout code: runtime carries no arc bounds,
    // so the window is unmeasurable and the legacy Cost: line is the only source.
    const { opened_at, closed_at, ...legacyRuntime } = readRuntime(dir);
    writeRuntime(dir, legacyRuntime);
    await archive(dir, 'close', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).toContain('cost_usd: 0.4231');
    expect(report).toContain('tokens: 152689');
  }));

  test('never falls back to .status.json — records 0/0 when unmeasurable and no Cost payload (regression, #615)', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    fs.writeFileSync(path.join(sessionsDir(dir), '.status.json'), JSON.stringify({ cost_usd: 1.2345, tokens: 9999, operator_turns: 3 }));
    const payload = 'Status: completed\nBlockers: none\nLessons: none\nChanged: none\n';
    await archive(dir, 'close', payload, '2026-07-09T13:00:00Z');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).toContain('cost_usd: 0');
    expect(report).toContain('tokens: 0');
    // .status.json still sources operator_turns — that read is untouched.
    expect(report).toContain('operator_turns: 3');
  }));

  test('falls back to 0.00/0 when neither payload nor cost-log window have cost data', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    const payload = 'Status: completed\nBlockers: none\nLessons: none\nChanged: none\n';
    await archive(dir, 'close', payload, '2026-07-09T13:00:00Z');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).toContain('cost_usd: 0');
    expect(report).toContain('tokens: 0');
  }));

  test('auto-close records the measured cost-log window, not the inflated .status.json (regression, #615)', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    writeRuntime(dir, { ...readRuntime(dir), opened_at: '2026-07-09T12:00:00Z' });
    seedCostLog(dir, [
      { timestamp: '2026-07-09T12:30:00Z', estimated_cost_usd: 0.05, total_tokens: 500 },
      { timestamp: '2026-07-09T12:45:00Z', estimated_cost_usd: 0.03, total_tokens: 300 },
    ]);
    fs.writeFileSync(path.join(sessionsDir(dir), '.status.json'), JSON.stringify({ cost_usd: 671.81, tokens: 1023435573 }));
    // The real --auto payload template never carries a Cost: line.
    const autoPayload = 'Status: completed\nBlockers: none\nLessons: none\nChanged: none\nArtifacts: none\nClosed Via: auto\nNext Start Point: Fresh start.\n';
    await archive(dir, 'auto', autoPayload, '2026-07-09T13:00:00Z');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).toContain('cost_usd: 0.08');
    expect(report).toContain('tokens: 800');
  }));

  test('a session archived before its first tracked turn does not inherit the previous arc', withTmp(async (dir) => {
    // Previous arc [10:00, 11:00] cost $9; this session opens at 12:00 and is
    // auto-closed before cost-tracker stamps a new arc. Without `open` resetting
    // opened_at/closed_at, the report would measure the previous window.
    writeRuntime(dir, { session_state: 'idle', opened_at: '2026-07-09T10:00:00Z', closed_at: '2026-07-09T11:00:00Z' });
    seedCostLog(dir, [
      { timestamp: '2026-07-09T10:30:00Z', estimated_cost_usd: 9.0, total_tokens: 90000 },
      { timestamp: '2026-07-09T12:30:00Z', estimated_cost_usd: 0.02, total_tokens: 200 },
    ]);
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    const autoPayload = 'Status: completed\nBlockers: none\nLessons: none\nChanged: none\nClosed Via: auto\nNext Start Point: Fresh start.\n';
    await archive(dir, 'auto', autoPayload, '2026-07-09T13:00:00Z');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).toContain('cost_usd: 0.02');
    expect(report).toContain('tokens: 200');
  }));

  test('a stale closed_at at/before opened_at is dropped, not measured as an inverted window', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    // closed_at predates opened_at — [12:00, 11:00] would sum to a silent zero.
    writeRuntime(dir, { ...readRuntime(dir), opened_at: '2026-07-09T12:00:00Z', closed_at: '2026-07-09T11:00:00Z' });
    seedCostLog(dir, [{ timestamp: '2026-07-09T12:30:00Z', estimated_cost_usd: 0.07, total_tokens: 700 }]);
    const payload = 'Status: completed\nBlockers: none\nLessons: none\nChanged: none\n';
    await archive(dir, 'close', payload, '2026-07-09T13:00:00Z');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).toContain('cost_usd: 0.07');
    expect(report).toContain('tokens: 700');
  }));

  test('a genuine zero-cost window does not fall through to a stale payload Cost line', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    writeRuntime(dir, { ...readRuntime(dir), opened_at: '2026-07-09T12:00:00Z' });
    // Rows exist, but entirely outside the [opened_at, now] window.
    seedCostLog(dir, [
      { timestamp: '2026-07-09T11:00:00Z', estimated_cost_usd: 5.00, total_tokens: 1000 },
    ]);
    const payload = 'Status: completed\nBlockers: none\nLessons: none\nChanged: none\nCost: $5.0000 (1000 tokens)\n';
    await archive(dir, 'close', payload, '2026-07-09T13:00:00Z');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).toContain('cost_usd: 0');
    expect(report).toContain('tokens: 0');
  }));
});

// =============================================================================
describe('shutdown_completed_at guard', () => {
  test('stamped when shutdown_requested_at is already set (real hermit-stop)', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    const before = readRuntime(dir);
    writeRuntime(dir, { ...before, shutdown_requested_at: '2026-07-09T12:55:00+0000' });
    await archive(dir, 'close', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    expect(readRuntime(dir).shutdown_completed_at).toBeTruthy();
  }));

  test('left untouched on an unattended auto-close (no shutdown_requested_at)', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    await archive(dir, 'auto', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    expect(readRuntime(dir).shutdown_completed_at).toBeUndefined();
  }));

  test('recover also stamps it when a crashed close was a real hermit-stop shutdown (regression: verbRecover previously dropped this guard)', withTmp(async (dir) => {
    await open(dir, 'Task: crashed during real shutdown\n', '2026-07-09T12:00:00Z');
    fs.writeFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), '---\nid: S-001\n---\nalready written\n');
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001', shutdown_requested_at: '2026-07-09T12:55:00+0000',
      transition: 'cleaning', transition_mode: 'close', transition_target: 'S-001-REPORT.md',
    });
    await recover(dir, '2026-07-09T13:00:00Z');
    expect(readRuntime(dir).shutdown_completed_at).toBeTruthy();
  }));
});

// =============================================================================
describe('idle vs. close reset semantics', () => {
  test('idle reset preserves SHELL.md, clears task-scoped sections, increments Tasks Completed', withTmp(async (dir) => {
    await open(dir, 'Task: first task\n', '2026-07-09T12:00:00Z');
    // Cost reaches the summary line via the measured window, so seed one.
    seedCostLog(dir, [{ timestamp: '2026-07-09T12:30:00Z', estimated_cost_usd: 0.4231, total_tokens: 152689 }]);
    await archive(dir, 'idle', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    const shell = readShell(dir);
    expect(shell).toContain('**Tasks Completed:** 1');
    // The ## Task section itself is cleared to the placeholder...
    const taskSectionMatch = /## Task\n([\s\S]*?)\n\n## Progress Log/.exec(shell);
    expect(taskSectionMatch![1].trim()).toBe('<!-- Awaiting next task -->');
    // ...but the Session Summary line is SUPPOSED to name the completed task.
    expect(shell).toContain('**S-001** (2026-07-09): first task — completed ($0.42)');
  }));

  test('close reset replaces SHELL.md with a fresh template and carries forward Blockers', withTmp(async (dir) => {
    await open(dir, 'Task: wrap up\n', '2026-07-09T12:00:00Z');
    let shell = readShell(dir);
    shell = shell.replace(/(## Blockers\n)([\s\S]*?)(?=\n## )/, '$1still waiting on CI\n\n');
    writeShell(dir, shell);
    await archive(dir, 'close', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    const after = readShell(dir);
    expect(after).toContain('S-NNN (assigned on close)');
    expect(after).toContain('still waiting on CI');
    expect(after).not.toContain('wrap up');
  }));
});

// =============================================================================
describe('compaction roll-up', () => {
  test('rolls up Monitoring entries past the threshold into a bucketed [Earlier] line', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    let shell = readShell(dir);
    // threshold=30, keep=20 (defaults) -> 35 total lines summarizes the oldest
    // 15 (35-20). With 8 alerts first, that 15-line window spans all 8 alerts
    // plus the first 7 self-evals, so both buckets actually get folded in --
    // the last 20 lines (1 self-eval + the 2 recent entries) stay verbatim.
    const entries = [
      ...Array.from({ length: 8 }, (_, i) => `[08:0${i}] Alert: something ${i}`),
      ...Array.from({ length: 25 }, (_, i) => `[${String(9 + Math.floor(i / 6)).padStart(2, '0')}:${String(i % 6).padStart(2, '0')}] Self-eval: check ${i}`),
      '[15:00] Recent entry A',
      '[15:01] Recent entry B',
    ].join('\n');
    shell = shell.replace(/(## Monitoring\n)([\s\S]*?)(?=\n## )/, `$1${entries}\n\n`);
    writeShell(dir, shell);
    await archive(dir, 'idle', BASIC_CLOSE_PAYLOAD, '2026-07-09T16:00:00Z');
    const after = readShell(dir);
    expect(after).toMatch(/\[Earlier\].*alerts/);
    expect(after).toMatch(/\[Earlier\].*self-evals/);
    expect(after).toContain('Recent entry A');
    expect(after).toContain('Recent entry B');
  }));

  test('stays untouched when under threshold', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    await archive(dir, 'idle', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    const after = readShell(dir);
    expect(after).not.toContain('[Earlier]');
  }));
});

// =============================================================================
describe('transition_mode branch + legacy fallback', () => {
  test('archive stamps transition_mode matching --mode while in flight', withTmp(async (dir) => {
    // We can't observe the mid-flight marker directly (archive is synchronous
    // end-to-end), but we can confirm it's cleared to null on success, and
    // exercise the branch it feeds via the recover tests below.
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    await archive(dir, 'idle', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    expect(readRuntime(dir).transition_mode).toBeNull();
  }));

  test('recover picks the idle cleanup path when transition_mode=idle', withTmp(async (dir) => {
    await open(dir, 'Task: idle in flight\n', '2026-07-09T12:00:00Z');
    fs.writeFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), '---\nid: S-001\n---\nalready written\n');
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001',
      transition: 'archiving', transition_mode: 'idle', transition_target: 'S-001-REPORT.md',
    });
    const result = await recover(dir, '2026-07-09T13:00:00Z');
    expect(result.ok).toBe(true);
    expect(result.mode_used).toBe('idle');
    expect(result.legacy).toBe(false);
    const shell = readShell(dir);
    expect(shell).toContain('**Tasks Completed:** 1');
    expect(shell).not.toContain('S-NNN (assigned on close)'); // idle keeps the template, doesn't replace it
  }));

  test('recover picks the close cleanup path when transition_mode=close', withTmp(async (dir) => {
    await open(dir, 'Task: close in flight\n', '2026-07-09T12:00:00Z');
    fs.writeFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), '---\nid: S-001\n---\nalready written\n');
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001',
      transition: 'archiving', transition_mode: 'close', transition_target: 'S-001-REPORT.md',
    });
    const result = await recover(dir, '2026-07-09T13:00:00Z');
    expect(result.mode_used).toBe('close');
    expect(readShell(dir)).toContain('S-NNN (assigned on close)');
  }));

  test('legacy marker (transition set, transition_mode absent) is treated as close and annotated', withTmp(async (dir) => {
    await open(dir, 'Task: pre-upgrade crash\n', '2026-07-09T12:00:00Z');
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001',
      transition: 'archiving', transition_target: 'S-001-REPORT.md',
      // no transition_mode field at all -- simulates a crash under the old session-mgr
    });
    const result = await recover(dir, '2026-07-09T13:00:00Z');
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('close');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).toContain('Recovered via legacy transition marker (pre-upgrade); treated as full close.');
  }));
});

// =============================================================================
describe('recovery matrix', () => {
  test('archiving + target missing -> re-archives with a degraded synthetic payload', withTmp(async (dir) => {
    await open(dir, 'Task: crashed before report\n', '2026-07-09T12:00:00Z');
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001',
      transition: 'archiving', transition_mode: 'close', transition_target: 'S-001-REPORT.md',
    });
    const result = await recover(dir, '2026-07-09T13:00:00Z');
    expect(result.ok).toBe(true);
    expect(result.recovery_path).toBe('re-archive');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).toContain('status: partial');
    expect(report).toContain('closed_via: recovered');
    expect(report).toContain('pre-crash close payload was not persisted');
  }));

  test('archiving + target exists -> skips straight to SHELL reset, report untouched', withTmp(async (dir) => {
    await open(dir, 'Task: crashed after report\n', '2026-07-09T12:00:00Z');
    fs.writeFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'PRE-EXISTING, MUST NOT BE OVERWRITTEN');
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001',
      transition: 'archiving', transition_mode: 'idle', transition_target: 'S-001-REPORT.md',
    });
    await recover(dir, '2026-07-09T13:00:00Z');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).toBe('PRE-EXISTING, MUST NOT BE OVERWRITTEN');
  }));

  test('idle recovery reads cost from the already-written report, not a fresh window/`.status.json` (regression, #615)', withTmp(async (dir) => {
    await open(dir, 'Task: crashed after report\n', '2026-07-09T12:00:00Z');
    fs.writeFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'),
      '---\nid: S-001\ncost_usd: 0.55\ntokens: 12345\n---\n\n# Session Report: S-001\n');
    // An inflated .status.json must not leak in via a re-derived cost.
    fs.writeFileSync(path.join(sessionsDir(dir), '.status.json'), JSON.stringify({ cost_usd: 671.81, tokens: 1023435573 }));
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001',
      transition: 'archiving', transition_mode: 'idle', transition_target: 'S-001-REPORT.md',
    });
    await recover(dir, '2026-07-09T13:00:00Z');
    const shell = readShell(dir);
    expect(shell).toContain('($0.55)');
    expect(shell).not.toContain('($671.81)');
  }));

  test('cleaning -> skips straight to SHELL reset', withTmp(async (dir) => {
    await open(dir, 'Task: crashed mid-cleanup\n', '2026-07-09T12:00:00Z');
    fs.writeFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'already written');
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001',
      transition: 'cleaning', transition_mode: 'close', transition_target: 'S-001-REPORT.md',
    });
    const result = await recover(dir, '2026-07-09T13:00:00Z');
    expect(result.ok).toBe(true);
    expect(result.recovery_path).toBe('shell-reset');
  }));

  test('no interrupted transition -> no-op, ok:true', withTmp(async (dir) => {
    writeRuntime(dir, { session_state: 'idle' });
    const result = await recover(dir, '2026-07-09T13:00:00Z');
    expect(result).toEqual({ ok: true, recovered: false, reason: 'no-interrupted-transition' });
  }));

  test('idle recover on an already-reset SHELL does not double-count or duplicate the summary (regression)', withTmp(async (dir) => {
    await open(dir, 'Task: first task\n', '2026-07-09T12:00:00Z');
    await archive(dir, 'idle', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    // SHELL is now reset (Tasks Completed:1, one summary line). Simulate a crash
    // AFTER that reset but before the marker-clear: transition stuck at 'cleaning',
    // session_id still naming the just-archived session. Re-running idleReset here
    // would bump Tasks Completed to 2 and append a '(no task summary)' garbage line.
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001',
      transition: 'cleaning', transition_mode: 'idle', transition_target: 'S-001-REPORT.md',
    });
    await recover(dir, '2026-07-09T13:05:00Z');
    const shell = readShell(dir);
    expect(shell).toContain('**Tasks Completed:** 1');
    expect(shell).not.toContain('(no task summary)');
    expect((shell.match(/\*\*S-001\*\* \(/g) || []).length).toBe(1);
    expect(readRuntime(dir).transition).toBeNull();
  }));

  test('re-archive with SHELL.md missing clears markers instead of pinning recovery (regression)', withTmp(async (dir) => {
    // archiving in flight, report never written, and SHELL.md is absent -> verbArchive
    // cannot rebuild a report. Recovery must not leave transition set, or the next
    // start re-enters this same branch and fails identically forever.
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001',
      transition: 'archiving', transition_mode: 'close', transition_target: 'S-001-REPORT.md',
    });
    const result = await recover(dir, '2026-07-09T13:00:00Z');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('shell-missing');
    const runtime = readRuntime(dir);
    expect(runtime.transition).toBeNull();
    expect(runtime.session_state).toBe('idle');
  }));

  test('all transitions clear fully after recovery (no marker survives)', withTmp(async (dir) => {
    await open(dir, 'Task: x\n', '2026-07-09T12:00:00Z');
    writeRuntime(dir, {
      session_state: 'in_progress', session_id: 'S-001',
      transition: 'archiving', transition_mode: 'idle', transition_target: 'S-001-REPORT.md',
    });
    await recover(dir, '2026-07-09T13:00:00Z');
    const runtime = readRuntime(dir);
    expect(runtime.transition).toBeNull();
    expect(runtime.transition_mode).toBeNull();
    expect(runtime.transition_target).toBeNull();
    expect(runtime.transition_started_at).toBeNull();
    expect(runtime.session_state).toBe('idle');
  }));
});

// =============================================================================
// Structural golden equivalence — see the file-header note on why this is the bar.
describe('structural equivalence with the session-mgr.md spec', () => {
  const REQUIRED_FRONTMATTER_KEYS = [
    'id', 'status', 'date', 'duration', 'cost_usd', 'tokens', 'tags',
    'proposals_created', 'task', 'artifacts', 'blockers', 'lessons', 'next_start',
    'escalation', 'operator_turns', 'closed_via',
  ];
  const REQUIRED_SECTIONS = [
    '## Overview', '## Completed', '## Changed', '## Artifacts',
    '## Blockers', '## Lessons', '## Proposals Created',
  ];

  test('close-mode report has every frontmatter key and body section the template defines', withTmp(async (dir) => {
    await open(dir, 'Task: full structural check\n', '2026-07-09T12:00:00Z');
    await archive(dir, 'close', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    for (const key of REQUIRED_FRONTMATTER_KEYS) {
      expect(report).toMatch(new RegExp(`^${key}:`, 'm'));
    }
    for (const section of REQUIRED_SECTIONS) {
      expect(report).toContain(section);
    }
    expect(report).toContain('## Next Start Point'); // close/auto only
    expect(report).not.toContain('## Summary'); // session-mgr.md explicitly forbids this
  }));

  test('idle-mode report omits Next Start Point (not part of the idle payload contract)', withTmp(async (dir) => {
    await open(dir, 'Task: idle structural check\n', '2026-07-09T12:00:00Z');
    await archive(dir, 'idle', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    const report = fs.readFileSync(path.join(sessionsDir(dir), 'S-001-REPORT.md'), 'utf-8');
    expect(report).not.toContain('## Next Start Point');
  }));

  test('the proposals_created regex matches the exact pattern session-mgr.md specified', () => {
    // Guards the same contract tests/contracts.test.ts's proposal-id-scheme block
    // checks for session-mgr.md, repointed here now that the agent is deleted.
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'scripts', 'session-archive.ts'), 'utf-8');
    expect(src).toContain('/PROP-[a-z0-9][a-z0-9-]*/gi');
  });
});

// =============================================================================
// Structured frontmatter (blockers/lessons/artifacts/next_start) — the row
// reflect/brief/weekly-review/startup-context now read instead of full bodies.
describe('structured report frontmatter', () => {
  test('multi-line prose fields round-trip as arrays via the shared frontmatter parser', withTmp(async (dir) => {
    await open(dir, 'Task: structured fields\n', '2026-07-09T12:00:00Z');
    const payload =
      'Status: completed\n' +
      'Blockers: waiting on review, needs sign-off\nstill blocked on infra\n' +
      'Lessons: cache invalidation matters\nretry logic needs backoff\n' +
      'Artifacts: compiled/report-1.md\ncompiled/report-2.md\n' +
      'Changed: none\n' +
      'Next Start Point: pick up the migration script\n';
    await archive(dir, 'close', payload, '2026-07-09T13:00:00Z');
    const fm = readFrontmatter(path.join(sessionsDir(dir), 'S-001-REPORT.md'));
    expect(fm.blockers).toEqual(['waiting on review, needs sign-off', 'still blocked on infra']);
    expect(fm.lessons).toEqual(['cache invalidation matters', 'retry logic needs backoff']);
    expect(fm.artifacts).toEqual(['compiled/report-1.md', 'compiled/report-2.md']);
    expect(fm.next_start).toBe('pick up the migration script');
  }));

  test('placeholder-only payload yields empty arrays and empty next_start', withTmp(async (dir) => {
    await open(dir, 'Task: placeholders\n', '2026-07-09T12:00:00Z');
    const payload = 'Status: completed\nChanged: none\n';
    await archive(dir, 'close', payload, '2026-07-09T13:00:00Z');
    const fm = readFrontmatter(path.join(sessionsDir(dir), 'S-001-REPORT.md'));
    expect(fm.blockers).toEqual([]);
    expect(fm.lessons).toEqual([]);
    expect(fm.artifacts).toEqual([]);
    expect(fm.next_start).toBe('');
  }));

  test('YAML-hostile characters and internal commas in a blocker line stay parseable as one item', withTmp(async (dir) => {
    await open(dir, 'Task: hostile chars\n', '2026-07-09T12:00:00Z');
    const payload = 'Status: completed\nBlockers: #urgent fix, needs {infra} and [approval]\nChanged: none\n';
    await archive(dir, 'close', payload, '2026-07-09T13:00:00Z');
    const fm = readFrontmatter(path.join(sessionsDir(dir), 'S-001-REPORT.md'));
    expect(fm.blockers).toEqual(['#urgent fix, needs {infra} and [approval]']);
  }));

  test('idle-mode archive has empty next_start', withTmp(async (dir) => {
    await open(dir, 'Task: idle next_start\n', '2026-07-09T12:00:00Z');
    await archive(dir, 'idle', BASIC_CLOSE_PAYLOAD, '2026-07-09T13:00:00Z');
    const fm = readFrontmatter(path.join(sessionsDir(dir), 'S-001-REPORT.md'));
    expect(fm.next_start).toBe('');
  }));

  test('a # in a quoted scalar (next_start referencing an issue) survives the parser', withTmp(async (dir) => {
    await open(dir, 'Task: continue #591 review\n', '2026-07-09T12:00:00Z');
    const payload = 'Status: completed\nChanged: none\nNext Start Point: address the #591 review comments\n';
    await archive(dir, 'close', payload, '2026-07-09T13:00:00Z');
    const fm = readFrontmatter(path.join(sessionsDir(dir), 'S-001-REPORT.md'));
    expect(fm.next_start).toBe('address the #591 review comments');
    expect(fm.task).toBe('continue #591 review');
  }));
});
