// PROP-016/deterministic-channel-voice integration: applyBudgetCheck (cost-tracker.ts)
// must push a channel message on a newly-created budget alert and only flip
// notified:true on a confirmed send — a failed send must leave notified:false so
// heartbeat-precheck's EVALUATE wake remains the fallback announcement path.
//
// Subprocess tests (via runScript), same rationale as cost-tracker-budget.test.ts:
// cost-tracker.ts resolves HERMIT_DIR from cwd at module load.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { startHttpStub, type Stub } from './helpers/http-stub';

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

function setupWithChannel(budgetConfig: object): { dir: string; cchDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-budget-push-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const cchDir = path.join(dir, '.claude-code-hermit');
  fs.mkdirSync(path.join(cchDir, 'state'), { recursive: true });
  const stateDir = path.join(dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  fs.writeFileSync(path.join(cchDir, 'state', 'runtime.json'), JSON.stringify({ session_id: 'test-session', session_state: 'active' }));
  fs.writeFileSync(path.join(cchDir, 'config.json'), JSON.stringify({
    timezone: 'UTC',
    channels: { telegram: { enabled: true, dm_channel_id: '12345', state_dir: '.claude.local/channels/telegram' } },
    budget: budgetConfig,
  }));
  return { dir, cchDir };
}

async function runTurn(dir: string, stubUrl: string, inputTokens: number, outputTokens: number): Promise<void> {
  const transcriptLines = [
    triggerPrompt('[hermit-routine:demo] start'),
    assistantEntry('claude-sonnet-4-6', inputTokens, outputTokens),
  ];
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');
  const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
  await runScript('cost-tracker.ts', {
    stdin, cwd: dir,
    env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_TELEGRAM_API_URL: stubUrl },
  });
}

describe('cost-tracker: budget push on breach (send succeeds)', () => {
  let dir: string; let cchDir: string; let stub: Stub;

  beforeAll(async () => {
    stub = startHttpStub();
    ({ dir, cchDir } = setupWithChannel({ daily_usd: 1.0, weekly_usd: null, monthly_usd: null, action: 'pause' }));
    // cost = (100000/1e6)*3 + (50000/1e6)*15 = 1.05 -> ratio 1.05 vs cap 1.0 (breach)
    await runTurn(dir, stub.url, 100000, 50000);
  });
  afterAll(() => { stub.stop(); fs.rmSync(dir, { recursive: true }); });

  test('sends a push naming the breach and the pause boundary', () => {
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toContain('Budget cap reached');
    expect(stub.requests[0].body.text).toContain("today's spend");
  });

  test('flips the alert entry to notified:true on a confirmed send', () => {
    const state = JSON.parse(fs.readFileSync(path.join(cchDir, 'state', 'alert-state.json'), 'utf-8'));
    const keys = Object.keys(state.alerts).filter((k) => k.startsWith('budget-breach:daily:'));
    expect(keys).toHaveLength(1);
    expect(state.alerts[keys[0]].notified).toBe(true);
  });
});

describe('cost-tracker: budget push on warn (send fails -> notified stays false)', () => {
  let dir: string; let cchDir: string;

  beforeAll(async () => {
    ({ dir, cchDir } = setupWithChannel({ daily_usd: 1.0, weekly_usd: null, monthly_usd: null, action: 'alert' }));
    // cost = (200000/1e6)*3 + (16000/1e6)*15 = 0.84 -> ratio 0.84 vs cap 1.0 (warn)
    await runTurn(dir, 'http://127.0.0.1:1', 200000, 16000);
  });
  afterAll(() => { fs.rmSync(dir, { recursive: true }); });

  test('a failed send leaves notified:false so the heartbeat-precheck fallback still fires', () => {
    const state = JSON.parse(fs.readFileSync(path.join(cchDir, 'state', 'alert-state.json'), 'utf-8'));
    const keys = Object.keys(state.alerts).filter((k) => k.startsWith('budget-warn:daily:'));
    expect(keys).toHaveLength(1);
    expect(state.alerts[keys[0]].notified).toBe(false);
  });
});

describe('cost-tracker: a repeat breach tick at the same boundary does not re-stamp or re-push', () => {
  let dir: string; let cchDir: string; let stub: Stub;
  let tsAfterFirst: string; let tsAfterSecond: string;

  const pauseTs = (d: string) => JSON.parse(fs.readFileSync(path.join(d, 'state', 'pause.json'), 'utf-8')).ts;

  beforeAll(async () => {
    stub = startHttpStub();
    ({ dir, cchDir } = setupWithChannel({ daily_usd: 1.0, weekly_usd: null, monthly_usd: null, action: 'pause' }));
    // First tick: breach -> pauses and pushes.
    await runTurn(dir, stub.url, 100000, 50000);
    tsAfterFirst = pauseTs(cchDir);
    // Second tick: still over the same daily cap, same auto-resume boundary.
    await runTurn(dir, stub.url, 100000, 50000);
    tsAfterSecond = pauseTs(cchDir);
  });
  afterAll(() => { stub.stop(); fs.rmSync(dir, { recursive: true }); });

  test('only one push across both breach ticks (create-only alert dedup)', () => {
    expect(stub.requests.length).toBe(1);
  });

  test('pause.json ts is unchanged on the second tick (no re-stamp -> watchdog dedup holds)', () => {
    expect(tsAfterSecond).toBe(tsAfterFirst);
  });
});
