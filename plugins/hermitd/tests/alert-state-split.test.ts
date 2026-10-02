// Alert-state is split across per-writer files so cross-process writers (the Stop
// hook's budget alerts, the watchdog tick's telemetry alert) can't clobber each
// other or the heartbeat's skill alerts with a whole-file overwrite. This proves
// the three keyspaces coexist and that a single-owner write touches only its file.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  mutateOwnedAlerts, readMergedAlerts, writeAlertState,
  alertStatePath, budgetAlertsPath, telemetryAlertPath, doctorAlertsPath,
} from '../scripts/lib/alert-state';

function withRoot(fn: (dir: string) => void) {
  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-alertsplit-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    try { fn(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

describe('alert-state file split', () => {
  test('budget, telemetry, doctor, and skill alerts coexist and merge', withRoot((dir) => {
    // skill alert in alert-state.json (heartbeat/update-alert-state territory)
    writeAlertState(alertStatePath(dir), { alerts: { 'checklist:checksys': { suppressed: false } }, total_ticks: 7 });
    // budget alert in its own file (cost-tracker)
    mutateOwnedAlerts(budgetAlertsPath(dir), (a) => { a['budget-breach:daily:2026-07-05'] = { kind: 'budget', notified: false }; });
    // telemetry alert in its own file (report-export)
    mutateOwnedAlerts(telemetryAlertPath(dir), (a) => { a['telemetry:export-failed'] = { count: 3 }; });
    // doctor finding episode in its own file (doctor-check — issue #690)
    mutateOwnedAlerts(doctorAlertsPath(dir), (a) => { a['doctor:permissions'] = { status: 'warn', notified: false }; });

    const merged = readMergedAlerts(dir);
    expect(Object.keys(merged).sort()).toEqual([
      'budget-breach:daily:2026-07-05', 'checklist:checksys', 'doctor:permissions', 'telemetry:export-failed',
    ]);
  }));

  test('a doctor write leaves the heartbeat-owned alert file untouched', withRoot((dir) => {
    writeAlertState(alertStatePath(dir), { alerts: { 'checklist:checksys': { suppressed: false } }, total_ticks: 7 });
    const before = fs.readFileSync(alertStatePath(dir), 'utf-8');

    mutateOwnedAlerts(doctorAlertsPath(dir), (a) => { a['doctor:permissions'] = { status: 'warn' }; });

    expect(fs.readFileSync(alertStatePath(dir), 'utf-8')).toBe(before); // byte-identical
  }));

  test('writing the budget file never touches the telemetry file (no cross-clobber)', withRoot((dir) => {
    mutateOwnedAlerts(telemetryAlertPath(dir), (a) => { a['telemetry:export-failed'] = { count: 3 }; });
    // A budget write that would previously overwrite the whole shared file:
    mutateOwnedAlerts(budgetAlertsPath(dir), (a) => { a['budget-warn:weekly:2026-W27'] = { kind: 'budget' }; });

    // Telemetry alert survives intact — different file.
    const tele = JSON.parse(fs.readFileSync(telemetryAlertPath(dir), 'utf-8'));
    expect(tele.alerts['telemetry:export-failed'].count).toBe(3);
    expect(readMergedAlerts(dir)['telemetry:export-failed']).toBeDefined();
  }));

  test('mutateOwnedAlerts returns false on an ioerror read (does not clobber)', withRoot((dir) => {
    fs.mkdirSync(budgetAlertsPath(dir)); // path is a directory → read throws EISDIR
    const applied = mutateOwnedAlerts(budgetAlertsPath(dir), (a) => { a['x'] = 1; });
    expect(applied).toBe(false);
    expect(fs.statSync(budgetAlertsPath(dir)).isDirectory()).toBe(true); // untouched
  }));
});
