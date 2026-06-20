// Tests for scripts/subagent-cost.ts — SubagentStop hook that captures
// async-dispatched subagent token cost.
//
// Each test runs the hook as a subprocess (same pattern as cost-tracker.test.ts)
// with a SubagentStop payload and validates cost-log.jsonl output.
//
// The payload shape mirrors what real Claude Code sends on SubagentStop (verified live
// on CC 2.1.183):
//   { session_id, transcript_path: "<parent>.jsonl", agent_id,
//     agent_type, agent_transcript_path: ".../subagents/agent-<agent_id>.jsonl",
//     last_assistant_message, hook_event_name: "SubagentStop", stop_hook_active }
// Critically: transcript_path is the PARENT transcript; the SUBAGENT transcript is at
// agent_transcript_path. The hook must sum agent_transcript_path, not transcript_path.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';

// ---------------------------------------------------------------------------
// Helpers — synthetic transcript builders
// ---------------------------------------------------------------------------

function assistantEntry(model: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model,
      usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: outputTokens },
      content: [{ type: 'text', text: 'done' }],
    },
  });
}

function triggerPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

// Async-launch dispatch result — written to the PARENT transcript at launch time
// (matches the real shape: { isAsync:true, status:"async_launched", agentId, ... }).
function asyncLaunchEntry(agentId: string, resolvedModel: string): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId, resolvedModel },
  });
}

// Sync-completion dispatch result (status:"completed" with usage). cost-tracker.ts logs
// these at Stop; this hook must NOT (no async marker). Note: in reality this entry is only
// written to the parent AFTER SubagentStop fires — the positive-async check is what makes
// the hook robust to that ordering, so its presence here must still yield zero rows.
function syncCompleteEntry(agentId: string): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '' }] },
    toolUseResult: {
      agentType: 'general-purpose', agentId,
      status: 'completed',
      usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 },
    },
  });
}

// Build a minimal hermit project layout that subagent-cost.ts can resolve:
//   <root>/.claude/cost-log.jsonl              (written by the hook)
//   <root>/.claude-code-hermit/state/runtime.json
//   <root>/.claude/projects/<proj>/<sessionUuid>.jsonl  (PARENT transcript → transcript_path)
//   <root>/.claude/projects/<proj>/<sessionUuid>/subagents/agent-<agentId>.jsonl
//                                                       (SUBAGENT → agent_transcript_path)
interface Layout {
  root: string;
  logPath: string;
  agentId: string;
  subagentTranscriptPath: string;
  parentTranscriptPath: string;
  sessionUuid: string;
}

function buildLayout(rootSuffix = 'hermit-subagent-cost-'): Layout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), rootSuffix));

  // Cost-log dir
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const logPath = path.join(root, '.claude', 'cost-log.jsonl');

  // Hermit state dir
  const stateDir = path.join(root, '.claude-code-hermit', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ session_id: 'rt-session' }));

  // Project + session dirs
  const projDir = path.join(root, '.claude', 'projects', '-home-user-myproject');
  const sessionUuid = 'fa030166-cf2d-4f1b-90c9-93e889b9e412';
  const subagentsDir = path.join(projDir, sessionUuid, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });

  const agentId = 'ab1812c331e910424';
  const subagentTranscriptPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  const parentTranscriptPath   = path.join(projDir, `${sessionUuid}.jsonl`);

  return { root, logPath, agentId, subagentTranscriptPath, parentTranscriptPath, sessionUuid };
}

// Real SubagentStop payload shape: transcript_path = PARENT, agent_transcript_path = SUBAGENT.
function makePayload(layout: Layout, agentType = 'claude-code-hermit:skill-eval-runner'): string {
  return JSON.stringify({
    session_id: 'hook-session',
    transcript_path: layout.parentTranscriptPath,
    agent_transcript_path: layout.subagentTranscriptPath,
    agent_id: layout.agentId,
    agent_type: agentType,
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
  });
}

async function runHookAndReadLog(layout: Layout): Promise<any[]> {
  await runScript('subagent-cost.ts', {
    stdin: makePayload(layout),
    cwd: layout.root,
    env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  if (!fs.existsSync(layout.logPath)) return [];
  return fs.readFileSync(layout.logPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subagent-cost: happy path — async heartbeat dispatch', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    // Subagent transcript: two haiku calls
    fs.writeFileSync(layout.subagentTranscriptPath, [
      assistantEntry('claude-haiku-4-5-20251001', 1000, 400),
      assistantEntry('claude-haiku-4-5-20251001', 200, 80),
    ].join('\n') + '\n');
    // Parent transcript: heartbeat trigger → async dispatch (different model/tokens than subagent)
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('HEARTBEAT_EVALUATE'),
      assistantEntry('claude-sonnet-4-6', 500, 100),
      asyncLaunchEntry(layout.agentId, 'claude-haiku-4-5-20251001'),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('emits exactly one row', () => expect(rows).toHaveLength(1));
  test('row has subagent:true', () => expect(rows[0].subagent).toBe(true));
  test('row model is haiku', () => expect(rows[0].model).toBe('haiku'));
  test('row model_resolved is true', () => expect(rows[0].model_resolved).toBe(true));
  test('row source is heartbeat', () => expect(rows[0].source).toBe('heartbeat'));
  test('row token counts are summed across both calls', () => {
    expect(rows[0].input_tokens).toBe(1200);
    expect(rows[0].output_tokens).toBe(480);
    expect(rows[0].total_tokens).toBe(1680);
  });
  test('row api_calls is 0', () => expect(rows[0].api_calls).toBe(0));
  test('row estimated_cost_usd is positive', () => expect(rows[0].estimated_cost_usd).toBeGreaterThan(0));
  test('row agent_type matches payload', () => expect(rows[0].agent_type).toBe('claude-code-hermit:skill-eval-runner'));
  test('row session_id comes from payload', () => expect(rows[0].session_id).toBe('hook-session'));
});

// Regression guard for the original ship-blocker: the hook summed payload.transcript_path
// (the PARENT) instead of agent_transcript_path (the subagent). Give the two transcripts
// unmistakably different usage and assert the row reflects the SUBAGENT.
describe('subagent-cost: reads the subagent transcript, not the parent', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    // Subagent: small haiku usage
    fs.writeFileSync(layout.subagentTranscriptPath, [
      assistantEntry('claude-haiku-4-5-20251001', 7, 3),
    ].join('\n') + '\n');
    // Parent: huge opus usage — must NOT leak into the row
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('HEARTBEAT_EVALUATE'),
      assistantEntry('claude-opus-4-6', 999999, 888888),
      asyncLaunchEntry(layout.agentId, 'claude-haiku-4-5-20251001'),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('emits one row', () => expect(rows).toHaveLength(1));
  test('row reflects subagent tokens (not parent)', () => {
    expect(rows[0].input_tokens).toBe(7);
    expect(rows[0].output_tokens).toBe(3);
  });
  test('row model is the subagent model (haiku, not opus)', () => expect(rows[0].model).toBe('haiku'));
});

describe('subagent-cost: sync dispatch — skip (no async marker, cost-tracker owns it)', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    fs.writeFileSync(layout.subagentTranscriptPath, [
      assistantEntry('claude-haiku-4-5-20251001', 1000, 400),
    ].join('\n') + '\n');
    // Parent shows a sync completion (no async-launch marker) — must not be logged here.
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('HEARTBEAT_EVALUATE'),
      syncCompleteEntry(layout.agentId),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('emits no rows (no async-launch marker → cost-tracker.ts owns sync dispatches)', () =>
    expect(rows).toHaveLength(0));
});

describe('subagent-cost: async launch only for a different agent — no row for ours', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    fs.writeFileSync(layout.subagentTranscriptPath, [
      assistantEntry('claude-haiku-4-5-20251001', 500, 200),
    ].join('\n') + '\n');
    // Parent has an async launch, but for a DIFFERENT agentId — ours can't be confirmed async.
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('HEARTBEAT_EVALUATE'),
      asyncLaunchEntry('some-other-agent-id', 'claude-haiku-4-5-20251001'),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('emits no rows', () => expect(rows).toHaveLength(0));
});

describe('subagent-cost: async launch with unrecognized trigger — source falls back to other', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    fs.writeFileSync(layout.subagentTranscriptPath, [
      assistantEntry('claude-haiku-4-5-20251001', 500, 200),
    ].join('\n') + '\n');
    // Async launch present for our agent, but the trigger isn't a heartbeat/routine marker.
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('some unrelated prompt'),
      asyncLaunchEntry(layout.agentId, 'claude-haiku-4-5-20251001'),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('emits one row', () => expect(rows).toHaveLength(1));
  test('source falls back to other', () => expect(rows[0].source).toBe('other'));
  test('model still haiku', () => expect(rows[0].model).toBe('haiku'));
});

describe('subagent-cost: unreadable subagent transcript — fail open, no row', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    // Do NOT write the subagent transcript; parent confirms async so we get past that gate.
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('HEARTBEAT_EVALUATE'),
      asyncLaunchEntry(layout.agentId, 'claude-haiku-4-5-20251001'),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('emits no rows', () => expect(rows).toHaveLength(0));
});

describe('subagent-cost: empty payload — fail open, no row', () => {
  let layout: Layout;

  beforeAll(() => { layout = buildLayout(); });
  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('exits 0 on empty stdin', async () => {
    const r = await runScript('subagent-cost.ts', {
      stdin: '', cwd: layout.root, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  });

  test('exits 0 on stop_hook_active guard', async () => {
    const r = await runScript('subagent-cost.ts', {
      stdin: JSON.stringify({ stop_hook_active: true, agent_transcript_path: layout.subagentTranscriptPath, agent_id: layout.agentId }),
      cwd: layout.root,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(layout.logPath)).toBe(false);
  });
});

describe('subagent-cost: routine dispatch source attribution', () => {
  let layout: Layout;
  let rows: any[];

  beforeAll(async () => {
    layout = buildLayout();
    fs.writeFileSync(layout.subagentTranscriptPath, [
      assistantEntry('claude-haiku-4-5-20251001', 800, 300),
    ].join('\n') + '\n');
    fs.writeFileSync(layout.parentTranscriptPath, [
      triggerPrompt('[hermit-routine:daily-brief] run\nlog-routine-event.sh daily-brief fired'),
      assistantEntry('claude-sonnet-4-6', 200, 50),
      asyncLaunchEntry(layout.agentId, 'claude-haiku-4-5-20251001'),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ].join('\n') + '\n');
    rows = await runHookAndReadLog(layout);
  });

  afterAll(() => fs.rmSync(layout.root, { recursive: true }));

  test('source is routine:daily-brief', () => expect(rows[0].source).toBe('routine:daily-brief'));
});
