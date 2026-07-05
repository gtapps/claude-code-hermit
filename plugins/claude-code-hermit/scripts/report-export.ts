#!/usr/bin/env bun
/**
 * Telemetry export — opt-in webhook bundle assembled from on-disk hermit state.
 *
 * Bundle schema is versioned (schema_version: 1) and allowlist-built: only the
 * named fields below are ever copied in, so free text can't leak by accident.
 * `redact_operator_text: false` adds a small named set of free-text fields;
 * everything else stays numerics/enums/counts regardless of config.
 *
 * Called from hermit-watchdog.ts's step 0d (runTelemetryExportIfDue), or
 * directly for manual export / debugging:
 *   bun scripts/report-export.ts [hermit-dir] [--print]
 * --print builds the bundle and writes it to stdout without posting or
 * stamping state — the redaction diff is inspectable this way. A plain
 * invocation forces an export now, ignoring the due-interval gate.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readCostIndex, costIndexPath } from './lib/cost-log';
import { readAlertState, writeAlertState, quarantineAlertState, defaultAlertState } from './lib/alert-state';
import { isPaused } from './lib/pause';
import { readFrontmatter, globDir } from './lib/frontmatter';
import { safe } from './lib/sanitize';
import { todayYMD, thisMonthYYYYMM } from './lib/time';

type Json = any;

const SCHEMA_VERSION = 1;
// Env-overridable so tests can force a fast timeout (mirrors HERMIT_DOCTOR_LIVENESS_TIMEOUT_MS).
const TELEMETRY_TIMEOUT_MS = Number(process.env.HERMIT_TELEMETRY_TIMEOUT_MS) || 5000;
// Once a bundle is failing, don't retry every ~60s tick against a dead endpoint —
// bound the wasted timeout cost while still recovering automatically.
const RETRY_FLOOR_SECS = 900;
const SPOOL_KEEP = 7;
const EVENTS_TAIL_BYTES = 256 * 1024;
const ALERT_KEY = 'telemetry:export-failed';
const ALERT_THRESHOLD = 3;

// --- Small utilities ---

function readJson(p: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(p: string, data: Json): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
}

function ageSecs(ts: string | null | undefined, ref: Date): number | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return (ref.getTime() - d.getTime()) / 1000;
}

function coerceNumOrNull(v: Json, parse: (s: string) => number): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : parse(v);
  return Number.isFinite(n) ? n : null;
}

function numOrNull(v: Json): number | null {
  return coerceNumOrNull(v, parseFloat);
}

function intOrNull(v: Json): number | null {
  return coerceNumOrNull(v, (s) => parseInt(s, 10));
}

// --- Export state (state/telemetry/last-export.json) ---

function exportStatePath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'telemetry', 'last-export.json');
}

function readExportState(hermitDir: string): Json {
  const data = readJson(exportStatePath(hermitDir));
  if (!data || typeof data !== 'object') {
    return { version: 1, last_success_at: null, last_attempt_at: null, consecutive_failures: 0 };
  }
  return data;
}

function writeExportState(hermitDir: string, state: Json): void {
  writeJsonAtomic(exportStatePath(hermitDir), state);
}

// --- Due logic ---

/** True when telemetry_export is enabled, configured, and past its interval (or retry floor). */
function telemetryDue(cfg: Json, hermitDir: string, ref: Date = new Date()): boolean {
  const t = cfg?.telemetry_export;
  if (!t || typeof t !== 'object' || t.enabled !== true) return false;
  const url = t.destination?.url;
  if (typeof url !== 'string' || !url) return false;

  const state = readExportState(hermitDir);
  const intervalSecs = (typeof t.interval_hours === 'number' && t.interval_hours > 0 ? t.interval_hours : 24) * 3600;

  const successAge = ageSecs(state.last_success_at, ref);
  if (successAge !== null && successAge < intervalSecs) return false;

  if ((state.consecutive_failures ?? 0) > 0) {
    const attemptAge = ageSecs(state.last_attempt_at, ref);
    if (attemptAge !== null && attemptAge < RETRY_FLOOR_SECS) return false;
  }
  return true;
}

// --- Watchdog event counts (tail-read; last 256KB is plenty for a 24h window) ---

function countRecentWatchdogEvents(hermitDir: string, ref: Date): { counts: Record<string, number>; recent: Json[] } {
  const p = path.join(hermitDir, 'state', 'watchdog-events.jsonl');
  let text = '';
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - EVENTS_TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    text = buf.toString('utf-8');
  } catch {
    return { counts: {}, recent: [] };
  }

  const counts: Record<string, number> = {};
  const all: Json[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (!e || typeof e.action !== 'string') continue;
      all.push(e);
      const age = ageSecs(e.ts, ref);
      if (age !== null && age <= 24 * 3600) {
        counts[e.action] = (counts[e.action] ?? 0) + 1;
      }
    } catch {
      // A tail-read can start mid-line; a truncated first fragment is expected, not corruption.
    }
  }
  return { counts, recent: all.slice(-10) };
}

// --- Bundle assembly (allowlist-by-construction: only named fields are ever copied in) ---

interface BuildOpts {
  redact?: boolean;
  ref?: Date;
}

function buildBundle(hermitDir: string, config: Json, opts: BuildOpts = {}): Json {
  const ref = opts.ref ?? new Date();
  const redact = opts.redact !== false;
  const timezone = typeof config?.timezone === 'string' && config.timezone ? config.timezone : 'UTC';

  const hermit = {
    agent_name: config?.agent_name != null ? safe(config.agent_name) : null,
    versions: config?._hermit_versions && typeof config._hermit_versions === 'object' ? config._hermit_versions : {},
  };

  let doctor: Json = null;
  const doctorReport = readJson(path.join(hermitDir, 'state', 'doctor-report.json'));
  if (doctorReport && Array.isArray(doctorReport.checks)) {
    doctor = {
      ts: typeof doctorReport.ts === 'string' ? doctorReport.ts : null,
      checks: doctorReport.checks.map((c: Json) => {
        const entry: Json = { id: safe(c?.id), status: safe(c?.status) };
        if (!redact) entry.detail = safe(c?.detail);
        return entry;
      }),
    };
  }

  let cost: Json = null;
  const index = readCostIndex(costIndexPath(hermitDir));
  if (index) {
    const todayKey = todayYMD(timezone, ref);
    const monthKey = thisMonthYYYYMM(timezone, ref);
    const todayBucket = index.by_date?.[todayKey];
    const monthBucket = index.by_month?.[monthKey];
    cost = {
      today: todayBucket ? { cost: todayBucket.cost, tokens: todayBucket.tokens } : null,
      this_month: monthBucket ? { cost: monthBucket.cost, tokens: monthBucket.tokens } : null,
      all_time: {
        total_cost_usd: index.total_cost_usd ?? 0,
        total_tokens: index.total_tokens ?? 0,
        total_sessions: index.total_sessions ?? 0,
      },
      by_source: index.by_source ?? {},
    };
  }

  let alerts: Json = null;
  const alertRead = readAlertState(alertStatePath(hermitDir));
  if (alertRead.kind === 'ok') {
    const entries = Object.entries<Json>(alertRead.value.alerts ?? {});
    alerts = {
      active: entries.filter(([, v]) => v?.suppressed !== true).length,
      suppressed: entries.filter(([, v]) => v?.suppressed === true).length,
      total_ticks: typeof alertRead.value.total_ticks === 'number' ? alertRead.value.total_ticks : null,
    };
    if (!redact) alerts.keys = entries.map(([k]) => safe(k));
  } else if (alertRead.kind === 'missing') {
    alerts = { active: 0, suppressed: 0, total_ticks: 0 };
  }

  let session: Json = null;
  const reportFiles = globDir(path.join(hermitDir, 'sessions'), /^S-\d+-REPORT\.md$/);
  if (reportFiles.length > 0) {
    const fm = readFrontmatter(reportFiles[reportFiles.length - 1]);
    if (fm) {
      const proposalsCreated = Array.isArray(fm.proposals_created) ? fm.proposals_created : [];
      session = {
        id: fm.id ?? null,
        status: fm.status ?? null,
        date: fm.date ?? null,
        duration: fm.duration ?? null,
        cost_usd: numOrNull(fm.cost_usd),
        tokens: intOrNull(fm.tokens),
        escalation: fm.escalation ?? null,
        operator_turns: intOrNull(fm.operator_turns),
        closed_via: fm.closed_via ?? null,
        proposals_created_count: proposalsCreated.length,
      };
      if (!redact) {
        session.task = fm.task != null ? safe(fm.task) : null;
        session.tags = Array.isArray(fm.tags) ? fm.tags.map(safe) : null;
        session.proposals_created = proposalsCreated.map(safe);
      }
    }
  }

  const runtimeData = readJson(path.join(hermitDir, 'state', 'runtime.json'));
  const pauseStatus = isPaused(hermitDir);
  const watchdogState = readJson(path.join(hermitDir, 'state', 'watchdog-state.json'));
  const events = countRecentWatchdogEvents(hermitDir, ref);

  const runtime: Json = {
    session_state: runtimeData?.session_state ?? null,
    runtime_mode: runtimeData?.runtime_mode ?? null,
    paused: pauseStatus.paused,
    paused_until: pauseStatus.until ?? null,
    watchdog: {
      last_run: watchdogState?.last_run ?? null,
      events_last_24h: events.counts,
    },
  };
  if (!redact) {
    runtime.last_error = runtimeData?.last_error != null ? safe(runtimeData.last_error) : null;
    runtime.pause_reason = pauseStatus.reason ?? null;
    runtime.tmux_session = runtimeData?.tmux_session != null ? safe(runtimeData.tmux_session) : null;
    runtime.watchdog.recent_events = events.recent.map((e: Json) => ({
      ts: typeof e.ts === 'string' ? e.ts : null,
      action: safe(e.action),
      reason: safe(e.reason),
    }));
  }

  return {
    schema_version: SCHEMA_VERSION,
    ts: ref.toISOString().slice(0, 19) + 'Z',
    hermit,
    doctor,
    cost,
    alerts,
    session,
    runtime,
  };
}

// --- Transport ---

type PostResult = { ok: true } | { ok: false; classification: string };

/** POST the bundle. Never includes the URL or bearer token in any returned string. */
async function postBundle(url: string, bearerEnv: string | null | undefined, bundle: Json): Promise<PostResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerEnv) {
    const token = process.env[bearerEnv];
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
    });
    if (resp.ok) return { ok: true };
    return { ok: false, classification: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, classification: e?.name === 'TimeoutError' ? 'timeout' : 'network error' };
  }
}

// --- Spool (one file per failed bundle; retains the newest SPOOL_KEEP) ---

function spoolDir(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'telemetry', 'spool');
}

function spoolList(hermitDir: string): string[] {
  try {
    return fs
      .readdirSync(spoolDir(hermitDir))
      .filter((f) => f.startsWith('bundle-') && f.endsWith('.json'))
      .sort()
      .map((f) => path.join(spoolDir(hermitDir), f));
  } catch {
    return [];
  }
}

function spoolPrune(hermitDir: string, keep: number = SPOOL_KEEP): void {
  const files = spoolList(hermitDir);
  const excess = files.length - keep;
  for (const f of files.slice(0, Math.max(0, excess))) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* fail-open */
    }
  }
}

function spoolWrite(hermitDir: string, bundle: Json, ref: Date = new Date()): void {
  const dir = spoolDir(hermitDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Epoch-ms + a random suffix: two failures within the same tick (or even the
    // same millisecond) must not collide and silently overwrite each other. Epoch-ms
    // has a fixed digit count until year 2286, so lexicographic sort stays chronological.
    const suffix = crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(path.join(dir, `bundle-${ref.getTime()}-${suffix}.json`), JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
  } catch {
    /* fail-open */
  }
  spoolPrune(hermitDir);
}

/** Drain oldest-first; stop at the first failure and leave the remainder for next time. */
async function drainSpool(hermitDir: string, url: string, bearerEnv: string | null | undefined): Promise<void> {
  for (const f of spoolList(hermitDir)) {
    const bundle = readJson(f);
    if (!bundle) {
      try {
        fs.unlinkSync(f); // corrupt spool entry — can't retry it, drop and continue
      } catch {
        /* fail-open */
      }
      continue;
    }
    const result = await postBundle(url, bearerEnv, bundle);
    if (!result.ok) break;
    try {
      fs.unlinkSync(f);
    } catch {
      /* fail-open */
    }
  }
}

// --- Alert-state integration (in-process, mirrors cost-tracker.ts's budget alerts) ---

function alertStatePath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'alert-state.json');
}

function raiseExportFailedAlert(hermitDir: string, classification: string, consecutiveFailures: number): void {
  const p = alertStatePath(hermitDir);
  const read = readAlertState(p);
  let state: Json;
  if (read.kind === 'ok') state = read.value;
  else if (read.kind === 'missing') state = defaultAlertState();
  else if (read.kind === 'corrupt') {
    quarantineAlertState(p, Date.now());
    state = defaultAlertState();
  } else return; // ioerror — healthy file, don't touch it

  if (!state.alerts || typeof state.alerts !== 'object') state.alerts = {};
  const existing = state.alerts[ALERT_KEY];
  state.alerts[ALERT_KEY] = {
    first_seen: existing?.first_seen ?? new Date().toISOString(),
    message: `telemetry export failing (${classification}, ${consecutiveFailures} consecutive) — bundles spooled in state/telemetry/spool/`,
    count: consecutiveFailures,
    suppressed: existing?.suppressed ?? false,
  };
  writeAlertState(p, state);
}

function resolveExportFailedAlert(hermitDir: string): void {
  const p = alertStatePath(hermitDir);
  const read = readAlertState(p);
  if (read.kind !== 'ok') return;
  if (!read.value.alerts || !(ALERT_KEY in read.value.alerts)) return;
  delete read.value.alerts[ALERT_KEY];
  writeAlertState(p, read.value);
}

// --- Orchestration ---

interface ExportResult {
  ok: boolean;
  detail: string;
}

/** Build a fresh bundle, POST it, update state/spool/alert, then drain the spool on success. */
async function runTelemetryExport(config: Json, hermitDir: string, ref: Date = new Date()): Promise<ExportResult> {
  const t = config?.telemetry_export ?? {};
  const url = t?.destination?.url;
  const bearerEnv = t?.destination?.bearer_env ?? null;
  const redact = t?.redact_operator_text !== false;

  const state = readExportState(hermitDir);
  const bundle = buildBundle(hermitDir, config, { redact, ref });
  const result = await postBundle(url, bearerEnv, bundle);

  if (result.ok) {
    state.last_success_at = ref.toISOString();
    state.last_attempt_at = ref.toISOString();
    state.consecutive_failures = 0;
    writeExportState(hermitDir, state);
    resolveExportFailedAlert(hermitDir);
    await drainSpool(hermitDir, url, bearerEnv);
    return { ok: true, detail: 'success' };
  }

  state.last_attempt_at = ref.toISOString();
  state.consecutive_failures = (state.consecutive_failures ?? 0) + 1;
  writeExportState(hermitDir, state);
  spoolWrite(hermitDir, bundle, ref);
  if (state.consecutive_failures >= ALERT_THRESHOLD) {
    raiseExportFailedAlert(hermitDir, result.classification, state.consecutive_failures);
  }
  return { ok: false, detail: result.classification };
}

/** Entry point for the watchdog's step 0d — self-gates on telemetryDue, never exits/throws. */
async function runTelemetryExportIfDue(
  config: Json,
  hermitDir: string,
  ref: Date = new Date()
): Promise<{ ran: boolean; ok?: boolean; detail?: string }> {
  try {
    if (!telemetryDue(config, hermitDir, ref)) return { ran: false };
    const result = await runTelemetryExport(config, hermitDir, ref);
    return { ran: true, ok: result.ok, detail: result.detail };
  } catch (e: any) {
    return { ran: true, ok: false, detail: 'internal error' };
  }
}

// --- CLI ---

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const printOnly = argv.includes('--print');
  const hermitDirArg = argv.find((a) => !a.startsWith('--')) ?? '.claude-code-hermit';
  const hermitDir = path.resolve(hermitDirArg);
  const config = readJson(path.join(hermitDir, 'config.json')) ?? {};

  if (printOnly) {
    const redact = config?.telemetry_export?.redact_operator_text !== false;
    console.log(JSON.stringify(buildBundle(hermitDir, config, { redact }), null, 2));
    return;
  }

  const result = await runTelemetryExport(config, hermitDir);
  process.stderr.write(`[report-export] ${result.ok ? 'success' : `failed: ${result.detail}`}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

export {
  buildBundle,
  telemetryDue,
  postBundle,
  readExportState,
  writeExportState,
  spoolWrite,
  spoolList,
  spoolPrune,
  drainSpool,
  runTelemetryExport,
  runTelemetryExportIfDue,
};

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`[report-export] fatal: ${e}\n`);
    process.exitCode = 1;
  });
}
