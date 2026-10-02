import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPinnedScript } from './helpers/run';

function withTmp(fn: (stateFile: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-reflwindow-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    try { await fn(path.join(dir, 'state', 'reflection-state.json')); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

const rootOf = (stateFile: string) => path.dirname(path.dirname(stateFile));

function writeState(stateFile: string, state: unknown) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

function readState(stateFile: string) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

async function runPayload(stateFile: string, payload: Record<string, unknown>) {
  const result = await runPinnedScript(
    'update-reflection-state.ts',
    rootOf(stateFile),
    [stateFile, JSON.stringify({ ran_with_candidates: true, ...payload })],
  );
  expect(result.exitCode).toBe(0);
  return readState(stateFile);
}

describe('update-reflection-state judge window', () => {
  test('first verdict-bearing run creates a letter ring with derived counts', withTmp(async (stateFile) => {
    const state = await runPayload(stateFile, { judge_accept: 2, judge_downgrade: 1, judge_suppress: 3 });
    const window = state.counters.judge_window;

    expect(window.ring).toBe('sasads');
    expect(window).toMatchObject({ accept: 2, downgrade: 1, suppress: 3, verdicts: 6 });
    expect(window).not.toHaveProperty('runs');
    expect(window).not.toHaveProperty('since');
  }));

  test('a zero-verdict run preserves an existing window and does not create one when absent', withTmp(async (stateFile) => {
    const existingWindow = {
      ring: 'aaadss',
      accept: 3,
      downgrade: 1,
      suppress: 2,
      verdicts: 6,
    };
    writeState(stateFile, { counters: { judge_window: existingWindow } });

    const existing = await runPayload(stateFile, {});
    expect(existing.counters.judge_window).toEqual(existingWindow);

    writeState(stateFile, { counters: {} });
    const absent = await runPayload(stateFile, {});
    expect(absent.counters).not.toHaveProperty('judge_window');
  }));

  test('trimming keeps exactly the last 20 verdicts', withTmp(async (stateFile) => {
    for (let run = 0; run < 3; run += 1) {
      await runPayload(stateFile, { judge_accept: 8 });
    }
    const initialWindow = readState(stateFile).counters.judge_window;
    expect(initialWindow.ring.length).toBe(20);
    expect(initialWindow.verdicts).toBe(20);

    await runPayload(stateFile, { judge_accept: 8 });
    const window = readState(stateFile).counters.judge_window;
    expect(window.ring.length).toBe(20);
    expect(window.verdicts).toBe(20);
    expect(window.ring).toBe('a'.repeat(20));
  }));

  test('reported counts equal per-letter tallies of the ring', withTmp(async (stateFile) => {
    const payloads = [
      { judge_accept: 8 },
      { judge_downgrade: 5, judge_suppress: 3 },
      { judge_accept: 2, judge_suppress: 6 },
      { judge_accept: 4, judge_downgrade: 3, judge_suppress: 1 },
    ];
    for (const payload of payloads) await runPayload(stateFile, payload);

    const window = readState(stateFile).counters.judge_window;
    expect(window.ring).toMatch(/^[ads]{1,20}$/);
    expect(window.accept).toBe(window.ring.split('a').length - 1);
    expect(window.downgrade).toBe(window.ring.split('d').length - 1);
    expect(window.suppress).toBe(window.ring.split('s').length - 1);
    expect(window.verdicts).toBe(window.ring.length);
  }));

  test('cumulative judge tallies keep growing past the window totals', withTmp(async (stateFile) => {
    writeState(stateFile, { counters: { judge_suppress: 40, judge_accept: 2 } });
    for (let run = 0; run < 3; run += 1) {
      await runPayload(stateFile, { judge_accept: 3, judge_suppress: 1 });
    }

    const counters = readState(stateFile).counters;
    expect(counters.judge_window).toMatchObject({ accept: 9, suppress: 3 });
    expect(counters.judge_accept).toBe(11);
    expect(counters.judge_suppress).toBe(43);
  }));

  test('a malformed window is replaced by a fresh ring', withTmp(async (stateFile) => {
    writeState(stateFile, { counters: { judge_window: 'malformed' } });
    const state = await runPayload(stateFile, { judge_accept: 1, judge_suppress: 2 });

    expect(state.counters.judge_window.ring).toBe('sas');
    expect(state.counters.judge_window).toMatchObject({
      accept: 1,
      downgrade: 0,
      suppress: 2,
      verdicts: 3,
    });
    expect(state.counters.judge_window).not.toHaveProperty('runs');
  }));

  test('--reset-counters clears the judge window and stamps judge_since', withTmp(async (stateFile) => {
    writeState(stateFile, {
      counters: {
        judge_accept: 3,
        judge_suppress: 2,
        judge_window: {
          runs: [{ at: '2026-08-01T00:00:00.000Z', accept: 3, downgrade: 0, suppress: 2 }],
          accept: 3,
          downgrade: 0,
          suppress: 2,
          verdicts: 5,
          since: '2026-08-01T00:00:00.000Z',
        },
      },
    });

    const result = await runPinnedScript(
      'update-reflection-state.ts',
      rootOf(stateFile),
      [stateFile, '--reset-counters'],
    );
    expect(result.exitCode).toBe(0);
    const counters = readState(stateFile).counters;
    expect(counters).not.toHaveProperty('judge_window');
    expect(typeof counters.judge_since).toBe('string');
  }));

  test('an on-disk runs window folds into the ring without resetting', withTmp(async (stateFile) => {
    writeState(stateFile, {
      counters: {
        judge_accept: 6,
        judge_downgrade: 3,
        judge_suppress: 3,
        judge_window: {
          runs: [
            { at: '2026-08-01T00:00:00.000Z', accept: 4, downgrade: 2, suppress: 0 },
            { at: '2026-08-02T00:00:00.000Z', accept: 2, downgrade: 1, suppress: 3 },
          ],
          accept: 6,
          downgrade: 3,
          suppress: 3,
          verdicts: 12,
          since: '2026-08-01T00:00:00.000Z',
        },
      },
    });

    const state = await runPayload(stateFile, { judge_accept: 5, judge_downgrade: 2, judge_suppress: 3 });
    const window = state.counters.judge_window;
    const expected = ('aaadad' + 'sasads' + 'aaasadsads').slice(-20);
    expect(window.ring).toBe(expected);
    expect(window.accept).toBe(expected.split('a').length - 1);
    expect(window.downgrade).toBe(expected.split('d').length - 1);
    expect(window.suppress).toBe(expected.split('s').length - 1);
    expect(window.verdicts).toBe(expected.length);
    expect(window).not.toHaveProperty('runs');
    expect(window).not.toHaveProperty('since');
    expect(state.counters.judge_accept).toBe(11);
    expect(state.counters.judge_downgrade).toBe(5);
    expect(state.counters.judge_suppress).toBe(6);
  }));

  test('a zero-verdict run folds a legacy runs window into the ring', withTmp(async (stateFile) => {
    writeState(stateFile, {
      counters: {
        judge_window: {
          runs: [
            { at: '2026-08-01T00:00:00.000Z', accept: 4, downgrade: 2, suppress: 0 },
            { at: '2026-08-02T00:00:00.000Z', accept: 2, downgrade: 1, suppress: 3 },
          ],
          accept: 6,
          downgrade: 3,
          suppress: 3,
          verdicts: 12,
          since: '2026-08-01T00:00:00.000Z',
        },
      },
    });

    const window = (await runPayload(stateFile, {})).counters.judge_window;
    expect(window.ring).toBe('aaadad' + 'sasads');
    expect(window).toMatchObject({ accept: 6, downgrade: 3, suppress: 3, verdicts: 12 });
    expect(window).not.toHaveProperty('runs');
    expect(window).not.toHaveProperty('since');
  }));

  test('an absurd verdict count caps the ring instead of aborting the state write', withTmp(async (stateFile) => {
    const state = await runPayload(stateFile, { judge_accept: 1e11, judge_suppress: 4 });
    const window = state.counters.judge_window;

    expect(window.ring).toBe('a'.repeat(12) + 'asasasas');
    expect(window).toMatchObject({ accept: 16, downgrade: 0, suppress: 4, verdicts: 20 });
    expect(typeof state.counters.last_run_at).toBe('string');
  }));
});
