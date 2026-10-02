// issue #793 — a guest session must not refresh the resident's liveness signal.
//
// state/.heartbeat is one of four liveness files and the watchdog reads its age for
// wedge detection, so a guest turn touching it means a frozen resident never looks
// stale and is never restarted.
//
// Usage: bun test tests/stop-pipeline-guest.test.ts   (from the plugin root)

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { fixturesDir, withDir } from './helpers/workdir';
import { markGuest } from '../scripts/lib/guest-marker';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const PIPE_ENV = { AGENT_HOOK_PROFILE: 'standard', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };
const SESSION_ID = 'test-session-001'; // as carried by the stop-hook fixture

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

function stopHookInput(dir: string): string {
  const transcript = path.join(dir, '.claude', 'transcript.jsonl');
  fs.copyFileSync(path.join(fixturesDir, 'transcript.jsonl'), transcript);
  return fs
    .readFileSync(path.join(fixturesDir, 'stop-hook-input.json'), 'utf-8')
    .replace('__TRANSCRIPT_PATH__', transcript);
}

// Seed .heartbeat with a known-old mtime so a touch is unambiguous.
function seedHeartbeat(dir: string): { file: string; mtimeMs: number } {
  const file = hermit(dir, 'state', '.heartbeat');
  fs.writeFileSync(file, 'seed\n');
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  fs.utimesSync(file, old, old);
  return { file, mtimeMs: fs.statSync(file).mtimeMs };
}

async function runStop(dir: string) {
  return runScript('stop-pipeline.ts', { stdin: stopHookInput(dir), cwd: dir, env: PIPE_ENV });
}

describe('stop-pipeline — guest liveness gate', () => {
  test('a guest turn leaves the resident heartbeat untouched', withDir(async (dir) => {
    const { file, mtimeMs } = seedHeartbeat(dir);
    markGuest(hermit(dir, 'state'), SESSION_ID);

    const r = await runStop(dir);

    expect(r.exitCode).toBe(0);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeMs);
    // The rest of the pipeline still runs for a guest — only the touch is gated.
    expect(r.stderr).toContain('cost-tracker');
  }));

  test('an unmarked session touches the heartbeat as before', withDir(async (dir) => {
    const { file, mtimeMs } = seedHeartbeat(dir);

    const r = await runStop(dir);

    expect(r.exitCode).toBe(0);
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(mtimeMs);
  }));

  test('a marker for a different session does not gate this one', withDir(async (dir) => {
    const { file, mtimeMs } = seedHeartbeat(dir);
    markGuest(hermit(dir, 'state'), 'some-other-session');

    await runStop(dir);

    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(mtimeMs);
  }));
});

// Issue #916 — cost rows have to say WHICH session produced them.
//
// cc_session_id is the writing session's own harness id, and guest marks a row
// the resident must never read as its own context.
describe('stop-pipeline — cost row session attribution', () => {
  const mainRows = (dir: string): any[] =>
    fs.readFileSync(path.join(dir, '.claude', 'cost-log.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.subagent !== true);

  test('a row records only the writing harness session id', withDir(async (dir) => {
    fs.writeFileSync(
      hermit(dir, 'state', 'runtime.json'),
      JSON.stringify({ version: 1 }),
    );

    const r = await runStop(dir);

    expect(r.exitCode).toBe(0);
    const row = mainRows(dir).at(-1);
    expect(row).not.toHaveProperty('session_id');
    expect(row.cc_session_id).toBe(SESSION_ID);
    expect('guest' in row).toBe(false);
  }));

  test('a guest turn writes a row flagged guest', withDir(async (dir) => {
    markGuest(hermit(dir, 'state'), SESSION_ID);

    const r = await runStop(dir);

    expect(r.exitCode).toBe(0);
    const row = mainRows(dir).at(-1);
    expect(row.cc_session_id).toBe(SESSION_ID);
    expect(row.guest).toBe(true);
  }));
});


describe('guest Stop preserves resident scheduling state', () => {
  for (const idKey of ['session_id', 'sessionId']) {
    test(`preserves turn, snapshot and pending command with ${idKey}`, withDir(async (dir) => {
      const state = hermit(dir, 'state');
      markGuest(state, SESSION_ID);
      const files = ['operator-turn-open.json', 'cc-stop-snapshot.json', 'pending-harness-command.json'];
      for (const name of files) fs.writeFileSync(path.join(state, name), '{"resident":"untouched"}');
      const input = JSON.parse(stopHookInput(dir));
      delete input.session_id;
      input[idKey] = SESSION_ID;
      const r = await runScript('stop-pipeline.ts', { stdin: JSON.stringify(input), cwd: dir, env: PIPE_ENV });
      expect(r.exitCode).toBe(0);
      for (const name of files) expect(fs.readFileSync(path.join(state, name), 'utf-8')).toBe('{"resident":"untouched"}');
      expect(r.stderr).toContain('cost-tracker');
    }));
  }
});
