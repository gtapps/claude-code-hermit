// Shared read/write helpers for the alert-state files. Atomic write mirrors
// lib/runtime.ts; the read splits the file read from the JSON parse so callers
// can tell a transient read error (healthy file — never destroy it) from genuine
// corruption (quarantine + rebuild). Path-parameterized: precheck derives the
// path from stateDir, update-alert-state takes argv.
//
// Alert entries are split across per-writer files so cross-process writers can't
// clobber each other's keys with a whole-file overwrite (the same reasoning that
// split pause.json out of runtime.json):
//   - alert-state.json     — skill/checklist alerts + self_eval + total_ticks +
//                            last_stale_wake_at (heartbeat-precheck, update-alert-state;
//                            within one heartbeat cycle, so merge-safe as before)
//   - budget-alerts.json   — budget-* alerts (cost-tracker, Stop hook — sole writer)
//   - telemetry-alert.json — the telemetry export-failed alert (report-export,
//                            watchdog tick — sole writer)
// Each of the latter two has exactly one writer process, so the plain atomic
// tmp+rename write needs no lock. Generic readers that want "all alerts" call
// readMergedAlerts() to union the three files (keyspaces are disjoint by
// construction: checklist / budget-* / telemetry:*).

import fs from 'node:fs';
import path from 'node:path';

type Json = any;

export function alertStatePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'alert-state.json');
}
export function budgetAlertsPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'budget-alerts.json');
}
export function telemetryAlertPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'telemetry-alert.json');
}

export const defaultAlertState = (): Json =>
  ({ alerts: {}, last_digest_date: null, self_eval: {}, total_ticks: 0 });

export type AlertRead =
  | { kind: 'ok'; value: Json }
  | { kind: 'missing' }                  // ENOENT — first run, seed default
  | { kind: 'corrupt' }                  // bytes read, parse failed / not an object — quarantine
  | { kind: 'ioerror'; code?: string };  // EACCES/EMFILE/EIO/EISDIR — healthy file, DO NOT destroy

export function readAlertState(p: string): AlertRead {
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf-8'); }            // separate the read…
  catch (err: any) {
    return err?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'ioerror', code: err?.code };
  }
  try {
    const value = JSON.parse(raw);                       // …from the parse
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'corrupt' };
    return { kind: 'ok', value };
  } catch { return { kind: 'corrupt' }; }
}

export function quarantineAlertState(p: string, stamp: number): void {
  try { fs.renameSync(p, `${p}.corrupt-${stamp}`); } catch { /* fail-open */ }
}

export function writeAlertState(p: string, obj: Json): void {
  try {
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, p);
  } catch { /* fail-open */ }
}

/**
 * Union of alert entries across the three per-writer files, for generic readers
 * (dashboard, cost-summary, telemetry bundle, the heartbeat budget scan) that
 * want the full alert view. Later files win on a key collision, but the keyspaces
 * are disjoint by construction. Unreadable/corrupt/missing files contribute nothing.
 */
export function readMergedAlerts(stateDir: string): Json {
  const merged: Json = {};
  for (const p of [alertStatePath(stateDir), budgetAlertsPath(stateDir), telemetryAlertPath(stateDir)]) {
    const r = readAlertState(p);
    if (r.kind === 'ok' && r.value?.alerts && typeof r.value.alerts === 'object') {
      Object.assign(merged, r.value.alerts);
    }
  }
  return merged;
}

/**
 * Read-modify-write of a single-owner alert file (budget-alerts.json owned by
 * cost-tracker, telemetry-alert.json by report-export). One writer process per
 * file means the plain read → mutate → atomic write needs no lock. Corrupt →
 * quarantine + start fresh; ioerror (healthy-but-unreadable) → skip and return
 * false so the caller can decline to act on a state it couldn't read.
 */
export function mutateOwnedAlerts(p: string, mutator: (alerts: Json) => void): boolean {
  const read = readAlertState(p);
  if (read.kind === 'ioerror') return false;
  let state: Json = read.kind === 'ok' ? read.value : defaultAlertState();
  if (read.kind === 'corrupt') { quarantineAlertState(p, Date.now()); state = defaultAlertState(); }
  if (!state.alerts || typeof state.alerts !== 'object') state.alerts = {};
  mutator(state.alerts);
  writeAlertState(p, state);
  return true;
}
