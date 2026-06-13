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
function subagentEntry(resolvedModel: string, inputTokens: number, outputTokens: number): string {
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
