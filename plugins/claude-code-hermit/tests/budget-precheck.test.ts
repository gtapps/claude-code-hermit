// PROP-016 budget-gate contract for heartbeat-precheck.ts.
//
// Two mechanisms under test:
//  1. The pause-escape gate: a budget-reason pause (action:"pause") would normally
//     hit the earliest SKIP|paused gate — but that SKIP would also silence the one
//     wake needed to announce the breach. An un-notified budget alert lets exactly
//     one EVALUATE through; once notified, it falls back to plain SKIP|paused.
//  2. The pending-budget-alert gate: surfaces an un-notified budget alert as
//     EVALUATE even when the hermit isn't paused at all (action:"alert").
//
// Scripts are exercised as subprocesses (via runScript) — the boundary hooks see.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const alertPath = (dir: string) => hermit(dir, 'state', 'alert-state.json');
const pausePath = (dir: string) => hermit(dir, 'state', 'pause.json');

// Matches isProposalScanItem so, with no proposals/ dir and no pending alert, the
// checklist loop's default item auto-resolves 'clean' — keeping the OK-path test
// below from being confounded by an unrelated unsatisfied checklist item.
const HEARTBEAT_MD = '# Heartbeat\n\n- [ ] Review proposals/ for any with status: proposed\n';
const NOW = '2026-07-04T22:00:00+00:00';

interface Tmp { dir: string; cleanup(): void }

function makeDir(): Tmp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-budget-precheck-'));
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  fs.writeFileSync(hermit(dir, 'HEARTBEAT.md'), HEARTBEAT_MD);
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function withTmp(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const t = makeDir();
    try { await fn(t.dir); } finally { t.cleanup(); }
  };
}

function writeAlertState(dir: string, alerts: Record<string, unknown>): void {
  fs.writeFileSync(alertPath(dir), JSON.stringify({
    alerts, last_digest_date: null, self_eval: {}, total_ticks: 5,
  }));
}

function writePause(dir: string, reason: string): void {
  fs.writeFileSync(pausePath(dir), JSON.stringify({
    paused: true, paused_until: null, reason, by: 'test', ts: NOW,
  }));
}

const budgetEntry = (notified: boolean) => ({
  kind: 'budget', level: 'breach', period: 'daily', action: 'pause',
  spend: 6, cap: 5, ratio: 1.2, notified, ts: NOW,
});

async function precheck(dir: string): Promise<string> {
  const r = await runScript('heartbeat-precheck.ts', {
    args: ['.claude-code-hermit'],
    cwd: dir,
    env: { HERMIT_NOW: NOW },
  });
  return r.stdout.trim();
}

describe('budget pause-escape gate', () => {
  test('un-notified budget-reason pause lets one EVALUATE through', withTmp(async (dir) => {
    writePause(dir, 'budget');
    writeAlertState(dir, { 'budget-breach:daily:2026-07-04': budgetEntry(false) });

    expect(await precheck(dir)).toBe('EVALUATE');
  }));

  test('notified budget-reason pause falls back to plain SKIP|paused', withTmp(async (dir) => {
    writePause(dir, 'budget');
    writeAlertState(dir, { 'budget-breach:daily:2026-07-04': budgetEntry(true) });

    expect(await precheck(dir)).toBe('SKIP|paused');
  }));

  test('operator-reason pause never escapes, even with an un-notified budget alert', withTmp(async (dir) => {
    writePause(dir, 'operator');
    writeAlertState(dir, { 'budget-breach:daily:2026-07-04': budgetEntry(false) });

    expect(await precheck(dir)).toBe('SKIP|paused');
  }));

  test('watchdog-reason pause never escapes', withTmp(async (dir) => {
    writePause(dir, 'watchdog');
    writeAlertState(dir, { 'budget-breach:daily:2026-07-04': budgetEntry(false) });

    expect(await precheck(dir)).toBe('SKIP|paused');
  }));

  test('no pause.json at all — unaffected, budget alert surfaces via the pending-alert gate', withTmp(async (dir) => {
    writeAlertState(dir, { 'budget-breach:daily:2026-07-04': budgetEntry(false) });

    expect(await precheck(dir)).toBe('EVALUATE');
  }));
});

describe('pending-budget-alert gate (action:"alert", not paused)', () => {
  test('un-notified budget alert forces EVALUATE', withTmp(async (dir) => {
    writeAlertState(dir, {
      'budget-warn:monthly:2026-07': { kind: 'budget', level: 'warn', period: 'monthly', action: 'alert', spend: 85, cap: 100, ratio: 0.85, notified: false, ts: NOW },
    });

    expect(await precheck(dir)).toBe('EVALUATE');
  }));

  test('all budget alerts already notified — gate does not fire (falls through to OK)', withTmp(async (dir) => {
    writeAlertState(dir, {
      'budget-warn:monthly:2026-07': { kind: 'budget', level: 'warn', period: 'monthly', action: 'alert', spend: 85, cap: 100, ratio: 0.85, notified: true, ts: NOW },
    });

    expect(await precheck(dir)).toBe('OK');
  }));

  test('non-budget alert entries do not trip the gate (falls through to OK)', withTmp(async (dir) => {
    writeAlertState(dir, {
      // suppressed:true here would ALSO fire EVALUATE via the pre-existing
      // suppressed-digest gate — omit it so this isolates the budget gate itself.
      'stale-session': { suppressed: false },
    });

    expect(await precheck(dir)).toBe('OK');
  }));
});
