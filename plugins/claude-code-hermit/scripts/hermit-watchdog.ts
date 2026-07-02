#!/usr/bin/env bun
/**
 * Single-shot watchdog for hermit autonomous sessions.
 *
 * Runs once per scheduler tick (systemd/launchd/cron), decides, acts, exits.
 * Can't hang or leak — the OS scheduler drives recurrence.
 *
 * Decision flow:
 *   1. Config gate    — exit if watchdog.enabled is false
 *   2. Shutdown gate  — exit if operator stopped the session intentionally
 *   3. Dead detection — restart when tmux session is gone
 *   4. Wedge detection — nudge-then-escalate when heartbeat is stale
 *   5. Re-arm fallback — re-arm when heartbeat-restart routine missed its window
 *
 * Usage: bun scripts/hermit-watchdog.ts [run|install|uninstall]
 *        (invoked by .claude-code-hermit/bin/hermit-watchdog run)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, releaseLock } from './lib/lockfile';
import { utcISOStamp as utcStamp, currentHHMM } from './lib/time';
import { writeRuntimeJson, readRuntimeJson, STATE_DIR, LIFECYCLE_LOCK } from './lib/runtime';
import { tmuxSessionAlive, getSessionName as deriveSessionName } from './lib/tmux';
import { costLogPath } from './lib/cc-compat';
import { wallMinutes } from './cron-tz-shift';

type Json = any;

const CONFIG_PATH = '.claude-code-hermit/config.json';
const WATCHDOG_STATE_JSON = path.join(STATE_DIR, 'watchdog-state.json');
const WATCHDOG_EVENTS_JSONL = path.join(STATE_DIR, 'watchdog-events.jsonl');
const HEARTBEAT_FILE = path.join(STATE_DIR, '.heartbeat');
const ROUTINE_METRICS_JSONL = path.join(STATE_DIR, 'routine-metrics.jsonl');
const LAST_OPERATOR_ACTION = path.join(STATE_DIR, 'last-operator-action.json');
const CLEAR_REQUESTED_JSON = path.join(STATE_DIR, 'clear-requested.json');
const COMPACT_REQUESTED_JSON = path.join(STATE_DIR, 'compact-requested.json');

// --- Utilities ---

/** Parse a duration string ('15m', '2h', '26h') to seconds. */
function parseDuration(s: Json): number {
  if (typeof s === 'number') return Math.trunc(s);
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(String(s).trim());
  if (!m) return 0;
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Math.trunc(parseFloat(m[1]) * (mult[m[2] ?? 's'] ?? 1));
}

function readJson(p: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** Atomic write via tmp + rename. */
function writeJson(p: string, data: Json): void {
  const tmp = `${p}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, p);
  } catch (e) {
    process.stderr.write(`[watchdog] write ${path.basename(p)}: ${e}\n`);
  }
}

/** Append one audit line to watchdog-events.jsonl. */
function appendEvent(action: string, reason: string): void {
  const line = JSON.stringify({ ts: utcStamp(), action, reason }) + '\n';
  try {
    fs.appendFileSync(WATCHDOG_EVENTS_JSONL, line);
  } catch (e) {
    process.stderr.write(`[watchdog] append_event: ${e}\n`);
  }
}

/** Seconds elapsed since an ISO-8601 timestamp, or null when unparseable. */
function ageSecs(ts: string): number | null {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 1000;
}

// --- Tmux helpers ---

/** Capture pane content and return its SHA-256 hash, or null on failure. */
function getPaneHash(sessionName: string): string | null {
  try {
    const r = spawnSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return crypto.createHash('sha256').update(r.stdout).digest('hex');
  } catch {
    return null;
  }
}

/** Send text then Enter as two separate calls (avoids bracketed-paste submit bug). */
function sendKeys(sessionName: string, text: string): void {
  spawnSync('tmux', ['send-keys', '-t', sessionName, text], { stdio: 'ignore' });
  Bun.sleepSync(500);
  spawnSync('tmux', ['send-keys', '-t', sessionName, 'Enter'], { stdio: 'ignore' });
}

// --- Lifecycle lock ---

/** Non-blocking exclusive lock. Returns true on success, false when held. */
function tryAcquireLifecycleLock(): boolean {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    return acquireLock(LIFECYCLE_LOCK);
  } catch {
    return false;
  }
}

// --- State readers ---

/** Seconds since last modification, or null if absent. */
function getFileAgeSecs(p: string): number | null {
  try {
    return (Date.now() - fs.statSync(p).mtimeMs) / 1000;
  } catch {
    return null;
  }
}

/** True if the current time in `timezone` is within the active_hours window. Pass `ref` to override the reference instant. */
export function inActiveHours(activeHours: Json, timezone: string, ref?: Date): boolean {
  try {
    const start = String(activeHours.start ?? '00:00');
    const end = String(activeHours.end ?? '23:59');
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return true; // fail-open on malformed window
    const now = currentHHMM(timezone, ref);
    if (now === null) return true; // fail-open on unparseable tz
    return start <= now && now < end; // end-exclusive, matching heartbeat-precheck
  } catch {
    return true; // fail-open
  }
}

/** Seconds since last-operator-action.json was written, or null if absent. */
function getOperatorLastActionAgeSecs(): number | null {
  const data = readJson(LAST_OPERATOR_ACTION);
  if (!data || !data.at) return null;
  return ageSecs(data.at);
}

/**
 * Seconds since the last 'fired' event for routineId in routine-metrics.jsonl.
 * Returns null when the file is absent or no matching event exists.
 */
function getLastRoutineFiredAgeSecs(routineId: string): number | null {
  let lastTs: string | null = null;
  let lines: string[];
  try {
    lines = fs.readFileSync(ROUTINE_METRICS_JSONL, 'utf-8').split('\n');
  } catch {
    return null;
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.routine_id === routineId && e.event === 'fired') lastTs = e.ts;
    } catch {}
  }
  if (!lastTs) return null;
  return ageSecs(lastTs);
}

function checkProcessRunning(pattern: string): boolean {
  return spawnSync('pgrep', ['-f', pattern], { stdio: 'ignore' }).status === 0;
}

/** Parse the minute/hour fields of a simple numeric 5-field cron schedule (e.g. "0 0 * * *"). */
function parseSimpleCronTime(schedule: string): { hour: number; minute: number } | null {
  const parts = String(schedule).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const minute = parseInt(parts[0], 10);
  const hour = parseInt(parts[1], 10);
  if (isNaN(minute) || isNaN(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return { hour, minute };
}

/**
 * True if the `daily-auto-close` routine's next fire is within `windowSecs` of now.
 * The post-close /clear (maybePostCloseClear) already resets context for free right
 * after that routine archives the session — a routine-hygiene compact just before it
 * would spend a summarization call on a context about to be wiped anyway.
 * Pass `ref` to override the reference instant (tests only — mirrors inActiveHours).
 */
export function isNearDailyAutoClose(config: Json, windowSecs: number, ref?: Date): boolean {
  try {
    const routines = Array.isArray(config.routines) ? config.routines : [];
    const routine = routines.find((r: Json) => r && r.id === 'daily-auto-close' && r.enabled !== false);
    if (!routine || typeof routine.schedule !== 'string') return false;
    const fireTime = parseSimpleCronTime(routine.schedule);
    if (!fireTime) return false;

    const nowMinutes = wallMinutes(config.timezone ?? 'UTC', ref ?? new Date());
    if (nowMinutes === null) return false;
    const fireMinutes = fireTime.hour * 60 + fireTime.minute;

    let deltaMinutes = fireMinutes - nowMinutes;
    if (deltaMinutes < 0) deltaMinutes += 24 * 60; // wraps to tomorrow
    return deltaMinutes * 60 <= windowSecs;
  } catch {
    return false; // fail-open — never let a parse error suppress hygiene compaction
  }
}

function readWatchdogState(): Json {
  const data = readJson(WATCHDOG_STATE_JSON);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { consecutive_stale: 0, last_pane_hash: null, last_nudge_at: null };
  }
  return data;
}

function writeWatchdogState(state: Json): void {
  state.last_check_at = utcStamp();
  writeJson(WATCHDOG_STATE_JSON, state);
}

// --- Actions ---

/** Try-acquire lock, mark runtime, kill session, spawn hermit-start. */
function doRestart(sessionName: string, reason: string, runtime: Json): void {
  if (!tryAcquireLifecycleLock()) {
    process.stderr.write('[watchdog] lifecycle lock held — backing off restart\n');
    return;
  }

  try {
    // Mark runtime before killing so session-start recovery sees the reason
    runtime.last_error = 'unclean_shutdown';
    runtime.watchdog_restart_reason = reason;
    writeRuntimeJson(runtime);

    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });

    // Release before spawning hermit-start (it re-acquires)
    releaseLock(LIFECYCLE_LOCK);

    const child = spawn('.claude-code-hermit/bin/hermit-start', [], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => process.stderr.write(`[watchdog] restart failed: ${e}\n`));
    child.unref();
    appendEvent('restart', reason);
    process.stderr.write(`[watchdog] restarted "${sessionName}", reason: ${reason}\n`);
  } catch (e) {
    process.stderr.write(`[watchdog] restart failed: ${e}\n`);
  } finally {
    releaseLock(LIFECYCLE_LOCK); // no-op once already released
  }
}

/** Send a heartbeat run nudge to a potentially wedged session. */
function doNudge(sessionName: string, watchdogState: Json, consecutive: number, paneHash: string | null): void {
  sendKeys(sessionName, '/claude-code-hermit:heartbeat run');
  watchdogState.consecutive_stale = consecutive;
  watchdogState.last_pane_hash = paneHash;
  watchdogState.last_nudge_at = utcStamp();
  writeWatchdogState(watchdogState);
  appendEvent('nudge', `stale cycle ${consecutive}`);
  process.stderr.write(`[watchdog] nudged "${sessionName}" (stale cycle ${consecutive})\n`);
}

/** Re-arm heartbeat when the in-session routine missed its window. */
function doRearm(sessionName: string): void {
  sendKeys(sessionName, '/claude-code-hermit:hermit-routines load');
  Bun.sleepSync(2000);
  sendKeys(sessionName, '/claude-code-hermit:heartbeat start');
  appendEvent('re-arm-fallback', 'heartbeat-restart routine missed ~26h window');
  process.stderr.write(`[watchdog] re-armed "${sessionName}"\n`);
}

// --- Post-close context reset ---

/**
 * Runs before the watchdog.enabled gate — independent of watchdog restart behavior;
 * fires on any hermit with post_close_clear: true and a running scheduler.
 * /clear preserves CronCreate routines and Monitor tasks (process-scoped, not
 * conversation-scoped), so no re-arm is needed after clearing.
 * Takes the lifecycle lock around the send so it can't race a concurrent tick or restart.
 */
function maybePostCloseClear(config: Json): void {
  if (config.post_close_clear !== true) return;
  if (!fs.existsSync(CLEAR_REQUESTED_JSON)) return;

  const runtime = readRuntimeJson();
  if (!runtime) return;
  if (runtime.session_state !== 'idle') return;
  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) return; // never clear a stopping hermit

  const sessionName = runtime.tmux_session ?? '';
  if (!sessionName) return;
  if (!tmuxSessionAlive(sessionName)) return;

  const opAge = getOperatorLastActionAgeSecs();
  if (opAge !== null && opAge < 10 * 60) return; // operator active < 10 min — back off

  if (!tryAcquireLifecycleLock()) return; // another lifecycle action in flight, retry next tick
  try {
    runtime.context_cleared = true;
    writeRuntimeJson(runtime);
    sendKeys(sessionName, '/clear');
    try { fs.rmSync(CLEAR_REQUESTED_JSON); } catch {}
    appendEvent('post-close-clear', 'daily-auto-close context reset');
  } finally {
    releaseLock(LIFECYCLE_LOCK);
  }
  process.exit(0);
}

// --- Shared lifecycle/token guards (maybeContextClear + maybeContextCompact) ---

/**
 * Common lifecycle gates for the two auto-compaction mechanisms: always-on only,
 * no in-flight transition, no watchdog-internal suspect state, no shutdown in
 * progress, a live tmux session, and operator silence ≥10 min. Returns the live
 * session name when every gate passes, or null when the caller should bail.
 */
function passesLifecycleGuards(runtime: Json): string | null {
  if (runtime.runtime_mode === 'interactive') return null; // interactive sessions must never be auto-managed
  if (runtime.transition) return null; // archiving/cleaning recovery is mid-flight — never interfere
  const sessionState: string = runtime.session_state ?? '';
  if (sessionState === 'suspect_process') return null; // exclusion model: only bail on watchdog-internal state

  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) return null;

  const sessionName: string = runtime.tmux_session ?? '';
  if (!sessionName || !tmuxSessionAlive(sessionName)) return null;

  const opAge = getOperatorLastActionAgeSecs();
  if (opAge !== null && opAge < 10 * 60) return null; // operator-recency backoff

  return sessionName;
}

// Shared between maybeContextClear and maybeContextCompact — both need "the last
// cost-log entry for this session" on every tick. Memoized per invocation (this
// script is single-shot, one process per scheduler tick) so the two mechanisms
// don't each re-read and re-parse the full (append-only, unbounded-growth) cost
// log JSONL in the same tick.
let costLogEntryCache: { sessionId: string; entry: Json } | undefined;
function getLastCostLogEntry(sessionId: string): Json {
  if (costLogEntryCache && costLogEntryCache.sessionId === sessionId) return costLogEntryCache.entry;
  let lastEntry: Json = null;
  try {
    const lines = fs.readFileSync(costLogPath(), 'utf-8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e && e.session_id === sessionId) lastEntry = e;
      } catch {}
    }
  } catch {
    lastEntry = null; // cost-log absent — fail safe
  }
  costLogEntryCache = { sessionId, entry: lastEntry };
  return lastEntry;
}

/** Prompt-side token total (input + cache write + cache read) for a cost-log entry. */
function promptTokens(entry: Json): number {
  return (entry.input_tokens ?? 0) + (entry.cache_write_tokens ?? 0) + (entry.cache_read_tokens ?? 0);
}

// --- Context-size clear ---

/**
 * Runs before the watchdog.enabled gate — independent of watchdog restart behavior.
 * Sends /clear when the last hermit-owned turn exceeded a prompt-side token threshold
 * and the session is quiescent (pane unchanged across two consecutive ticks).
 * Guards: always-on only, no in-flight transition, operator silent ≥10 min, no shutdown.
 */
function maybeContextClear(config: Json): void {
  const threshold = config.watchdog?.context_clear_tokens;
  if (typeof threshold !== 'number' || threshold <= 0) return;

  const runtime = readRuntimeJson();
  if (!runtime) return;

  const sessionName = passesLifecycleGuards(runtime);
  if (!sessionName) return;

  // Token check: find the last cost-log entry for this hermit session
  const sessionId: string = runtime.session_id ?? '';
  if (!sessionId) return;

  const lastEntry = getLastCostLogEntry(sessionId);
  if (!lastEntry) return;

  const prompt = promptTokens(lastEntry);
  if (prompt <= threshold) return;

  // Idempotence: bail if this entry was already cleared
  const watchdogState = readWatchdogState();
  if (watchdogState.last_cleared_cost_ts && watchdogState.last_cleared_cost_ts === lastEntry.timestamp) return;

  // Quiescence guard: require pane unchanged across two consecutive ticks
  const currentHash = getPaneHash(sessionName);
  const prevHash = watchdogState.last_pane_hash_ctx ?? null;
  if (currentHash === null || currentHash !== prevHash) {
    // First qualifying tick — record hash and wait for next tick
    watchdogState.last_pane_hash_ctx = currentHash;
    writeWatchdogState(watchdogState);
    return;
  }

  // Pane stable across two ticks — safe to clear
  if (!tryAcquireLifecycleLock()) return;
  try {
    runtime.context_cleared = true;
    writeRuntimeJson(runtime);
    sendKeys(sessionName, '/clear');
    watchdogState.last_cleared_cost_ts = lastEntry.timestamp;
    watchdogState.last_pane_hash_ctx = null; // reset so next bloat cycle re-arms
    writeWatchdogState(watchdogState);
    appendEvent('context-clear', `prompt tokens ${prompt} over threshold ${threshold}`);
  } finally {
    releaseLock(LIFECYCLE_LOCK);
  }
  process.exit(0);
}

// --- Routine-hygiene compaction ---

// Never compact away a context this small, even if a boundary marker waives the
// interval cooldown — summarizing a small context loses fidelity for nothing.
const MIN_COMPACT_FLOOR_TOKENS = 60_000;
// A boundary marker older than this is stale — a boundary is a moment, not a
// standing request. Consumed either way so it never survives into a new arc.
const COMPACT_MARKER_TTL_SECS = 3600;

/**
 * Routine-hygiene compaction — separate mechanism from maybeContextClear (destructive
 * /clear, 700k emergency backstop) and maybePostCloseClear (archived boundary /clear).
 * Fires arc-preserving /compact at a low threshold (default 150k) so cold-cache wakes
 * (heartbeat/routines/channel messages, always ≥5min apart — past the prompt cache TTL)
 * pay a small prompt instead of the full accumulated context. Sends no pointer payload
 * itself — pointers survive via startup-context.ts's SessionStart source==="compact"
 * section (PROP-011 commit 2), which fires on every compaction including this one.
 *
 * Guards mirror maybeContextClear (always-on/transition/shutdown/operator-recency/
 * cost-log token read/two-tick pane quiescence) plus three compact-specific additions:
 * its own min_interval cooldown (waivable by a fresh boundary marker, never by an
 * absolute floor), a midnight-adjacency suppression (skip right before the post-close
 * /clear would wipe the context anyway), and its own quiescence/idempotence state keys
 * so the two mechanisms' trackers don't interfere with each other.
 */
function maybeContextCompact(config: Json): void {
  const compactCfg = config.context_hygiene?.compact;
  if (!compactCfg || compactCfg.enabled !== true) return;

  const threshold = compactCfg.min_context_tokens;
  if (typeof threshold !== 'number' || threshold <= 0) return;

  const minIntervalSecs = parseDuration(compactCfg.min_interval ?? '4h');

  const runtime = readRuntimeJson();
  if (!runtime) return;

  const sessionName = passesLifecycleGuards(runtime);
  if (!sessionName) return;

  // Boundary marker: a fresh marker keeps its interval-cooldown waiver until the
  // compact it enables actually fires (deleted in the success block below). The
  // two-tick quiescence gate lands a full tick after this read, so a fresh marker
  // consumed here would be gone before the pane is confirmed stable — wasting the
  // waiver in exactly the interval-cooldown case it exists for. A stale marker is
  // consumed on read so it can never linger into a later tick/arc.
  let boundaryWaive = false;
  const marker = readJson(COMPACT_REQUESTED_JSON);
  if (marker && typeof marker.requested_at === 'string') {
    const markerAge = ageSecs(marker.requested_at);
    if (markerAge !== null && markerAge <= COMPACT_MARKER_TTL_SECS) {
      boundaryWaive = true; // fresh — leave on disk until the compact fires or it goes stale
    } else {
      try { fs.rmSync(COMPACT_REQUESTED_JSON); } catch {} // stale — never let it linger
    }
  }

  // Midnight-adjacency suppression: the post-close /clear wipes context for free
  // right after daily-auto-close archives — a compact just before it is wasted spend.
  if (isNearDailyAutoClose(config, 2 * 3600)) return;

  // Token check: find the last cost-log entry for this hermit session
  const sessionId: string = runtime.session_id ?? '';
  if (!sessionId) return;

  const lastEntry = getLastCostLogEntry(sessionId);
  if (!lastEntry) return;

  const prompt = promptTokens(lastEntry);

  // Token floor: never compact a small context, even with a boundary marker in play
  if (prompt < MIN_COMPACT_FLOOR_TOKENS) return;
  if (prompt <= threshold) return;

  const watchdogState = readWatchdogState();

  // Quiescence tracking: record the pane hash on every qualifying tick, independent
  // of whether interval/idempotence will end up blocking. If recording were gated
  // behind those checks, a single interval-blocked tick would erase the "pane
  // observed stable" progress and cost an extra tick once the interval reopened
  // (e.g. via a boundary marker) — even though the pane never actually moved.
  // Own hash key (last_pane_hash_compact) so this tracker never collides with
  // maybeContextClear's (last_pane_hash_ctx) — both can be mid-cycle at once.
  const currentHash = getPaneHash(sessionName);
  const prevHash = watchdogState.last_pane_hash_compact ?? null;
  const paneStable = currentHash !== null && currentHash === prevHash;
  if (currentHash !== prevHash) {
    watchdogState.last_pane_hash_compact = currentHash;
    writeWatchdogState(watchdogState);
  }

  // Interval cooldown — waived only by a fresh boundary marker
  if (!boundaryWaive && watchdogState.last_compacted_at) {
    const sinceLast = ageSecs(watchdogState.last_compacted_at);
    if (sinceLast !== null && sinceLast < minIntervalSecs) return;
  }

  // Idempotence: bail if this cost-log entry was already compacted
  if (watchdogState.last_compacted_cost_ts && watchdogState.last_compacted_cost_ts === lastEntry.timestamp) return;

  if (!paneStable) return;

  // Pane stable across two ticks — safe to compact
  if (!tryAcquireLifecycleLock()) return;
  try {
    sendKeys(sessionName, '/compact focus on unfinished work, pending operator items, and in-flight decisions');
    watchdogState.last_compacted_cost_ts = lastEntry.timestamp;
    watchdogState.last_compacted_at = utcStamp();
    watchdogState.last_pane_hash_compact = null; // reset so next bloat cycle re-arms
    writeWatchdogState(watchdogState);
    try { fs.rmSync(COMPACT_REQUESTED_JSON); } catch {} // consume the boundary waiver now that it fired
    // Prompt-token count travels in the event so the next cost-log entry gives a
    // before/after for free — feeds /hermit-evolution and threshold calibration.
    appendEvent('context-compact', `prompt tokens ${prompt} over threshold ${threshold}`);
  } finally {
    releaseLock(LIFECYCLE_LOCK);
  }
  process.exit(0);
}

// --- Main decision loop ---

function main(): void {
  if (!fs.existsSync(CONFIG_PATH)) process.exit(0);

  let config: Json;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    process.exit(0);
  }

  // 0. Liveness stamp — record that the scheduler/loop invoked us, before any gate or
  // pre-gate handler (which can process.exit(0)). A fresh last_run proves the watchdog
  // is firing (systemd/launchd/cron or the Docker entrypoint loop); doctor reads it as
  // the liveness signal. Stamped even when watchdog.enabled is false.
  const liveness = readWatchdogState();
  liveness.last_run = utcStamp();
  writeWatchdogState(liveness);

  // 0a. Post-close clear — independent of watchdog.enabled; runs on any hermit with a scheduler
  maybePostCloseClear(config);

  // 0b. Context-size clear — independent of watchdog.enabled; runs on any always-on hermit
  maybeContextClear(config);

  // 0c. Routine-hygiene compact — independent of watchdog.enabled; runs on any always-on
  // hermit. Evaluated after the emergency clear so a 700k context takes the /clear path,
  // not compact, on the same tick.
  maybeContextCompact(config);

  // 1. Config gate
  const watchdogCfg = config?.watchdog ?? {};
  if (!watchdogCfg || typeof watchdogCfg !== 'object' || Array.isArray(watchdogCfg) || !watchdogCfg.enabled) {
    process.exit(0);
  }

  const staleFactor = watchdogCfg.stale_factor ?? 2;
  const escalateAfter = watchdogCfg.escalate_after ?? 3;
  const operatorGraceSecs = parseDuration(watchdogCfg.operator_grace ?? '15m');

  const runtime = readRuntimeJson();
  if (runtime === null) process.exit(0);

  // 2. Shutdown-intent gate — never resurrect a deliberately-stopped hermit
  if (runtime.session_state === 'idle') process.exit(0);
  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) process.exit(0);
  if (runtime.runtime_mode === 'interactive') process.exit(0);

  const sessionName = runtime.tmux_session ?? '';
  if (!sessionName) process.exit(0);

  const sessionState = runtime.session_state ?? '';

  // 3. Dead-session detection
  if (['in_progress', 'waiting', 'suspect_process'].includes(sessionState)) {
    if (!tmuxSessionAlive(sessionName)) {
      doRestart(sessionName, 'dead-process', runtime);
      process.exit(0);
    }
  }

  // 4. Wedge detection (only when heartbeat is enabled + within active hours)
  const heartbeatCfg = config?.heartbeat ?? {};
  const heartbeatIsObj = heartbeatCfg && typeof heartbeatCfg === 'object' && !Array.isArray(heartbeatCfg);
  if (heartbeatIsObj && ('enabled' in heartbeatCfg ? heartbeatCfg.enabled : true)) {
    const activeHours = heartbeatCfg.active_hours;
    const activeHoursIsObj = activeHours && typeof activeHours === 'object' && !Array.isArray(activeHours);
    if (!activeHoursIsObj || inActiveHours(activeHours, config.timezone ?? 'UTC')) {
      const heartbeatEverySecs = parseDuration(heartbeatCfg.every ?? '2h');
      const staleThresholdSecs = heartbeatEverySecs * staleFactor;

      const heartbeatAge = getFileAgeSecs(HEARTBEAT_FILE);
      if (heartbeatAge !== null) {
        const watchdogState = readWatchdogState();
        const currentPaneHash = getPaneHash(sessionName);

        if (heartbeatAge > staleThresholdSecs) {
          // Operator-recency guard: back off if operator was active recently
          const opAge = getOperatorLastActionAgeSecs();
          if (opAge !== null && opAge < operatorGraceSecs) {
            watchdogState.consecutive_stale = 0;
            watchdogState.last_pane_hash = currentPaneHash;
            writeWatchdogState(watchdogState);
            process.exit(0);
          }

          const monitorDead = !checkProcessRunning('heartbeat-monitor.sh');

          const prevHash = watchdogState.last_pane_hash;
          const paneFrozen =
            currentPaneHash !== null && prevHash != null && currentPaneHash === prevHash;

          const consecutive = (watchdogState.consecutive_stale ?? 0) + 1;

          if (consecutive >= escalateAfter && paneFrozen && monitorDead) {
            // Persist the bumped count so doctor's checkWatchdog reports it
            // accurately even though doRestart doesn't touch watchdog-state.
            watchdogState.consecutive_stale = consecutive;
            watchdogState.last_pane_hash = currentPaneHash;
            writeWatchdogState(watchdogState);
            doRestart(sessionName, 'pane-frozen', runtime);
          } else {
            doNudge(sessionName, watchdogState, consecutive, currentPaneHash);
          }
        } else {
          watchdogState.consecutive_stale = 0;
          watchdogState.last_pane_hash = currentPaneHash;
          writeWatchdogState(watchdogState);
        }
      }
    }
  }

  // 5. Re-arm fallback: fire if heartbeat-restart routine hasn't fired in ~26h
  const rearmThresholdSecs = 26 * 3600;
  const routineAge = getLastRoutineFiredAgeSecs('heartbeat-restart');
  if (routineAge !== null && routineAge > rearmThresholdSecs) {
    const opAge = getOperatorLastActionAgeSecs();
    // Only re-arm when operator is silent (not in the middle of a conversation)
    if (opAge === null || opAge >= operatorGraceSecs) {
      if (tmuxSessionAlive(sessionName)) {
        doRearm(sessionName);
      }
    }
  }
}

// --- Install / uninstall ---

/** Read tmux session name from config for install commands. */
function getSessionName(): string {
  if (!fs.existsSync(CONFIG_PATH)) return 'hermit';
  try {
    return deriveSessionName(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  } catch {
    return 'hermit';
  }
}

/** Locate state-templates/watchdog/ relative to this script's plugin root. */
function findTemplatesDir(): string | null {
  const candidate = path.resolve(import.meta.dir, '..', 'state-templates', 'watchdog');
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {}
  return null;
}

function printCronFallback(root: string): void {
  const cronLine =
    `*/5 * * * * cd ${root} && .claude-code-hermit/bin/hermit-watchdog run ` +
    `2>>.claude-code-hermit/state/watchdog.log`;
  console.log('[watchdog] Add the following line via `crontab -e`:');
  console.log(`  ${cronLine}`);
}

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'inherit' });

/** Platform-dispatching install: systemd (Linux/WSL), launchd (macOS), cron fallback. */
function cmdInstall(): void {
  const root = fs.realpathSync(process.cwd());
  const name = getSessionName();
  const templates = findTemplatesDir();

  const render = (templateText: string) =>
    templateText.replaceAll('{{NAME}}', name).replaceAll('{{ROOT}}', root);

  if (process.platform === 'linux') {
    if (!Bun.which('systemctl')) {
      console.log('[watchdog] systemctl not found — systemd is unavailable on this host.');
      console.log(
        '[watchdog] In the hermit Docker container the entrypoint already runs the ' +
          'watchdog on a ~5 min cycle; no install is needed there.'
      );
      printCronFallback(root);
      return;
    }

    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(systemdDir, { recursive: true });
    const serviceName = `hermit-watchdog@${name}`;

    for (const [tplName, outName] of [
      ['hermit-watchdog@.service', `${serviceName}.service`],
      ['hermit-watchdog@.timer', `${serviceName}.timer`],
    ]) {
      if (templates) {
        const tpl = fs.readFileSync(path.join(templates, tplName), 'utf-8');
        fs.writeFileSync(path.join(systemdDir, outName), render(tpl));
      } else {
        process.stderr.write(`[watchdog] template ${tplName} not found; skipping\n`);
      }
    }

    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', `${serviceName}.timer`]);
    console.log(`[watchdog] Installed systemd user timer: ${serviceName}.timer`);
    console.log('[watchdog] To persist across reboots without a user session: loginctl enable-linger');
  } else if (process.platform === 'darwin') {
    const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgents, { recursive: true });
    const plistName = `com.hermit.watchdog.${name}.plist`;
    const plistPath = path.join(launchAgents, plistName);

    if (templates) {
      const tpl = fs.readFileSync(path.join(templates, 'com.hermit.watchdog.plist'), 'utf-8');
      fs.writeFileSync(plistPath, render(tpl));
    } else {
      process.stderr.write('[watchdog] plist template not found; using inline fallback\n');
      fs.writeFileSync(
        plistPath,
        render(
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
            '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
            '<plist version="1.0"><dict>' +
            '<key>Label</key><string>com.hermit.watchdog.{{NAME}}</string>' +
            '<key>ProgramArguments</key><array>' +
            '<string>{{ROOT}}/.claude-code-hermit/bin/hermit-watchdog</string>' +
            '<string>run</string></array>' +
            '<key>WorkingDirectory</key><string>{{ROOT}}</string>' +
            '<key>StartInterval</key><integer>300</integer>' +
            '<key>RunAtLoad</key><false/>' +
            '</dict></plist>\n'
        )
      );
    }
    run('launchctl', ['load', plistPath]);
    console.log(`[watchdog] Installed LaunchAgent: ${plistName}`);
  } else {
    console.log('[watchdog] systemd and launchd not available on this platform.');
    printCronFallback(root);
  }
}

/** Remove the installed OS timer for this project. */
function cmdUninstall(): void {
  const name = getSessionName();

  if (process.platform === 'linux') {
    if (!Bun.which('systemctl')) {
      console.log('[watchdog] systemctl not found — no systemd timer to remove.');
      console.log('[watchdog] In Docker the watchdog runs via the entrypoint loop, not an OS timer.');
      return;
    }

    const serviceName = `hermit-watchdog@${name}`;
    run('systemctl', ['--user', 'disable', '--now', `${serviceName}.timer`]);
    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    for (const suffix of ['.service', '.timer']) {
      try {
        fs.unlinkSync(path.join(systemdDir, `${serviceName}${suffix}`));
      } catch {}
    }
    run('systemctl', ['--user', 'daemon-reload']);
    console.log(`[watchdog] Removed systemd timer: ${serviceName}.timer`);
  } else if (process.platform === 'darwin') {
    const plistName = `com.hermit.watchdog.${name}.plist`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', plistName);
    if (fs.existsSync(plistPath)) {
      run('launchctl', ['unload', plistPath]);
      fs.unlinkSync(plistPath);
    }
    console.log(`[watchdog] Removed LaunchAgent: ${plistName}`);
  } else {
    console.log('[watchdog] Cron entries must be removed manually with `crontab -e`.');
  }
}

if (import.meta.main) {
  const subcommand = process.argv[2] ?? 'run';
  if (subcommand === 'run' || subcommand === '') {
    try {
      main();
    } catch (e) {
      process.stderr.write(`[watchdog] fatal: ${e}\n`);
      process.exit(0); // fail-open: watchdog must never crash the calling shell
    }
  } else if (subcommand === 'install') {
    cmdInstall();
  } else if (subcommand === 'uninstall') {
    cmdUninstall();
  } else {
    process.stderr.write(`[watchdog] unknown subcommand: ${subcommand}\n`);
    process.exit(1);
  }
}
