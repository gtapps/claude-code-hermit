// Tests for scripts/cost-tracker.ts: collectSubagentUsage unit tests and
// subprocess test confirming per-subagent cost-log lines are emitted.
//
// Unit tests use a thin subprocess helper (collect-subagent-usage.ts) rather
// than an in-process import to avoid polluting the module cache — cost-tracker.ts
// initialises HERMIT_DIR at load time, and hooks.contract.test.ts imports the
// same module in-process from a different cwd.  A shared cache would cause
// getCumulativeCost to read the wrong .status.json path.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT, SCRIPTS_DIR } from './helpers/run';

const HELPER = path.join(import.meta.dir, 'helpers', 'collect-subagent-usage.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpdir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-'));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  };
}

async function runCollect(lines: string[], billedIndex: number): Promise<any[]> {
  const proc = Bun.spawn({
    cmd: [process.execPath, HELPER],
    env: { ...process.env },
    stdin: Buffer.from(JSON.stringify({ lines, billedIndex })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return JSON.parse(stdout.trim() || '[]');
}

// Build a toolUseResult transcript entry.
// CC uses a hybrid representation: both toolUseResult (the subagent summary) and
// message.content:[{type:'tool_result'}] (so isToolResult returns true and boundary
// scanning doesn't stop here).
function subagentEntry(resolvedModel: string | undefined, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'done' }] },
    toolUseResult: {
      agentType: 'general-purpose',
      resolvedModel,
      usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: outputTokens },
    },
  });
}

function assistantEntry(model: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model,
      usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: outputTokens },
      content: [{ type: 'text', text: 'ok' }],
    },
  });
}

function triggerPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

// ---------------------------------------------------------------------------
// Unit: collectSubagentUsage (via subprocess helper to avoid module-cache pollution)
// ---------------------------------------------------------------------------

describe('collectSubagentUsage', () => {
  test('collects a single subagent toolUseResult within the turn window', async () => {
    const lines = [
      triggerPrompt('[hermit-routine:demo] start'),          // 0 — turn boundary
      assistantEntry('claude-sonnet-4-6', 100, 50),         // 1
      subagentEntry('claude-haiku-4-5-20251001', 200, 80),  // 2
      assistantEntry('claude-sonnet-4-6', 10, 5),           // 3 — billedIndex
    ];
    const results = await runCollect(lines, 3);
    expect(results).toHaveLength(1);
    expect(results[0].model).toBe('claude-haiku-4-5-20251001');
    expect(results[0].inputTokens).toBe(200);
    expect(results[0].outputTokens).toBe(80);
    expect(results[0].agentType).toBe('general-purpose');
  });

  test('collects multiple subagent dispatches within the same turn', async () => {
    const lines = [
      triggerPrompt('HEARTBEAT_EVALUATE'),                   // 0 — turn boundary
      assistantEntry('claude-opus-4-8', 500, 200),          // 1
      subagentEntry('claude-haiku-4-5-20251001', 100, 40),  // 2
      subagentEntry('claude-haiku-4-5-20251001', 120, 50),  // 3
      assistantEntry('claude-opus-4-8', 10, 5),             // 4 — billedIndex
    ];
    const results = await runCollect(lines, 4);
    expect(results).toHaveLength(2);
    expect(results.every((r: any) => r.model === 'claude-haiku-4-5-20251001')).toBe(true);
  });

  test('does not cross the turn boundary into the prior turn', async () => {
    const lines = [
      triggerPrompt('prior turn'),                          // 0 — prior turn boundary
      subagentEntry('claude-haiku-4-5-20251001', 999, 999), // 1 — prior turn dispatch (must be excluded)
      assistantEntry('claude-sonnet-4-6', 10, 5),           // 2 — prior turn last entry
      triggerPrompt('[hermit-routine:demo] start'),          // 3 — current turn boundary
      assistantEntry('claude-sonnet-4-6', 50, 20),          // 4 — billedIndex
    ];
    const results = await runCollect(lines, 4);
    expect(results).toHaveLength(0);
  });

  test('returns empty array when no subagent dispatches in turn', async () => {
    const lines = [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntry('claude-sonnet-4-6', 100, 50),
    ];
    const results = await runCollect(lines, 1);
    expect(results).toHaveLength(0);
  });

  test('ignores subagent entries with no usage', async () => {
    const lines = [
      triggerPrompt('hello'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '' }] }, toolUseResult: { agentType: 'general-purpose', resolvedModel: 'claude-haiku-4-5-20251001' } }),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ];
    const results = await runCollect(lines, 2);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Subprocess: cost-tracker emits per-subagent log lines
// ---------------------------------------------------------------------------

describe('cost-tracker subagent log lines', () => {
  // Minimal hermit dir structure cost-tracker needs:
  //   <dir>/.claude/cost-log.jsonl     (written by cost-tracker)
  //   <dir>/.claude-code-hermit/state/runtime.json
  //   <dir>/.claude-code-hermit/sessions/SHELL.md  (optional; non-fatal if absent)
  let dir: string;
  let transcriptPath: string;
  let logPath: string;
  let out = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-sub-'));

    // Claude dir for the cost-log
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');

    // Hermit state dir
    const stateDir = path.join(dir, '.claude-code-hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ session_id: 'test-session', session_state: 'active' }));

    // Transcript: routine trigger → assistant call → subagent dispatch → final assistant
    const transcriptLines = [
      triggerPrompt('[hermit-routine:demo] start\nlog-routine-event.sh demo started'),
      assistantEntry('claude-sonnet-4-6', 500, 100),
      subagentEntry('claude-haiku-4-5-20251001', 1000, 400),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ];
    transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    const r = await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
    out = r.stdout + r.stderr;
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('cost-tracker: cost-log.jsonl is written', () => {
    expect(fs.existsSync(logPath)).toBe(true);
  });

  test('cost-tracker: cost-log.jsonl has exactly 2 lines (main + subagent)', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  test('cost-tracker: first line is the main turn entry (no subagent field)', () => {
    const [firstLine] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(firstLine);
    expect(entry.subagent).toBeFalsy();
    expect(entry.source).toBe('routine:demo');
    expect(entry.model).toBe('sonnet');
  });

  test('cost-tracker: second line is the subagent entry at haiku', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[1]);
    expect(entry.subagent).toBe(true);
    expect(entry.model).toBe('haiku');
    expect(entry.agent_type).toBe('general-purpose');
    expect(entry.api_calls).toBe(0);
    expect(entry.model_resolved).toBe(true); // resolvedModel was present
  });

  test('cost-tracker: main entry carries max_prompt_tokens; subagent entry does not', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const mainEntry = JSON.parse(lines[0]);
    const subEntry = JSON.parse(lines[1]);
    expect(typeof mainEntry.max_prompt_tokens).toBe('number');
    expect(subEntry.max_prompt_tokens).toBeUndefined();
  });

  test('cost-tracker: subagent entry inherits the dispatching source', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const subEntry = JSON.parse(lines[1]);
    expect(subEntry.source).toBe('routine:demo');
  });

  test('cost-tracker: subagent entry has correct token counts', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const subEntry = JSON.parse(lines[1]);
    expect(subEntry.total_tokens).toBeGreaterThan(0);
    expect(subEntry.input_tokens).toBe(1000);
    expect(subEntry.output_tokens).toBe(400);
  });

  test('cost-tracker: stderr summary produced (exit 0)', () => {
    expect(out.length).toBeGreaterThan(0);
  });
});

// A subagent dispatch whose tool_result carries no resolvedModel must still be
// logged (tokens stay visible), but flagged model_resolved:false so the sonnet
// default is auditable rather than a silent mis-bill.
describe('cost-tracker subagent with no resolvedModel', () => {
  let dir: string;
  let logPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-nomodel-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.claude-code-hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ session_id: 'test-session', session_state: 'active' }));

    const transcriptLines = [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntry('claude-sonnet-4-6', 500, 100),
      subagentEntry(undefined, 1000, 400), // resolvedModel absent → model_resolved:false
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ];
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('cost-tracker: missing resolvedModel is logged with model_resolved:false at sonnet default', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const subEntry = JSON.parse(lines[1]);
    expect(subEntry.subagent).toBe(true);
    expect(subEntry.model_resolved).toBe(false);
    expect(subEntry.model).toBe('sonnet');
    expect(subEntry.input_tokens).toBe(1000);
  });
});

// Regression for #572: a turn whose real triggering prompt falls outside the 512KB
// tail window must not inherit a stale/echoed marker still inside that window.
describe('cost-tracker: oversized turn with boundary outside the tail window', () => {
  let dir: string;
  let logPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-oversized-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.claude-code-hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ session_id: 'test-session', session_state: 'active' }));

    // The REAL trigger for this turn — a plain operator prompt, no routine marker.
    // Followed by >512KB of filler tool_use/tool_result pairs so this line falls
    // before the tail window's read-from offset. One filler entry near the end
    // (inside the window) echoes a stale routine marker in its tool_result content
    // — simulating a leftover `log-routine-event.sh doctor started` string from an
    // unrelated earlier fire, or output surfaced by this very turn's own tooling.
    const transcriptLines: string[] = [
      triggerPrompt('Investigate the failing upgrade run and apply the fix.'),
    ];
    const filler = 'x'.repeat(2000);
    for (let i = 0; i < 300; i++) {
      transcriptLines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} }] } }));
      transcriptLines.push(JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: `t${i}`, type: 'tool_result', content: filler }] } }));
    }
    // Stale marker, planted a few entries before the end — well within the 512KB tail.
    transcriptLines.push(JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 'stale', type: 'tool_result', content: 'log-routine-event.sh doctor started' }] } }));
    transcriptLines.push(assistantEntry('claude-sonnet-4-6', 5000, 2000));

    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const content = transcriptLines.join('\n') + '\n';
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(524288); // sanity: exceeds TAIL_BYTES
    fs.writeFileSync(transcriptPath, content);

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('cost-tracker: logs source as "other", not the stale in-window marker', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.source).toBe('other');
  });
});

// max_prompt_tokens is the real context-size signal watchdog's hygiene thresholds
// key on (a multi-call turn's summed input_tokens is a multiple of its actual
// context, not the context itself) — the largest single API call in the turn.
describe('cost-tracker: max_prompt_tokens (real context size vs per-turn sum)', () => {
  let dir: string;
  let logPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-maxprompt-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.claude-code-hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ session_id: 'test-session', session_state: 'active' }));

    // Three API calls in one turn: 100k, 300k (the largest), 50k (billedIndex).
    // Summed, the turn logs 450k prompt tokens; the real context peak was 300k.
    const transcriptLines = [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntry('claude-sonnet-4-6', 100000, 50),
      assistantEntry('claude-sonnet-4-6', 300000, 60),
      assistantEntry('claude-sonnet-4-6', 50000, 5),
    ];
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('main entry carries max_prompt_tokens equal to the single largest call, not the sum', () => {
    const [firstLine] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(firstLine);
    expect(entry.input_tokens).toBe(450000); // the pre-existing per-turn sum, unchanged
    expect(entry.max_prompt_tokens).toBe(300000); // the real context-size signal
    expect(entry.api_calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Subprocess: cost-tracker stamps/clears runtime.json's opened_at (PR-6 part b —
// session-cost.ts's window-delta mode reads this field). See maintainOpenedAt in
// cost-tracker.ts.
// ---------------------------------------------------------------------------

async function runCostTrackerWithRuntime(dir: string, runtimeState: object): Promise<string> {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const stateDir = path.join(dir, '.claude-code-hermit', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const runtimePath = path.join(stateDir, 'runtime.json');
  fs.writeFileSync(runtimePath, JSON.stringify(runtimeState));

  // A non-zero-usage turn is required — run() returns early (before touching
  // runtime.json at all) when totalTokens === 0.
  const transcriptLines = [
    triggerPrompt('operator message'),
    assistantEntry('claude-sonnet-4-6', 100, 50),
  ];
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

  const stdin = JSON.stringify({ session_id: 'proc-uuid', transcript_path: transcriptPath });
  await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });

  return runtimePath;
}

// The subprocess stdin tags the transcript id as 'proc-uuid'; maintainOpenedAt keys
// the arc-reset on it. A stale opened_transcript (a prior/dead process) forces a new arc.
describe('cost-tracker: opened_at / closed_at arc window', () => {
  test('in_progress with no opened_at → opens an arc (opened_at ISO, closed_at null, transcript recorded)', withTmpdir(async (dir) => {
    const runtimePath = await runCostTrackerWithRuntime(dir, { session_state: 'in_progress' });
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    expect(typeof rt.opened_at).toBe('string');
    expect(Number.isFinite(Date.parse(rt.opened_at))).toBe(true);
    expect(rt.closed_at).toBeNull();
    expect(rt.opened_transcript).toBe('proc-uuid');
  }));

  test('in_progress, same transcript + live arc → opened_at left unchanged', withTmpdir(async (dir) => {
    const existing = '2020-01-01T00:00:00.000Z';
    const runtimePath = await runCostTrackerWithRuntime(dir, { session_state: 'in_progress', opened_at: existing, closed_at: null, opened_transcript: 'proc-uuid' });
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    expect(rt.opened_at).toBe(existing);
  }));

  test('in_progress with a stale transcript → arc reset (crash/restart no longer over-counts)', withTmpdir(async (dir) => {
    const existing = '2020-01-01T00:00:00.000Z';
    const runtimePath = await runCostTrackerWithRuntime(dir, { session_state: 'in_progress', opened_at: existing, opened_transcript: 'dead-uuid' });
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    expect(rt.opened_at).not.toBe(existing);
    expect(Number.isFinite(Date.parse(rt.opened_at))).toBe(true);
    expect(rt.opened_transcript).toBe('proc-uuid');
    expect(rt.closed_at).toBeNull();
  }));

  test('in_progress after a closed arc (closed_at set) → new arc opens, closed_at cleared', withTmpdir(async (dir) => {
    const existing = '2020-01-01T00:00:00.000Z';
    const runtimePath = await runCostTrackerWithRuntime(dir, { session_state: 'in_progress', opened_at: existing, closed_at: '2020-01-01T01:00:00.000Z', opened_transcript: 'proc-uuid' });
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    expect(rt.opened_at).not.toBe(existing);
    expect(rt.closed_at).toBeNull();
  }));

  test('idle with a live arc → stamps closed_at, keeps opened_at (close after idle can still recover the window)', withTmpdir(async (dir) => {
    const existing = '2020-01-01T00:00:00.000Z';
    const runtimePath = await runCostTrackerWithRuntime(dir, { session_state: 'idle', opened_at: existing, opened_transcript: 'proc-uuid' });
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    expect(rt.opened_at).toBe(existing);
    expect(typeof rt.closed_at).toBe('string');
    expect(Number.isFinite(Date.parse(rt.closed_at))).toBe(true);
  }));

  test('idle with an already-closed arc → closed_at left unchanged', withTmpdir(async (dir) => {
    const closed = '2020-01-01T01:00:00.000Z';
    const runtimePath = await runCostTrackerWithRuntime(dir, { session_state: 'idle', opened_at: '2020-01-01T00:00:00.000Z', closed_at: closed, opened_transcript: 'proc-uuid' });
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    expect(rt.closed_at).toBe(closed);
  }));

  test('idle with no opened_at → stays unset, no spurious write', withTmpdir(async (dir) => {
    const runtimePath = await runCostTrackerWithRuntime(dir, { session_state: 'idle' });
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    expect(rt.opened_at).toBeUndefined();
    expect(rt.closed_at).toBeUndefined();
  }));

  test('waiting with opened_at set → left unchanged, not closed (bounce stays one arc)', withTmpdir(async (dir) => {
    const existing = '2020-01-01T00:00:00.000Z';
    const runtimePath = await runCostTrackerWithRuntime(dir, { session_state: 'waiting', opened_at: existing, opened_transcript: 'proc-uuid' });
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    expect(rt.opened_at).toBe(existing);
    expect(rt.closed_at).toBeUndefined();
  }));

  test('waiting with no opened_at → stays unset', withTmpdir(async (dir) => {
    const runtimePath = await runCostTrackerWithRuntime(dir, { session_state: 'waiting' });
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    expect(rt.opened_at).toBeUndefined();
  }));
});
