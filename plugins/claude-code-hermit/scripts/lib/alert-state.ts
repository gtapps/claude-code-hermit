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
import { readFrontmatter, listProposalFiles } from './frontmatter';

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

// Returns whether the write actually landed — callers that derive side effects
// (monitoring lines, notifications) from a state change must gate on this and
// never emit for a change that didn't durably persist.
export function writeAlertState(p: string, obj: Json): boolean {
  try {
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; /* fail-open */ }
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
  return writeAlertState(p, state);
}

// ---------------------------------------------------------------------------
// Deterministic dedup/suppression/resolution/digest ladder (issue #594).
//
// Previously this bookkeeping was authored by the heartbeat eval subagent
// (a small model) directly into its JSON return — which intermittently
// invented schema fields, garbled keys, and could mark a still-pending
// micro-proposal `suppressed:true` (silencing a genuine Tier-1 operator
// decision). None of this needs judgment: it's a deterministic function of
// the prior alerts{} and the set of keys firing this tick. The subagent now
// returns only `{key, text}` pairs for items that need semantic judgment
// (checklist/custom/stale-session/waiting-timeout); this ladder is
// prefix-agnostic — the caller (update-alert-state.ts) is responsible for
// only including keys it trusts in `firing` (model judgment keys plus
// script-derived structured keys — see deriveMicroPendingKeys /
// deriveProposalPendingKeys below).
// ---------------------------------------------------------------------------

export interface FiringItem { key: string; text: string; }

export interface ClassifyTickResult {
  alerts: Json;
  monitoringLines: string[];
  notifications: string[];
  lastCleanEvalAt: string | null;
  lastDigestDate: string | null;
  heartbeatResult: 'OK' | 'ALERT';
}

export function classifyTick(opts: {
  prevAlerts: Json;
  firing: FiringItem[];
  nowIso: string;              // full ISO instant — for last_clean_eval_at
  today: string;                // tz-local YYYY-MM-DD — for first_seen/last_seen/last_digest_date
  hhmm: string;                  // tz-local HH:MM — for monitoring-line stamps
  prevLastDigestDate: string | null;
  // Keys whose `text` bakes in a raw internal id (PROP-NNN, MP-…) that must
  // never reach the operator channel (house channel-voice rule) — their
  // first-observation notification is suppressed. Monitoring lines are
  // file-only (SHELL.md), so they're unaffected and still show the id.
  silentOnNewKeys: Set<string>;
}): ClassifyTickResult {
  const { firing, nowIso, today, hhmm, silentOnNewKeys } = opts;
  const prevAlerts: Json = opts.prevAlerts && typeof opts.prevAlerts === 'object' ? opts.prevAlerts : {};
  const firingByKey = new Map(firing.map(f => [f.key, f]));
  const alerts: Json = {};
  const monitoringLines: string[] = [];
  const notifications: string[] = [];

  const allKeys = new Set([...Object.keys(prevAlerts), ...firingByKey.keys()]);
  for (const key of allKeys) {
    const item = firingByKey.get(key);
    const prev = prevAlerts[key];
    if (item) {
      if (!prev) {
        // Brand-new alert — notify once, on first observation (never repeated
        // on ticks 2-4; the operator already knows once told) — except keys
        // in silentOnNewKeys, whose text is not channel-safe.
        alerts[key] = { count: 1, consecutive_clean: 0, suppressed: false, first_seen: today, last_seen: today, text: item.text };
        monitoringLines.push(`[${hhmm}] Heartbeat: ${item.text}`);
        if (!silentOnNewKeys.has(key)) notifications.push(item.text);
      } else {
        // Stored `count` reflects observations BEFORE this fire, so the sixth
        // observation (prev.count===5) is what produces count:6 and trips
        // suppression — not the fifth. (#594 review: off-by-one in an earlier
        // draft of this ladder.)
        const count = (typeof prev.count === 'number' ? prev.count : 0) + 1;
        if (count <= 5) {
          alerts[key] = { ...prev, count, consecutive_clean: 0, last_seen: today, text: item.text, suppressed: false };
          monitoringLines.push(`[${hhmm}] Heartbeat: ${item.text}`);
        } else if (count === 6) {
          alerts[key] = { ...prev, count, consecutive_clean: 0, last_seen: today, text: item.text, suppressed: true };
          const line = `Heartbeat: above alert suppressed after 5 fires (first: ${prev.first_seen}). Daily digest only.`;
          monitoringLines.push(`[${hhmm}] ${line}`);
          notifications.push(line);
        } else {
          // count > 6 — silent; visible only via the daily digest below.
          alerts[key] = { ...prev, count, consecutive_clean: 0, last_seen: today, text: item.text, suppressed: true };
        }
      }
    } else if (prev) {
      const consecutive_clean = (typeof prev.consecutive_clean === 'number' ? prev.consecutive_clean : 0) + 1;
      if (consecutive_clean >= 2) {
        if (prev.suppressed !== true) monitoringLines.push(`[${hhmm}] Heartbeat: resolved — ${prev.text}`);
        // Suppressed → resolve silently, omit from the next digest. Entry dropped either way.
      } else {
        alerts[key] = { ...prev, consecutive_clean };
      }
    }
  }

  const suppressedEntries = Object.entries(alerts).filter(([, e]: [string, Json]) => e?.suppressed === true);
  let lastDigestDate = opts.prevLastDigestDate ?? null;
  if (suppressedEntries.length > 0 && lastDigestDate !== today) {
    const list = suppressedEntries
      .map(([, e]: [string, Json]) => `${e.text} (${e.count}x, since ${e.first_seen})`)
      .join('; ');
    notifications.push(`Suppressed alert digest: ${list}`);
    lastDigestDate = today;
  }

  return {
    alerts,
    monitoringLines,
    notifications,
    lastCleanEvalAt: firing.length === 0 ? nowIso : null,
    lastDigestDate,
    heartbeatResult: firing.length === 0 ? 'OK' : 'ALERT',
  };
}

// ---------------------------------------------------------------------------
// Structured-key derivation (issue #594, scope A′).
//
// `micro-proposal-pending:<id>` and `proposal-pending:<PROP-NNN>` are backed
// by a filesystem source-of-truth (micro-proposals.json / proposals/*.md
// frontmatter), and each silences a still-pending operator decision when
// suppressed. Leaving these to the model means a single garbled/omitted key
// can silently resolve a real pending decision two ticks later (the
// demonstrated #594 failure). Deriving them here means the model never
// authors them — omission or garbling by the model is simply impossible,
// because the model's `firing` entries for these prefixes are ignored
// (see update-alert-state.ts's phantom-key filter).
//
// `ok:false` signals an ambiguous read (not "nothing pending") — the caller
// must not let an unreadable source-of-truth file age or resolve that
// prefix's existing alerts; it must freeze them untouched for the tick.
// ---------------------------------------------------------------------------

export function deriveMicroPendingKeys(stateDir: string): { ok: boolean; items: FiringItem[] } {
  const p = path.join(stateDir, 'state', 'micro-proposals.json');
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err: any) {
    return err?.code === 'ENOENT' ? { ok: true, items: [] } : { ok: false, items: [] };
  }
  let data: Json;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, items: [] };
  }
  const pending = Array.isArray(data?.pending) ? data.pending : [];
  const items: FiringItem[] = [];
  for (const entry of pending) {
    if (!entry || entry.status !== 'pending' || entry.tier !== 1 || typeof entry.id !== 'string') continue;
    let text = `micro-proposal '${entry.id}' awaiting operator input — ${typeof entry.question === 'string' ? entry.question : ''}`;
    if (Array.isArray(entry.options) && entry.options.length > 0) {
      text += ' [' + entry.options.map((o: any, i: number) => `${i + 1}: ${o}`).join(', ') + ']';
    }
    items.push({ key: `micro-proposal-pending:${entry.id}`, text });
  }
  return { ok: true, items };
}

export function deriveProposalPendingKeys(stateDir: string): { ok: boolean; items: FiringItem[] } {
  const dir = path.join(stateDir, 'proposals');
  const listed = listProposalFiles(dir);
  if (!listed.ok) return { ok: false, items: [] };
  const items: FiringItem[] = [];
  for (const f of listed.files) {
    const fm = readFrontmatter(path.join(dir, f));
    if (!fm || fm.status !== 'proposed') continue; // legacy/unreadable/malformed/not-proposed — skip this file only
    const m = f.match(/^(PROP-\d+)/);
    if (!m) continue;
    const id = m[1];
    const title = typeof fm.title === 'string' && fm.title ? fm.title : null;
    // Pre-rendered so the daily digest needs no second frontmatter read: falls
    // back to the bare id on zero/multiple-match (no title found), never blocks.
    items.push({ key: `proposal-pending:${id}`, text: title ? `${id} "${title}"` : id });
  }
  return { ok: true, items };
}
