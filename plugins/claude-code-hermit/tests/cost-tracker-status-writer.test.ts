// Drive-by test (deterministic channel voice work): writeStatusJson (cost-tracker.ts)
// must populate sessions/.status.json's `status`/`task` fields from real
// runtime.json/SHELL.md state, not fall back to "unknown"/"" — the channel
// status responder reads exactly these fields, and a hatched install with no
// runtime.json or no `## Task` section previously read as blank.
//
// Subprocess test (via runScript), same rationale as cost-tracker-budget.test.ts:
// cost-tracker.ts resolves HERMIT_DIR from cwd at module load.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { fixturesDir } from './helpers/workdir';

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

describe('cost-tracker: writeStatusJson populates status/task from real state', () => {
  let dir: string;
  let statusPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-status-'));
    const cchDir = path.join(dir, '.claude-code-hermit');
    fs.mkdirSync(path.join(cchDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(cchDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

    fs.writeFileSync(
      path.join(cchDir, 'state', 'runtime.json'),
      JSON.stringify({ session_id: 'test-session', session_state: 'in_progress' })
    );
    fs.writeFileSync(path.join(cchDir, 'config.json'), JSON.stringify({ timezone: null }));
    fs.copyFileSync(
      path.join(fixturesDir, 'shell-session.md'),
      path.join(cchDir, 'sessions', 'SHELL.md')
    );

    const transcriptLines = [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntry('claude-sonnet-4-6', 1000, 500),
    ];
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');
    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });

    statusPath = path.join(cchDir, 'sessions', '.status.json');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true });
  });

  test('status reflects runtime.json session_state, not "unknown"', () => {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    expect(status.status).toBe('in_progress');
  });

  test('task reflects SHELL.md\'s ## Task section, not ""', () => {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    expect(status.task).toBe('Test task for hook validation');
  });
});
