// Tests for scripts/cost-tracker.ts: collectSubagentUsage unit tests and
// subprocess test confirming per-subagent cost-log lines are emitted.
//
// Unit tests use a thin subprocess helper (collect-subagent-usage.ts) rather
// than an in-process import to avoid polluting the module cache — cost-tracker.ts
// initialises HERMIT_DIR at load time, and hooks.contract.test.ts imports the
// same module in-process from a different cwd.  A shared cache would cause
// cost tracking to read the wrong project state.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT, SCRIPTS_DIR } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { triggerPrompt, assistantEntry as assistantEntryFull, assistantEntryFor as assistantEntry } from './helpers/transcript';

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
  //   <dir>/.hermit/state/runtime.json
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
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

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

  test('cost tracking creates no retired cache or lifecycle row field', () => {
    expect(fs.existsSync(path.join(dir, '.hermit', 'sessions', '.status.json'))).toBe(false);
    const rows = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    for (const row of rows) expect('session_id' in row).toBe(false);
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
    expect(entry.model).toBe('claude-sonnet-4-6');
    expect(entry.cost_by_type).toEqual({
      input: expect.any(Number),
      cache_write: expect.any(Number),
      cache_read: expect.any(Number),
      output: expect.any(Number),
    });
  });

  test('cost-tracker: second line is the subagent entry at haiku', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[1]);
    expect(entry.subagent).toBe(true);
    expect(entry.model).toBe('claude-haiku-4-5-20251001');
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
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

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
    expect(subEntry.model).toBe('');
    expect(subEntry.input_tokens).toBe(1000);
  });
});

// Regression for #572: a turn whose real triggering prompt falls outside the 512KB
// tail window must not inherit a stale/echoed marker still inside that window.
// Since the 8MB re-read landed, this fixture resolves on the retry: the real prompt is
// found rather than assumed, and it is a plain operator message, so 'other' still holds.
// The truncated-window path itself is pinned in scripts.test.ts's `cost-tracker
// scanTurnInTail` block, which reaches it with a small tailBytes.
describe('cost-tracker: oversized turn with boundary outside the tail window', () => {
  let dir: string;
  let logPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-oversized-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

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

// Regression: when the model re-invokes a skill whose instructions are already in
// context, CC (2.1.202+) writes a companion user entry instead of a second copy of the
// skill body. That companion carries STRING content, so the array-content discriminator
// alone let it end the prompt walk and the turn billed to 'other'. Measured on live
// transcripts: a weekly-review fire and a pipeline-digest co-fire, both mis-attributed
// while their real ROUTINE_DUE prompt sat a few entries further back.
describe('cost-tracker: a skill companion entry never ends the prompt walk', () => {
  const { freshDir, cleanup } = freshDirFactory('hermit-cost-tracker-companion-');

  // Verbatim companion shapes from live CC transcripts. `turnCompanion` is the field
  // that separates every skill-scaffolding entry from a real prompt; `isMeta` alone does
  // not, because routine wakes and channel envelopes are isMeta strings too.
  const reinvocation = JSON.stringify({
    type: 'user', isMeta: true, turnCompanion: true, sourceToolUseID: 'toolu_companion',
    message: { content: '(Re-invocation of /hermitd:hermit-routines \u2014 the skill instructions were previously loaded; the arguments or dynamic output below are new.)' },
  });
  const alreadyLoaded = JSON.stringify({
    type: 'user', isMeta: true, turnCompanion: true, sourceToolUseID: 'toolu_companion',
    message: { content: 'Skill /hermitd:heartbeat is already loaded above; instructions unchanged. Arguments: run' },
  });
  const skillBody = JSON.stringify({
    type: 'user', isMeta: true, turnCompanion: true,
    message: { content: [{ type: 'text', text: 'Base directory for this skill: /plugins/hermitd/skills/hermit-routines' }] },
  });

  async function sourceFor(entries: string[]): Promise<string> {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [...entries, assistantEntry('claude-sonnet-4-6', 5000, 2000)].join('\n') + '\n');

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
    const [firstLine] = fs.readFileSync(path.join(dir, '.claude', 'cost-log.jsonl'), 'utf-8').trim().split('\n');
    return JSON.parse(firstLine).source;
  }

  afterAll(cleanup);

  test('cost-tracker: a re-invocation companion does not shadow the routine wake behind it', async () => {
    const source = await sourceFor([
      triggerPrompt('<task-notification> <summary>Monitor event: "routine-monitor"</summary> <event>ROUTINE_DUE [hermit-routine:demo]</event> </task-notification>'),
      assistantEntry('claude-sonnet-4-6', 100, 20),
      reinvocation,
      skillBody,
    ]);
    expect(source).toBe('routine:demo');
  });

  test('cost-tracker: an already-loaded companion does not shadow the heartbeat wake behind it', async () => {
    const source = await sourceFor([
      triggerPrompt('HEARTBEAT_EVALUATE'),
      assistantEntry('claude-sonnet-4-6', 100, 20),
      alreadyLoaded,
    ]);
    expect(source).toBe('heartbeat');
  });

  // The other half of the contract: a routine wake IS an isMeta string entry, so the
  // predicate must key on turnCompanion, never on isMeta alone.
  test('cost-tracker: an isMeta prompt without a companion marker still classifies', async () => {
    const source = await sourceFor([
      JSON.stringify({ type: 'user', isMeta: true, message: { content: '[hermit-routine:demo] Run: bun scripts/routines.ts run demo' } }),
    ]);
    expect(source).toBe('routine:demo');
  });
});

// A long routine run (evolve, weekly-scan, weekly-review) writes more transcript in one
// turn than the 512KB tail holds, so its ROUTINE_DUE prompt sits outside the window: the
// turn billed to 'other' and its token sum started mid-turn. One re-read at the cap
// recovers both. Observed on fleet hermits, where those runs are the expensive ones.
describe('cost-tracker: 600KB single-turn transcript (boundary outside the 512KB tail)', () => {
  let dir: string;
  let logPath: string;
  const CALLS = 301; // 300 filler calls + the final billed entry

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-600kb-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

    // The turn's only prompt, followed by >512KB of billed calls and their tool_results.
    // No stale marker anywhere: the ONLY classifiable text is the wake at the very top,
    // so a source of 'routine:demo' proves the walk reached it.
    const transcriptLines: string[] = [
      triggerPrompt('<task-notification> <summary>Monitor event: "routine-monitor"</summary> <event>ROUTINE_DUE [hermit-routine:demo]</event> </task-notification>'),
    ];
    const filler = 'x'.repeat(2000);
    for (let i = 0; i < CALLS - 1; i++) {
      transcriptLines.push(assistantEntry('claude-sonnet-4-6', 10, 5));
      transcriptLines.push(JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: `t${i}`, type: 'tool_result', content: filler }] } }));
    }
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

  test('cost-tracker: 600KB turn is attributed to its routine, not "other"', () => {
    const [firstLine] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(firstLine).source).toBe('routine:demo');
  });

  test('cost-tracker: 600KB turn sums every call, not just the ones inside the 512KB tail', () => {
    const [firstLine] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(firstLine).api_calls).toBe(CALLS);
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
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

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

// Streamed chunks of one request share a requestId; they must bill once, at the max
// of each token field, not once per transcript entry.
describe('cost-tracker: same requestId billed once', () => {
  let dir: string;
  let logPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-reqid-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

    const transcriptLines = [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntryFull({ model: 'claude-sonnet-4-6', requestId: 'req_same', inputTokens: 100, outputTokens: 10 }),
      assistantEntryFull({ model: 'claude-sonnet-4-6', requestId: 'req_same', inputTokens: 100, outputTokens: 20 }),
      assistantEntryFull({ model: 'claude-sonnet-4-6', requestId: 'req_same', inputTokens: 100, outputTokens: 30 }),
    ];
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('three streamed entries of one requestId bill as api_calls: 1', () => {
    const [firstLine] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(firstLine);
    expect(entry.api_calls).toBe(1);
    expect(entry.output_tokens).toBe(30);
    expect(entry.input_tokens).toBe(100);
  });
});
