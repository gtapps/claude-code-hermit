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
 *   3b. Stall-question detection — notify once when the pane is stuck on an
 *       un-redirectable dialog (native permission prompt, harness prompt)
 *   4. Wedge detection — nudge-then-escalate when heartbeat is stale
 *   5. Monitor re-arm  — re-arm a heartbeat/routine Monitor whose liveness file
 *                        went stale mid-session (any cause), damped per monitor
 *
 * Step 0e (state backup) sits with the 0a-0d family above the config gate: it is
 * model-free maintenance that must keep running on a hermit that never enabled
 * watchdog recovery. At-most-once, like the routine scheduler (lib/routines/due.ts
 * "persist before emit"): the cursor is consumed here, before the detached child
 * starts, so a failed spawn costs that window rather than risking a double run.
 * The doctor's `backup` check is the recovery path — it warns once two scheduled
 * windows pass without a success.
 *
 * Usage: bun scripts/hermit-watchdog.ts [run|install|uninstall]
 *        (invoked by .claude-code-hermit/bin/hermit-watchdog run)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, releaseLock, pidAlive } from './lib/lockfile';
import { utcISOStamp as utcStamp, currentHHMM, currentHHMMOrUTC, parseSimpleCronTime, friendlyBoundary } from './lib/time';
import { writeRuntimeJson, readRuntimeJson, STATE_DIR, LIFECYCLE_LOCK } from './lib/runtime';
import { anchoredPaneTail, nonBlankTail, tmuxSessionAlive, getSessionName as deriveSessionName, sendKeys } from './lib/tmux';
import { paneRootPids, collectTree, terminateSurvivors } from './lib/proc';
import { sharedLivenessAgeSecs, LIVENESS_FRESH_SECS } from './lib/liveness';
import { postToSession } from './lib/peer-post';
import { findResident, type SessionEntry } from './lib/session-registry';
import { costLogPath, transcriptDirFor } from './lib/cc-compat';
import { readSettledConfig, readConfigRaw } from './lib/config-read';
import { wallMinutes } from './lib/cron-shift';
import { evaluateBackupDue } from './lib/backup';
import { isPaused, pauseReasonLabel } from './lib/pause';
import { WATCHDOG, resolveLocale, type Locale } from './lib/messages';
import { credentialsFilePath, defaultConfigDir, envAuthPresent, inspectStoredLogin, msUntilExpiry, msUntilLoginExpiry, resolveAuthMode, storedLoginUsable } from './lib/setup-token';
import { isContainer } from './lib/container';
import { writeFileAtomic } from './lib/md-write';
import { AUTO_CLOSE_LULL_MS } from './lib/auto-close';
import { promptTokensOf as promptTokens, isEstimateOnly, compactibleTokens, MAX_PLAUSIBLE_PROMPT_TOKENS, isOwnTurn } from './lib/context-signal';
import { readContextSurface } from './lib/context-surface';
import { runTelemetryExportIfDue } from './report-export';
import { applyContextReset, stampContextReset, clearStatusCache as clearStatusCacheAt } from './lib/context-reset';
import { ensureLedgerFile } from './lib/append-jsonl';
import { bootMismatch, heartbeatPredatesGraceSecs, monitorFreshness } from './lib/monitor-health';
import { readBootId } from './lib/routines/registry';

type Json = any;

const CONFIG_PATH = '.claude-code-hermit/config.json';
const HEARTBEAT_FILE = path.join(STATE_DIR, '.heartbeat');
const CLEAR_REQUESTED_JSON = path.join(STATE_DIR, 'clear-requested.json');
// Paths the decision cascade reaches through World.paths (watchdog-state.json,
// watchdog-events.jsonl, last-operator-action.json, compact-requested.json) are
// joined at their use sites off world.paths.stateDir, not pinned here.
const HERMIT_ROOT = path.dirname(STATE_DIR); // '.claude-code-hermit' — isPaused() joins its own 'state/pause.json'
const REAUTH_MARKER_JSON = path.join(STATE_DIR, 'reauth-relay.json');
/** A signed-in credential staged by the mint, waiting for this watchdog to commit it. */
const PENDING_CREDENTIAL_JSON = path.join(STATE_DIR, 'pending-credential.json');
/**
 * How long a staged sign-in stays committable. Every front door requests a restart
 * within seconds of staging, so anything older is a staging whose restart never
 * happened — and it has to expire rather than linger: while it exists the mint
 * refuses to start a second sign-in, so a permanent one would lock the operator out
 * of the very renewal path this feature exists to provide.
 */
const PENDING_CREDENTIAL_MAX_AGE_MS = 2 * 3600000;
/** Written by the relay when its own send failed. Honoured for a day, then retried. */
const RELAY_UNREACHABLE_JSON = path.join(STATE_DIR, 'relay-unreachable.json');
const RELAY_UNREACHABLE_MAX_AGE_MS = 24 * 3600000;
const REAUTH_MINT_SCRIPT = path.join(import.meta.dir, 'setup-token-mint.ts');
const SETTINGS_EDIT_SCRIPT = path.join(import.meta.dir, 'settings-edit.ts');
// Overridable so a test can point step 0e at a missing path and prove the tick survives.
const BACKUP_SCRIPT = process.env.HERMIT_BACKUP_SCRIPT || path.join(import.meta.dir, 'backup.ts');
// Backstop against PID reuse on a long-lived box; liveness is the real signal.
const REAUTH_MARKER_MAX_AGE_MS = 26 * 3600000;
// Skill-driven mints have no usable PID (verb per process), so age is the only
// signal — sized to the flow's own timeouts rather than the relay's ack wait.
const REAUTH_SKILL_MARKER_MAX_AGE_MS = 2 * 3600000;

// --- Injectable world ---

/**
 * The decision cascade's view of everything outside itself: the clock, the tmux
 * pane, the filesystem, and where state lives. Gates take a World instead of
 * reaching for module-level constants and spawnSync directly, so a test can hand
 * them a fake and assert which gate decided what — rather than inferring it from
 * side effects observed through a subprocess with fake executables on PATH.
 *
 * Two implementations only: REAL_WORLD below (production, delegating to the same
 * lib functions the file already used) and whatever a test constructs.
 */
export type World = {
  clock: { nowMs(): number };
  tmux: { alive(s: string): boolean; capture(s: string): string | null; send(s: string, text: string): void };
  files: { readJson(p: string): Json | null; readText(p: string): string | null; writeJson(p: string, v: Json): void; rm(p: string): void };
  paths: { stateDir: string; hermitRoot: string; costLog: string };
  /** Per-tick memo for the cost-log read, shared by both hygiene tiers (one
   *  process per scheduler tick, so its lifetime is the tick). Lives on the world
   *  rather than in module scope so each fake world in a test starts cold. */
  memo: { costLogEntry?: { sessionId: string; entry: Json }; hygieneSessionId?: string };
};

const REAL_WORLD: World = {
  clock: { nowMs: () => Date.now() },
  tmux: {
    alive: (s) => tmuxSessionAlive(s),
    capture: (s) => capturePane(s),
    send: (s, text) => { sendKeys(s, text); },
  },
  files: {
    readJson,
    readText: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
    writeJson,
    rm: (p) => { try { fs.rmSync(p); } catch {} },
  },
  paths: { stateDir: STATE_DIR, hermitRoot: HERMIT_ROOT, costLog: costLogPath() },
  memo: {},
};

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
function appendEvent(action: string, reason: string, world: World = REAL_WORLD): void {
  const line = JSON.stringify({ ts: worldStamp(world), action, reason }) + '\n';
  try {
    const eventsPath = path.join(world.paths.stateDir, 'watchdog-events.jsonl');
    ensureLedgerFile(eventsPath);
    fs.appendFileSync(eventsPath, line);
  } catch (e) {
    process.stderr.write(`[watchdog] append_event: ${e}\n`);
  }
}

// --- Deterministic operator pushes (channel voice) ---
//
// The watchdog is out-of-process and single-shot, so a direct import of the
// async lib/channel-send.ts would require converting this whole file's
// control flow (including several interleaved process.exit(0) calls) to
// async. Instead it reaches the send through the channel-send.ts CLI via
// spawnSync — one more external effect alongside the tmux/pgrep/systemctl
// calls this file already shells out to, and spawnSync blocks until the
// child exits so a slow send can never race a process.exit that would kill
// it mid-flight.
const CHANNEL_SEND_SCRIPT = path.join(import.meta.dir, 'channel-send.ts');

// The operator's locale for all watchdog pushes. Resolved once from config in
// main() before any compose call fires; the compose functions default to this
// value at call time (tests override it by passing an explicit locale arg). The
// watchdog is single-shot, so a module-level holder IS "pinned at run start".
let OPERATOR_LOCALE: Locale = 'en';

/** Best-effort operator push. Watchdog lifecycle events are ops content, so they
 * route maintainer-tier — falling back to the primary chat when no maintainer
 * channel is configured (byte-identical to today). Failure is logged, never
 * blocks the watchdog's real work. */
function pushOperatorMessage(text: string): void {
  try {
    const r = spawnSync(process.execPath, [CHANNEL_SEND_SCRIPT, HERMIT_ROOT, '--tier', 'maintainer', '-'], {
      input: text,
      timeout: 12000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    if (r.status !== 0) appendEvent('push_failed', text.slice(0, 80));
  } catch (e) {
    appendEvent('push_failed', String(e).slice(0, 80));
  }
}

/** Current time as "HH:MM" in `timezone`, falling back to the UTC clock if the zone is invalid. */
function nowHHMM(timezone: string, ref?: Date): string {
  return currentHHMMOrUTC(timezone, ref);
}

/** Operator-language message for a watchdog restart. */
export function composeRestartMessage(reason: string, timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  const hhmm = nowHHMM(timezone);
  const cause = reason === 'dead-process'
    ? WATCHDOG[locale].restartCauseNotRunning()
    : WATCHDOG[locale].restartCauseFrozen();
  return WATCHDOG[locale].restart(hhmm, cause);
}

/** Operator-language message for a wedge episode: waking on the first notice, unresponsive after a failed wake. */
export function composeWedgeMessage(timezone: string, locale: Locale = OPERATOR_LOCALE, escalated = false): string {
  const hhmm = nowHHMM(timezone);
  return escalated ? WATCHDOG[locale].wedge(hhmm) : WATCHDOG[locale].wedgeWaking(hhmm);
}

/** Operator-language all-clear after a wedge episode that reached the notice stage. */
export function composeWedgeRecoveredMessage(timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  return WATCHDOG[locale].wedgeRecovered(nowHHMM(timezone));
}

/** Operator-language message for an un-redirectable stalled question (PROP-024's fail-loud half). */
export function composeStallQuestionMessage(timezone: string, locale: Locale = OPERATOR_LOCALE, paneTail?: string): string {
  const sentence = WATCHDOG[locale].stallQuestion(nowHHMM(timezone));
  if (!paneTail) return sentence;
  return `${sentence}\n\n${paneTail}`;
}

/** Operator-language message for a session that stopped consuming its queued notifications. */
export function composeSessionWedgedMessage(timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  return WATCHDOG[locale].sessionWedged(nowHHMM(timezone));
}

/** Operator-language message for a likely orphan (tmux gone, state still fresh). */
export function composeOrphanMessage(timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  return WATCHDOG[locale].orphan(nowHHMM(timezone));
}

/** Operator-language message for an upstream API failure — see ApiFailureVerdict. */
export function composeApiFailureMessage(
  verdict: ApiFailureVerdict, timezone: string, locale: Locale = OPERATOR_LOCALE,
): string {
  if (verdict.kind === 'api-unavailable') return WATCHDOG[locale].apiUnavailable(nowHHMM(timezone));
  return verdict.resetAt
    ? WATCHDOG[locale].usageLimit(nowHHMM(timezone), verdict.resetAt)
    : WATCHDOG[locale].usageLimitNoReset(nowHHMM(timezone));
}

/**
 * Operator-language message for a login nobody can renew from chat. Unlike every other
 * message here it has to name a command, because there is no chat-side fix: the sign-in
 * happens on the machine the hermit runs on. `orphan` above sets the precedent.
 */
export function composeLapsedLoginMessage(
  timezone: string,
  inDocker: boolean = isContainer(),
  locale: Locale = OPERATOR_LOCALE,
): string {
  const fix = inDocker
    ? WATCHDOG[locale].lapsedLoginFixDocker()
    : WATCHDOG[locale].lapsedLoginFixHost();
  return WATCHDOG[locale].lapsedLogin(nowHHMM(timezone), fix);
}

/** The auth-failure notice for a hermit whose credential comes from its environment.
 *  Deliberately says nothing about signing in: an API key, bearer token, or cloud
 *  provider is not a login the hermit can re-mint, and the relay has nothing to offer. */
export function composeEnvAuthFailureMessage(
  timezone: string,
  locale: Locale = OPERATOR_LOCALE,
): string {
  return WATCHDOG[locale].envAuthFailure(nowHHMM(timezone));
}

export type CompactFlavor = 'boundary' | 'mid-arc';

/**
 * Which steering flavor a compact fires with. Sole owner of the predicate — the fire
 * site logs this same value to the event log, so message and forensics label can never
 * disagree.
 *
 * Both conditions are required, because neither alone bounds the claim the boundary
 * message makes ("the previous work arc is complete and archived"):
 *   - `session_state === 'idle'` is unbounded in time. Only `/session-start` writes
 *     `in_progress` (session-archive.ts verbOpen) — routines, heartbeats, and channel
 *     replies never flip it — so an always-on hermit sits at 'idle' for hours while
 *     still doing real, unarchived work.
 *   - A fresh `compact-requested.json` marks a genuine work-done boundary, but only
 *     bounds it to COMPACT_MARKER_TTL_SECS; on its own it can't tell that a new
 *     session opened inside that window.
 * Together they confine the boundary flavor to the ≤1h window after a work-done
 * archive with no session open — the only window where the claim is true. Everything
 * else falls to 'mid-arc', the conservative keep-everything flavor.
 */
function compactFlavor(sessionState: unknown, markerFresh: boolean): CompactFlavor {
  return sessionState === 'idle' && markerFresh ? 'boundary' : 'mid-arc';
}

/**
 * Steering text for the watchdog-fired `/compact`. Never operator-facing (it's typed
 * into the pane for Claude, not shown in a channel), so no locale — unlike the
 * compose*Message functions above.
 */
export function composeCompactSteeringMessage(flavor: CompactFlavor): string {
  return flavor === 'boundary'
    ? '/compact the previous work arc is complete and archived, summarize it in one or two lines, keep pending operator items, open questions, and standing commitments, drop completed-work detail'
    : '/compact focus on unfinished work, pending operator items, and in-flight decisions';
}

/** Operator-language message for a forced pause enforcement (any reason). */
export function composePauseMessage(reason: string, until: string | null, timezone: string, locale: Locale = OPERATOR_LOCALE): string {
  const label = pauseReasonLabel(reason, locale);
  // Fall back to the indefinite phrasing when `until` is absent or unparseable —
  // a malformed timestamp shouldn't leak a raw ISO string to the operator. Dated
  // form (not bare HH:MM) so a resume days/weeks out isn't read as minutes away.
  const valid = until != null && !isNaN(new Date(until).getTime());
  if (!valid) return WATCHDOG[locale].pauseUntilResume(label);
  return WATCHDOG[locale].pauseUntilDate(label, friendlyBoundary(until as string, timezone));
}

/** Seconds elapsed since an ISO-8601 timestamp, or null when unparseable. */
function ageSecs(ts: string, world: World = REAL_WORLD): number | null {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return (world.clock.nowMs() - d.getTime()) / 1000;
}

/** utcStamp read off the world clock, so a fake clock produces a fixed stamp. */
function worldStamp(world: World): string {
  return utcStamp(new Date(world.clock.nowMs()));
}

// --- Tmux helpers ---

/** Capture pane content as text, or null on failure. */
function capturePane(sessionName: string): string | null {
  try {
    const r = spawnSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/** SHA-256 hash of the current pane content, or null on failure. */
function getPaneHash(sessionName: string, world: World = REAL_WORLD): string | null {
  const content = world.tmux.capture(sessionName);
  return content === null ? null : crypto.createHash('sha256').update(content).digest('hex');
}

// A blocking modal (AskUserQuestion widget, a native permission prompt, or a
// harness-shipped setup wizard) renders a pointer-marked option plus a dialog footer
// — verified against real captures in compiled/spike-ask-gate-probe-2026-07-05.md and
// against the CC 2.1.233 "Set up auto mode for your environment?" wizard that wedged a
// live hermit for ~2.5 days. Neither token appears in ordinary session output (tool
// calls, prose, status bar), so requiring both is a conservative, low-false-positive
// signal that the pane is stalled on an unanswerable dialog. Over-detection costs one
// deduped push; under-detection is a silent stall.
//
// The option label is deliberately NOT constrained to a number: the wizard's selector
// reads "❯ Continue", and requiring `\d+\.` is exactly why the live wedge went
// undetected. The pointer glyph also starts the composer prompt ("❯ Try ..."). A
// modal replaces the composer on a clean pane, but a queued channel message keeps
// the composer rendered below it (probed CC 2.1.260), so the footer anchor misses
// that case; the registry leg covers it.
const PENDING_OPTION_RE = /❯\s+\S/;
// A dialog footer must terminate the visible pane. All three spellings are
// load-bearing: AskUserQuestion and permission prompts end "· Esc to cancel", a
// wizard step that cannot be cancelled offers only "Enter to continue", and the
// held-peer-message dialog (CC 2.1.257, captured live) ends on its own last option
// with no footer line at all — so that option's text is the anchor.
const PENDING_FOOTERS = ['Esc to cancel', 'Enter to continue', 'Deliver this message to Claude'];

// Only the pane TAIL counts: a live blocking modal renders at the bottom of the
// pane, whereas the same tokens appearing in scrollback or quoted tool output
// (a rendered menu, or output that echoes "Esc to cancel") sit higher up. Scanning
// the whole capture would let such incidental text trip a false stall — and because
// stall detection early-returns before wedge/restart, a false positive silently
// *disables recovery* for as long as the text stays on screen. The tail window
// keeps the genuine bottom-of-pane prompt while dropping that class.
const PENDING_TAIL_LINES = 15;

/** True when the pane TAIL looks stalled on an interactive dialog nobody can answer. */
export function hasPendingQuestion(paneContent: string): boolean {
  return PENDING_FOOTERS.some((footer) => {
    const tail = anchoredPaneTail(paneContent, PENDING_TAIL_LINES, footer);
    return tail !== null && PENDING_OPTION_RE.test(tail);
  });
}

// An auth failure renders as an ordinary assistant response, not a modal, so it has
// no terminal anchor and anchoredPaneTail() cannot find it — a plain tail scan is the
// whole mechanism. Captured live (CC 2.1.251, tmux capture-pane, the instrument this
// file already uses): an expired /login credential answers "Login expired · Please run
// /login", and a dead setup-token answers "Please run /login · API Error: 401 OAuth
// access token is invalid." Those two are the only probe-verified spellings, and
// `Please run /login` alone covers both.
//
// The rest are unverified spellings kept as insurance against a wording change, which
// is only affordable because each one is long and specific enough that ordinary pane
// text does not contain it by accident. That distinction is load-bearing rather than
// stylistic: a match SUPPRESSES the nudge and restart tiers, so a false positive
// disarms the watchdog on its own core job. A bare "Login expired" is exactly the
// phrase a session discussing its own auth handling echoes, so it is deliberately
// absent — the captured pane carrying it also carries "Please run /login".
const LAPSED_LOGIN_PATTERNS = [
  'Please run /login',
  'OAuth access token is invalid',
  '401 Invalid authentication credentials',
  'OAuth token refresh failed',
  'OAuth token revoked',
  'OAuth token has expired',
  'Claude.ai login expired',
];

/** True when the pane TAIL shows Claude Code refusing to work until someone signs in. */
export function hasLapsedLogin(paneContent: string): boolean {
  const tail = nonBlankTail(paneContent, PENDING_TAIL_LINES);
  return LAPSED_LOGIN_PATTERNS.some((p) => tail.includes(p));
}

// A wedged session is shape-independent: whatever holds stdin (a dialog the pane
// scanner above doesn't recognise, a modal from a future CC release, a hung render),
// the harness keeps ENQUEUEING monitor notifications it never DEQUEUES. On the live
// 2026-08-17 incident that signal ran for ~2.5 days — 16 straight enqueues, zero
// dequeues — while every pane-shaped check stayed silent. Reading only the tail of
// the transcript keeps this cheap; transcripts reach megabytes.
const WEDGE_QUEUE_STALE_SECS = 30 * 60;
const QUEUE_TAIL_BYTES = 64 * 1024;

/**
 * Verdict on the newest queue-operation in a transcript tail.
 * 'wedged' — the last queue record is an enqueue older than the threshold.
 * 'draining' — the last queue record is a dequeue/remove, or an enqueue still inside
 *   the threshold. Only queue records are read: measured enqueue→drain gaps top out
 *   around 5 minutes, so the 30-minute threshold already absorbs a long turn.
 * 'unknown' — no queue records at all (fail-open: a fresh or quiet session).
 */
export function classifyQueueTail(tailText: string, nowMs: number, staleSecs = WEDGE_QUEUE_STALE_SECS): 'wedged' | 'draining' | 'unknown' {
  let last: { op: string; ts: number } | null = null;
  for (const line of tailText.split('\n')) {
    if (!line.includes('"queue-operation"')) continue;
    let rec: Json;
    try { rec = JSON.parse(line); } catch { continue; } // a truncated first line is expected
    if (rec?.type !== 'queue-operation' || typeof rec.operation !== 'string') continue;
    const ts = Date.parse(String(rec.timestamp ?? ''));
    if (Number.isNaN(ts)) continue;
    if (last === null || ts >= last.ts) last = { op: rec.operation, ts };
  }
  if (last === null) return 'unknown';
  if (last.op !== 'enqueue') return 'draining';
  return nowMs - last.ts > staleSecs * 1000 ? 'wedged' : 'draining';
}

// A harness-side API failure (usage limit, 529/500 overload, mid-response server
// error) renders as an ordinary assistant response, exactly like the lapsed-login
// case above — no modal, no terminal anchor. But unlike a pane scan, CC records
// these structurally in the transcript: the failing turn's assistant record carries
// `isApiErrorMessage: true` and `message.model: "<synthetic>"`. Verified against 48
// real records across live sessions: 48/48 carry both fields, and prose that merely
// quotes an error string (a docstring, a test fixture, this very file's comments)
// lands in a normal assistant record with a real model id, so it cannot match. That
// immunity is why this reads the structural flag instead of pane text.
//
// Auth failures (`Login expired`, `401 Invalid API key`) are deliberately excluded:
// `hasLapsedLogin`/`envAuthFailure` above already notify for those, and matching them
// here too would double-notify the operator for one event.
// CC composes the limit line as `You've hit your ${label}…`, where the label is one
// of a fixed set — `session limit`, `weekly limit`, `Opus limit`, `Sonnet limit`,
// `Fable limit`, `individual usage limit`, `individual spend limit`, `usage credit
// limit`, `monthly spend limit` — so matching one label would leave the multi-day
// weekly lockout silent, which is the case an operator most needs told. Match the
// frame instead of the label. `reached` covers the second phrasing CC uses for a
// per-model limit. Loose text matching is safe inside the structural gate above:
// only a harness-emitted failure record ever reaches it.
const USAGE_LIMIT_RE = /\b(?:hit|reached) your [^\n]{0,40}\blimit\b/i;
// Bounded on purpose: CC appends a subline to the same line (`, or switch models to
// keep working.`, ` try /model sonnet for more runway`), and an unbounded capture
// would paste that whole tail into "It will resume on its own at …".
const USAGE_LIMIT_RESET_RE = /resets\s+([^\n(·,.]{1,30})/i;
const API_UNAVAILABLE_RE = /API Error:.*(529 Overloaded|500 Internal server error|Server error mid-response)/i;

export type ApiFailureVerdict = { kind: 'usage-limit'; resetAt: string | null } | { kind: 'api-unavailable' };

/** Newest assistant record in a transcript tail, with its parsed timestamp, or null
 *  when the tail carries none. Mirrors classifyQueueTail's tolerant JSONL scan — a
 *  truncated first line from the byte-bounded tail read is expected. */
function newestAssistantRecord(tailText: string): { rec: Json; ts: number } | null {
  let newest: { rec: Json; ts: number } | null = null;
  for (const line of tailText.split('\n')) {
    if (!line.includes('"role":"assistant"')) continue;
    let rec: Json;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type !== 'assistant' || rec.message?.role !== 'assistant') continue;
    const ts = Date.parse(String(rec.timestamp ?? ''));
    if (Number.isNaN(ts)) continue;
    if (newest === null || ts >= newest.ts) newest = { rec, ts };
  }
  return newest;
}

/** Usage-limit verdict for a rendered failure message, or null when it carries no limit
 *  line. The line and its reset clause read the same whichever source supplied the text,
 *  a synthetic transcript record or the StopFailure stamp's last assistant message. */
function matchUsageLimit(text: string): ApiFailureVerdict | null {
  if (!USAGE_LIMIT_RE.test(text)) return null;
  const reset = text.match(USAGE_LIMIT_RESET_RE);
  return { kind: 'usage-limit', resetAt: reset?.[1]?.trim() || null };
}

/** Verdict on one assistant record, or null when it isn't a recognised upstream API
 *  failure. Separate from classifyApiFailureTail so the 3d tier, which already holds
 *  the newest record, does not rescan the tail to reach it. */
function verdictFromAssistantRecord(rec: Json): ApiFailureVerdict | null {
  if (rec.isApiErrorMessage !== true || rec.message?.model !== '<synthetic>') return null;

  const content = rec.message?.content;
  const text = Array.isArray(content) && content[0]?.type === 'text' ? String(content[0].text ?? '') : '';

  const usageLimit = matchUsageLimit(text);
  if (usageLimit) return usageLimit;
  if (API_UNAVAILABLE_RE.test(text)) return { kind: 'api-unavailable' };
  return null; // auth failure or an unrecognised synthetic record — not this tier's job
}

/** Verdict on the newest assistant record in a transcript tail, or null when it isn't
 *  a recognised upstream API failure (including: no failure, an auth failure, or a
 *  healthy record newer than any failure). */
export function classifyApiFailureTail(tailText: string): ApiFailureVerdict | null {
  const newest = newestAssistantRecord(tailText);
  return newest === null ? null : verdictFromAssistantRecord(newest.rec);
}

/** Verdict on a `state/stop-failure.json` stamp (stop-failure-stamp.ts's record of a
 *  StopFailure payload), or null when its category isn't this tier's — an auth failure,
 *  a model error, or no `error` at all.
 *
 *  The typed category replaces the structural gate the transcript path needs: only CC
 *  fires StopFailure, so there is no quoted-text case to defend against here. The live
 *  payload key is `error` (probed on CC 2.1.261); the docs spell it `error_type`, and a
 *  payload carrying only that classifies as null — the transcript tail stays the
 *  fallback, so an upstream rename degrades to today's behavior rather than to silence.
 *  `rate_limit` covers both a usage lockout and upstream throttling, so it is the one
 *  category still split on text. */
export function classifyStopFailureStamp(stamp: Json): ApiFailureVerdict | null {
  const error = stamp?.error;
  if (error === 'rate_limit') {
    const text = typeof stamp.last_assistant_message === 'string' ? stamp.last_assistant_message : '';
    return matchUsageLimit(text) ?? { kind: 'api-unavailable' };
  }
  if (error === 'overloaded' || error === 'server_error') return { kind: 'api-unavailable' };
  return null;
}

/** Tail of the active session's transcript, or null when it can't be located/read.
 *  Takes the CC transcript UUID (runtime.json's `opened_transcript`, maintained by
 *  cost-tracker.ts:maintainOpenedAt) — NOT `session_id`, which is the logical S-NNN
 *  arc id and never names a transcript file. It is passed in from the runtime.json
 *  main() already read this tick, so this doesn't re-read the same file every tick. */
function readTranscriptTail(transcriptId: string | null, world: World = REAL_WORLD): string | null {
  if (!transcriptId) return null; // no transcript recorded yet — nothing to judge
  // hermitRoot is repo-relative ('.claude-code-hermit'), and CC keys transcript dirs by
  // ABSOLUTE project path — resolve against cwd rather than path.dirname (which yields '.').
  const projectRoot = path.resolve(world.paths.hermitRoot, '..');
  const file = path.join(transcriptDirFor(projectRoot), `${transcriptId}.jsonl`);
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const start = Math.max(0, size - QUEUE_TAIL_BYTES);
      const len = size - start;
      const buf = Buffer.alloc(len);
      // readSync may return a short read; slice to what was actually read so a
      // zero-filled remainder can't inject NUL bytes into the newest lines — the
      // same guard report-export.ts's bounded tail read carries.
      const bytesRead = fs.readSync(fd, buf, 0, len, start);
      return buf.subarray(0, bytesRead).toString('utf-8');
    } finally { fs.closeSync(fd); }
  } catch {
    return null; // absent/unreadable transcript is not evidence of a wedge
  }
}

// sendKeys now lives in lib/tmux.ts so the harness-command drain shares one
// implementation (and one bracketed-paste workaround) with the watchdog.

// --- Lifecycle lock ---

/** The lifecycle lock file under the world's state dir. Must resolve to the same
 *  path as lib/runtime's LIFECYCLE_LOCK for the real world — the restart, nudge and
 *  post-close-clear paths still lock via that constant, and the two only exclude
 *  each other while both name the same file. */
function lifecycleLockPath(world: World): string {
  return path.join(world.paths.stateDir, '.lifecycle.lock');
}

/** Non-blocking exclusive lock. Returns true on success, false when held. */
function tryAcquireLifecycleLock(world: World = REAL_WORLD): boolean {
  try {
    fs.mkdirSync(world.paths.stateDir, { recursive: true });
    return acquireLock(lifecycleLockPath(world));
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
    return start <= now && now < end; // end-exclusive, matching heartbeat.ts precheck
  } catch {
    return true; // fail-open
  }
}

/** Seconds since last-operator-action.json was written, or null if absent. */
function getOperatorLastActionAgeSecs(world: World = REAL_WORLD): number | null {
  const data = world.files.readJson(path.join(world.paths.stateDir, 'last-operator-action.json'));
  if (!data || !data.at) return null;
  return ageSecs(data.at, world);
}

function checkProcessRunning(pattern: string): boolean {
  return spawnSync('pgrep', ['-f', pattern], { stdio: 'ignore' }).status === 0;
}

/** ERE metacharacter escape, for embedding a literal path in a `pgrep -f` pattern. */
function ereEscape(literal: string): string {
  return literal.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');
}

/**
 * True when THIS hermit's heartbeat monitor subprocess is not running.
 *
 * Anchored on this hermit's own state dir, not on the bare script name: `pgrep`
 * scans the whole PID namespace, and `docker.fleet_mesh` hermits deliberately
 * SHARE one (`pid: container:hermit-fleet-pidns`). A bare `heartbeat-monitor.sh`
 * match there finds a SIBLING hermit's monitor and reports this hermit's dead
 * one as alive, permanently suppressing the pane-frozen restart escalation.
 * The monitor is registered as `bash <script> <interval> $PWD/.claude-code-hermit`
 * (heartbeat/SKILL.md § start), so the resolved hermit root disambiguates it.
 */
function heartbeatMonitorDead(): boolean {
  const root = ereEscape(path.resolve(HERMIT_ROOT));
  return !checkProcessRunning(`heartbeat-monitor\\.sh .*${root}`);
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

function readWatchdogState(world: World = REAL_WORLD): Json {
  const data = world.files.readJson(path.join(world.paths.stateDir, 'watchdog-state.json'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { consecutive_stale: 0, last_pane_hash: null, last_nudge_at: null };
  }
  return data;
}

/** The StopFailure stamp, or null when absent/unreadable. Written by
 *  stop-failure-stamp.ts, deleted by stop-pipeline.ts on the next healthy Stop. */
function readStopFailureStamp(world: World = REAL_WORLD): Json | null {
  const data = world.files.readJson(path.join(world.paths.stateDir, 'stop-failure.json'));
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

function writeWatchdogState(state: Json, world: World = REAL_WORLD): void {
  state.last_check_at = worldStamp(world);
  world.files.writeJson(path.join(world.paths.stateDir, 'watchdog-state.json'), state);
}

// --- Actions ---

/** Delete the pending-credential pointer and its staging dir, if any. */
function clearPendingCredential(stagedDir?: string): void {
  try {
    fs.unlinkSync(PENDING_CREDENTIAL_JSON);
  } catch {}
  if (stagedDir) {
    try {
      fs.rmSync(stagedDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Move a staged claude.ai sign-in into place. Called from inside doRestart's
 * kill→verify→start boundary and nowhere else, because that is the only window in
 * which no session is refreshing `.credentials.json` underneath the write.
 *
 * Rollback is real, not "do nothing": the previous credential is parked before the
 * staged one lands, and put back if that move fails — a half-committed dir with the
 * live file parked and no replacement would boot the hermit with no credential at
 * all. A staged file that did not survive the wait is dropped and the restart
 * proceeds on whatever the live dir already holds.
 *
 * Never throws: this runs between the kill and the spawn inside doRestart, where an
 * exception would abort the restart with the session already dead.
 */
function commitPendingCredential(): void {
  const pending = readJson(PENDING_CREDENTIAL_JSON);
  if (!pending || typeof pending.staged_dir !== 'string' || !pending.staged_dir) return;

  const stagedDir: string = pending.staged_dir;
  const configDir = defaultConfigDir();
  const clear = () => clearPendingCredential(stagedDir);

  // Staleness first. A staging that outlived its restart (the restart aborted on
  // survivors, the lock was held, requestRestart never landed) must not be committed
  // by some unrelated restart days later: `usable` only means the file carries a
  // token, so an abandoned sign-in still reads usable long after it stopped working,
  // and committing it would park a working credential and take the hermit dark.
  const stagedAge = ageSecs(pending.staged_at ?? '');
  if (stagedAge === null || stagedAge * 1000 > PENDING_CREDENTIAL_MAX_AGE_MS) {
    clear();
    appendEvent('credential-commit-skipped', `stale staging (${stagedAge === null ? 'undated' : `${Math.round(stagedAge / 60)}m old`})`);
    return;
  }

  // Re-checked here, not trusted from the mint: the mint ran minutes to hours ago.
  const status = inspectStoredLogin(stagedDir).status;
  if (status !== 'usable') {
    clear();
    appendEvent('credential-commit-skipped', status);
    return;
  }

  const live = credentialsFilePath(configDir);
  const parked = `${live}.pre-login.bak`;
  let didPark = false;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    if (fs.existsSync(live)) {
      fs.renameSync(live, parked);
      didPark = true;
    }
    fs.renameSync(credentialsFilePath(stagedDir), live);
    copyOauthAccount(stagedDir, configDir);
    clear();
    // Recorded now rather than by the mint: the mode is only true once the
    // credential it names is the one the next session will actually read.
    spawnSync(process.execPath, [SETTINGS_EDIT_SCRIPT, path.join(HERMIT_ROOT, 'config.json'), 'set', 'auth_mode', 'login'], {
      stdio: 'ignore',
    });
    appendEvent('credential-committed', 'login');
  } catch (e) {
    // Put the old credential back if it was parked but never replaced, so the
    // restart proceeds on the credential the hermit already had.
    if (didPark && !fs.existsSync(live)) {
      try {
        fs.renameSync(parked, live);
      } catch {}
    }
    appendEvent('credential-commit-skipped', `commit failed: ${e}`);
    clear();
  }
}

/**
 * Carry the signed-in identity across. `claude auth status` reads the email and org
 * from `.claude.json`'s `oauthAccount`, not from the credential file (probed), so a
 * commit that moved only `.credentials.json` would leave the hermit authenticated as
 * the new account while still reporting the old one.
 */
function copyOauthAccount(stagedDir: string, configDir: string): void {
  try {
    const staged = JSON.parse(fs.readFileSync(path.join(stagedDir, '.claude.json'), 'utf8'));
    if (!staged?.oauthAccount) return;
    const livePath = path.join(configDir, '.claude.json');
    let live: Json = {};
    if (fs.existsSync(livePath)) {
      // Parse failure means "don't touch it". `.claude.json` carries the harness's
      // whole per-user state (installed plugins, trusted folders, onboarding), so
      // rewriting an unreadable one as `{oauthAccount}` would trade a wrong email
      // in `claude auth status` for a wiped Claude Code config.
      try {
        live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
      } catch {
        return;
      }
      if (!live || typeof live !== 'object' || Array.isArray(live)) return;
    }
    live.oauthAccount = staged.oauthAccount;
    writeFileAtomic(livePath, JSON.stringify(live, null, 2) + '\n');
  } catch {}
}

/** Try-acquire lock, mark runtime, kill session, verify the old tree died, spawn hermit-start. */
async function doRestart(sessionName: string, reason: string, runtime: Json, timezone: string, config: Json): Promise<void> {
  if (runtime.last_start_error === 'resident-missing'
    && !fs.existsSync(path.join(HERMIT_ROOT, 'RESIDENT.md'))) {
    if (runtime.last_start_error_notified !== 'resident-missing') {
      pushOperatorMessage('[hermit] RESIDENT.md not found. Run `claude` in this project and ask it to run /claude-code-hermit:hermit-evolve, then start again.');
      runtime.last_start_error_notified = 'resident-missing';
      writeRuntimeJson(runtime);
      appendEvent('resident-missing', 'operator notified; restart skipped');
    }
    return;
  }

  if (!tryAcquireLifecycleLock()) {
    process.stderr.write('[watchdog] lifecycle lock held — backing off restart\n');
    return;
  }

  try {
    // Mark runtime before killing so session-start recovery sees the reason
    runtime.last_error = 'unclean_shutdown';
    runtime.watchdog_restart_reason = reason;
    writeRuntimeJson(runtime);

    // Capture the pane's process tree BEFORE the kill so we can verify the old
    // claude actually died. (For a dead-session restart tmux is already gone, so
    // this is empty and the restart proceeds unchanged.)
    const tree = collectTree(paneRootPids(sessionName));
    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
    const survivors = await terminateSurvivors(tree.pids);

    if (survivors.length > 0 || tree.capped) {
      // The old process survived the kill. Spawning a replacement now would
      // recreate the duplicate-instance incident, so abort and alert instead.
      releaseLock(LIFECYCLE_LOCK);
      appendEvent('restart-aborted', `survivors: ${(survivors.length ? survivors : tree.pids).join(' ')}`);
      process.stderr.write(`[watchdog] restart aborted — process survived kill: ${survivors.join(' ')}\n`);
      pushOperatorMessage(composeOrphanMessage(timezone));
      return;
    }

    // The one moment nothing is holding the credential file: the old session is
    // verifiably dead and the new one has not started. A renewal written at any
    // other time can be clobbered by the resident's own ~8-hourly refresh, which is
    // why the mint stages it and leaves the commit here.
    commitPendingCredential();

    // Release before spawning hermit-start (it re-acquires)
    releaseLock(LIFECYCLE_LOCK);

    const id = runtime.cc_session_id;
    // Same enable test maybeContextCompact applies (`enabled === true`): resume
    // only where the compact tier actually bounds the context it would restore.
    const compactCfg = config.context_hygiene?.compact;
    const threshold = compactCfg?.min_context_tokens;
    let skip: string | null = null;
    if (typeof id !== 'string' || !id.trim()) skip = 'no-session-id';
    else if (compactCfg?.enabled !== true) skip = 'compact-disabled';
    else {
      const entry = getLastCostLogEntry(id);
      if (!entry) skip = 'no-cost-entry';
      else skip = poisonedEntrySkip(entry, runtime)
        ?? (promptTokens(entry) < threshold ? null : 'over-threshold');
    }
    const resumeArgs = skip ? [] : ['--resume', id];
    const resumeDetail = skip ? `fresh: ${skip}` : `resume ${id}`;
    const startBin = '.claude-code-hermit/bin/hermit-start';
    const child = spawn(startBin, resumeArgs, {
      detached: true,
      stdio: 'ignore',
      // No explicit env: hermit-start reads the setup token from defaultConfigDir()
      // and forwards CLAUDE_CONFIG_DIR into the new session's tmux env-file, and
      // adoptSessionConfigDir() already assigned the session's own value onto
      // process.env on both paths that reach here — which spawn passes on by default.
    });
    child.on('error', (e) => process.stderr.write(`[watchdog] restart failed: ${e}\n`));
    child.unref();
    appendEvent('restart', `${reason}, tree-verified, ${resumeDetail}`);
    process.stderr.write(`[watchdog] restarted "${sessionName}", reason: ${reason}\n`);
    // Only claim a restart to the operator when the start binary is actually
    // present — a missing/ENOENT binary makes spawn fail asynchronously via the
    // 'error' handler above, after this synchronous path already returned, so
    // guard the push on the binary existing rather than on spawn's async result.
    // The lock is already released above, so a slow send never holds it.
    if (fs.existsSync(startBin)) pushOperatorMessage(composeRestartMessage(reason, timezone));
  } catch (e) {
    process.stderr.write(`[watchdog] restart failed: ${e}\n`);
  } finally {
    releaseLock(LIFECYCLE_LOCK); // no-op once already released
  }
}

// --- Re-auth relay (step 3a) ---
//
// A lapsed setup-token leaves the hermit alive but unable to reach the API, and
// no amount of restarting fixes that — only a human browser tap does. The relay
// is the deterministic recovery: ask the operator over their channel, mint a
// fresh token, install it, restart. No model in the loop, because by definition
// the model can't run.
//
// Note what is deliberately NOT suppressed: dead-session restart (step 3) still
// fires during a relay. The relay polls the channel log for the operator's
// reply, and inbound messages only reach that log through the channel plugin
// living inside the claude session — so keeping the session up, even 401-dead,
// is what makes the reply reachable at all.

/** True when a relay process is genuinely still working. Clears a dead marker. */
function reauthRelayActive(): boolean {
  // A staged sign-in waiting for the next restart IS a renewal in flight — the mint
  // process is already gone, and spawning another would reset the staging dir out
  // from under a credential this watchdog has been told to commit.
  //
  // Past that window the staging is abandoned (its restart never happened) and has
  // to be dropped here, not merely ignored: the mint refuses to start while a
  // pointer exists, so leaving one behind would make every subsequent relay spawn a
  // process that exits immediately while this tick still reported 'spawned' — the
  // hermit would sit expired forever, supervising nothing and never renewing.
  const pending = readJson(PENDING_CREDENTIAL_JSON);
  if (pending) {
    const age = ageSecs(pending.staged_at ?? '');
    if (age !== null && age * 1000 < PENDING_CREDENTIAL_MAX_AGE_MS) return true;
    clearPendingCredential(typeof pending.staged_dir === 'string' ? pending.staged_dir : undefined);
    appendEvent('credential-commit-skipped', 'cleared abandoned staging');
  }
  const marker = readJson(REAUTH_MARKER_JSON);
  if (!marker) return false;
  const age = ageSecs(marker.updated_at ?? marker.started_at ?? '');
  const isSkillMode = marker.mode === 'skill';
  // The /relogin skill drives the mint one verb at a time, each its own
  // short-lived process, so its recorded PID is always dead by the time we look.
  // Age is the only usable signal there — and it has to be one, because
  // otherwise we read a live flow as abandoned and spawn a relay whose
  // startMint() kills the pane holding the operator's pending sign-in link.
  // Its window is the flow's own timeouts (link 90s + code 30m + token 3m),
  // not the relay's 24h operator-ack wait.
  const maxAge = isSkillMode ? REAUTH_SKILL_MARKER_MAX_AGE_MS : REAUTH_MARKER_MAX_AGE_MS;
  const tooOld = age === null || age * 1000 > maxAge;
  // Liveness over age: a relay legitimately waits many hours for the operator to
  // reach a browser, so only a dead PID (or an absurd age) means abandoned — skill
  // mode has no PID to check, so age alone is its liveness signal.
  if (!tooOld && (isSkillMode || (typeof marker.pid === 'number' && pidAlive(marker.pid)))) return true;
  try {
    fs.unlinkSync(REAUTH_MARKER_JSON);
    appendEvent('reauth-relay', 'cleared stale marker');
  } catch {}
  return false;
}

/**
 * Adopt the session's own config dir from runtime.json, before any auth decision,
 * transcript read, or child spawn that resolves defaultConfigDir() — the re-auth
 * relay and hermit-start among them.
 *
 * startup-context.ts stamps `config_dir` from inside the session, so it also carries
 * a value set in user or managed settings — a source this process cannot observe at
 * all. Assigning it here reaches every defaultConfigDir() call without special-casing
 * each one. Absent field → today's behavior, so a session booted before this shipped
 * is unaffected.
 */
function adoptSessionConfigDir(runtime: Json): void {
  if (typeof runtime.config_dir === 'string' && runtime.config_dir) {
    process.env.CLAUDE_CONFIG_DIR = runtime.config_dir;
  }
}

/**
 * The resident's inbox socket, or null when there is nothing to post to.
 *
 * Same provenance as `config_dir` above: startup-context.ts stamps it from inside
 * the session, because CLAUDE_CODE_MESSAGING_SOCKET is exported to the session's
 * own hooks and is invisible to this process. The alternative — scanning
 * <config dir>/sessions/*.json — cannot tell the resident from a guest session in
 * the same folder (they share a cwd) and cannot key on the tmux pane pid either,
 * since hermit-start wraps claude in a shell. The session writing its own path is
 * exact by construction.
 *
 * Null means "type instead", and it is reachable in normal operation: a hermit
 * still running the session it booted before this upgrade has no stamp yet, and
 * a session that died took its socket file with it.
 */
function resolveInboxSocket(runtime: Json): string | null {
  const sock = runtime?.inbox_socket;
  return typeof sock === 'string' && sock ? sock : null;
}

/**
 * The resident's own entry in Claude Code's session registry, or null.
 *
 * Same provenance again: `session_pid` comes from the session's own stamp, and
 * nothing else can pick the resident out of the registry — guests share its cwd.
 * Null is the normal degraded case (no stamp yet, entry gone, a status the
 * reader doesn't recognise), and every caller below keeps the behavior it had
 * without the registry, because this file is undocumented and may change.
 */
function resolveResident(runtime: Json): SessionEntry | null {
  try {
    return findResident(runtime);
  } catch {
    return null;
  }
}

/**
 * Auth modes where a 401 on the pane is NOT a login problem: an API key, a bearer
 * token, or a cloud provider. Telling those operators to sign in would be wrong advice
 * for a cause no login can fix, so the lapsed-login paths sit this out entirely.
 */
function envAuthOwnsCredential(sessionEnvAuth: boolean | null): boolean {
  // The session's stamp answers, because on a host install this process's own env
  // describes the unit, not the hermit — including when it says `false`. A unit or
  // crontab that happens to carry a key while the session runs on /login would
  // otherwise suppress the lapsed-login tiers and re-create the silent outage this
  // reads the stamp to avoid. Only an ABSENT stamp falls back to this process's env:
  // Docker shares one environment between the loop and the session, and a session
  // booted before the stamp existed has nothing else to offer.
  return sessionEnvAuth ?? envAuthPresent();
}

/**
 * 'active' → relay in flight; 'spawned' → just started one; 'idle' → nothing to do.
 *
 * `authLapsed` is the pane's verdict, and it is a second, independent trigger next to
 * the recorded expiry. The record only knows when the token was *minted plus a year*;
 * a token revoked early (account change, rotation, a bad restore) leaves the record
 * reading healthy while every request 401s, and the wedge tiers below would answer
 * that with restart churn. The pane says what the record can't.
 */
function evaluateReauth(
  config: Json,
  authLapsed: boolean = false,
  sessionEnvAuth: boolean | null = null,
): 'active' | 'spawned' | 'idle' | 'unreachable' {
  if (reauthRelayActive()) return 'active';
  const configDir = defaultConfigDir();
  // envAuthOwnsCredential, not envAuthPresent: the key lives in the SESSION's
  // environment, which this process does not share — the launch stamp is the only
  // place the watchdog can see it. Getting this wrong would spawn a sign-in relay
  // at an API-key hermit, whose 401 no login can fix.
  const mode = resolveAuthMode(config, configDir, envAuthOwnsCredential(sessionEnvAuth));
  // An env credential is nobody's to renew from here — no relay can fix it.
  if (mode === 'external') return 'idle';

  // In login mode the durable expiry is the stored credential's own
  // refreshTokenExpiresAt; a lapse stub reports -1, so one comparison covers both
  // "the sign-in ran out" and "the sign-in was spent".
  const msLeft = mode === 'login' ? msUntilLoginExpiry(configDir) : msUntilExpiry(HERMIT_ROOT);
  const expired = msLeft !== null && msLeft <= 0;
  if (!expired && !authLapsed) return 'idle';

  // The relay's own send is the reachability test, and it stamps this file when it
  // fails. Honouring it for 24h is what stops a hermit with no channel — or a dead
  // one — from respawning a relay nobody can answer on every single tick.
  const stamp = readJson(RELAY_UNREACHABLE_JSON);
  if (stamp) {
    const age = ageSecs(stamp.at ?? '');
    if (age !== null && age * 1000 < RELAY_UNREACHABLE_MAX_AGE_MS) return 'unreachable';
  }

  const trigger = expired
    ? mode === 'login'
      ? 'claude.ai login expired'
      : 'setup-token expired'
    : 'auth failure on pane';

  try {
    const child = spawn(process.execPath, [REAUTH_MINT_SCRIPT, 'relay'], {
      detached: true,
      stdio: 'ignore',
      // No explicit env: the relay installs the freshly-minted token into
      // defaultConfigDir(), which must be the SESSION's config dir — already on
      // process.env from adoptSessionConfigDir(), which spawn passes on.
    });
    child.on('error', (e) => process.stderr.write(`[watchdog] reauth relay spawn failed: ${e}\n`));
    child.unref();
    appendEvent('reauth-relay', `${trigger} — relay spawned`);
    process.stderr.write(`[watchdog] ${trigger} — spawned re-auth relay\n`);
    return 'spawned';
  } catch (e) {
    process.stderr.write(`[watchdog] reauth relay spawn failed: ${e}\n`);
    return 'idle';
  }
}

/**
 * Step 0e — spawn the state backup when its cron window is due.
 *
 * Detached and unawaited: a first push of a repo carrying binaries can run for
 * minutes, and dead-session recovery (steps 3-5) is the tick's core promise. The
 * child writes its own status file and always exits 0, so nothing here waits on
 * it. `child.on('error')` is required alongside the try/catch — a spawn ENOENT
 * arrives asynchronously and an unhandled 'error' event on a ChildProcess would
 * throw out of the whole tick.
 */
function maybeSpawnBackup(config: Json): void {
  try {
    if (!evaluateBackupDue(config, HERMIT_ROOT, new Date())) return;
    const child = spawn(process.execPath, [BACKUP_SCRIPT, 'run'], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => process.stderr.write(`[watchdog] backup spawn failed: ${e}\n`));
    child.unref();
    appendEvent('backup', 'scheduled run spawned');
  } catch (e) {
    process.stderr.write(`[watchdog] backup spawn failed: ${e}\n`);
  }
}

/** The wedge wake, as a peer message body.
 *
 *  Exactly the token heartbeat-monitor.sh emits, and nothing else. Two reasons it
 *  cannot drift: record-operator-action.ts's isRoutinePrompt drops this string so
 *  the wake is not miscounted as operator activity (a false positive there
 *  silences AUTO_CLOSE), and the CLAUDE-APPEND routing rule the model follows is
 *  written against this literal. Any wording around it — "please", "the operator
 *  asked" — is both unnecessary and, per the peer-framing probes, the thing that
 *  flips a model to refusing. tests/auto-close.test.ts pins both ends. */
const WEDGE_WAKE_TOKEN = 'HEARTBEAT_EVALUATE';

/** Send a heartbeat run nudge to a potentially wedged session.
 *  The nudge is a paid full-context wake, so repeats within one episode are spaced
 *  by the staleness threshold that detected the wedge: one probe per detection
 *  window. Ticks in between still count (`consecutive_stale`), so the cycle count
 *  reaches `escalate_after` on exactly the tick it would have without the throttle.
 *  The other escalation input does move, deliberately: `last_pane_hash` is captured
 *  before the keystroke, so under the old cadence every tick's nudge re-rendered the
 *  pane (the queued message) and `paneFrozen` could never be true — a wedge masked
 *  itself from the restart it needed. Staying silent between probes lets a genuinely
 *  frozen pane read as frozen, so the pane-frozen restart is now reachable. */
async function doNudge(sessionName: string, watchdogState: Json, consecutive: number, paneHash: string | null, timezone: string, minIntervalSecs: number, wake: { inboxSocket: string | null; resident: SessionEntry | null } = { inboxSocket: null, resident: null }): Promise<void> {
  // Bundled rather than two more trailing positionals: both describe where the
  // wake goes and how its landing is observed, and a bare `string | null` next
  // to `paneHash` is a transposition TypeScript would not catch.
  const { inboxSocket, resident } = wake;
  if (isPaused(HERMIT_ROOT).paused) return; // PROP-015 — no nudges while paused

  const nudgeAge = watchdogState.last_nudge_at ? ageSecs(watchdogState.last_nudge_at) : null;
  // The registry answers the one question the socket write cannot: did the post
  // start a turn? A delivered message flips `status` off `idle` within ~3s, and
  // `statusUpdatedAt` stamps the START of the current state — so a resident
  // still sitting in an `idle` that began BEFORE the post was written never read
  // it (refused, held behind a dialog nobody is watching, or declined by the
  // model). That is the whole throttle window recovered: without this the
  // fallback waits for the next due nudge, up to `wedge_floor` (4h default),
  // to learn what the registry already knows on the next tick.
  const socketUndelivered =
    watchdogState.last_nudge_transport === 'socket' &&
    typeof watchdogState.last_nudge_at === 'string' &&
    resident !== null &&
    resident.status === 'idle' &&
    resident.statusUpdatedAt < Date.parse(watchdogState.last_nudge_at);
  const due = socketUndelivered || nudgeAge === null || nudgeAge >= minIntervalSecs;

  watchdogState.consecutive_stale = consecutive;
  watchdogState.last_pane_hash = paneHash;

  if (!due) {
    writeWatchdogState(watchdogState);
    appendEvent('nudge-throttled', `stale cycle ${consecutive}`);
    process.stderr.write(`[watchdog] nudge throttled for "${sessionName}" (stale cycle ${consecutive})\n`);
    return;
  }

  // Socket first, typing second — but only once per episode. A post is queued by
  // the harness and read at the next tool boundary, so it reaches a session whose
  // pane is mid-tool, which is exactly the state a wedge probe finds. What it
  // cannot do is report its own outcome: `crossSessionInbound: refuse` drops the
  // message silently, a receiver whose inbound controls still hold it (one launched
  // without the hermit's overlay, or an operator-set `hold`) leaves it behind a
  // dialog, and a model may simply decline to act on the text — all three
  // look identical to a successful write. So the fallback is keyed on the effect
  // instead: if the NEXT due nudge still finds the heartbeat stale, the post did
  // not work, whatever the wire said, and this one types. One rule covers dead,
  // refused, held and declined, and costs one throttle window when the socket
  // path fails. Delivery, not dispatch, is what the alternation observes — and
  // `socketUndelivered` above is that same observation made a whole window
  // earlier when the registry is readable.
  const transport = inboxSocket && watchdogState.last_nudge_transport !== 'socket'
    ? await postToSession(inboxSocket, WEDGE_WAKE_TOKEN)
    : 'dead';

  if (transport === 'sent') {
    watchdogState.last_nudge_transport = 'socket';
  } else {
    watchdogState.last_nudge_transport = 'typed';
    sendKeys(sessionName, '/claude-code-hermit:heartbeat run');
  }
  // First notice of an episode is the waking wording. The stronger "isn't
  // responding" string fires at most once, and only after the wake has failed
  // (socket undelivered, or a second stale cycle). Keying on `consecutive === 1`
  // alone re-fires when the operator-recency guard resets consecutive_stale to 0
  // mid-episode (an operator poke isn't a heartbeat recovery); sticky flags,
  // cleared only when the heartbeat actually recovers (the fresh-heartbeat
  // branch in main), fix that.
  const wakeFailed = socketUndelivered || consecutive >= 2;
  let notify: 'waking' | 'escalated' | null = null;
  if (!watchdogState.wedge_notified) {
    watchdogState.wedge_notified = true;
    notify = 'waking';
  } else if (wakeFailed && !watchdogState.wedge_escalated) {
    watchdogState.wedge_escalated = true;
    notify = 'escalated';
  }
  watchdogState.last_nudge_at = utcStamp();
  writeWatchdogState(watchdogState);
  const via = watchdogState.last_nudge_transport === 'socket' ? 'nudge-socket' : 'nudge';
  appendEvent(via, socketUndelivered ? `stale cycle ${consecutive} — socket undelivered` : `stale cycle ${consecutive}`);
  process.stderr.write(`[watchdog] nudged "${sessionName}" via ${watchdogState.last_nudge_transport} (stale cycle ${consecutive})\n`);
  if (notify === 'waking') pushOperatorMessage(composeWedgeMessage(timezone));
  else if (notify === 'escalated') pushOperatorMessage(composeWedgeMessage(timezone, OPERATOR_LOCALE, true));
}

// --- Monitor-liveness re-arm (step 5) ---
//
// Keys off ground truth: the per-poll liveness files the monitors themselves stamp.
// Its staleness logic mirrors doctor's checkHeartbeat/checkRoutineMonitor (trusted-tick
// vs started_at, startup grace, boot gate) so a doctor 'fail' and a watchdog re-arm
// trip on the same signal.

// A monitor writes liveness on its first loop iteration, so a real tick lands within
// seconds of spawn; the grace only needs to cover spawn + first precheck. This is the
// absent-liveness grace only — a tick that merely predates started_at gets the wider
// heartbeatPredatesGraceSecs, which has to outlast one poll interval.
const MONITOR_STARTUP_GRACE_SECS = 120;
// Grace before a boot mismatch is trusted, measured from the `.boot-id` marker's mtime.
// hermit-start stamps that marker itself, but the monitors are re-registered by the
// bootstrap turn that follows it (`/heartbeat start`, `/hermit-routines load`), so in
// between the runtime files legitimately still carry the previous boot's id — re-arming
// there would duplicate an injection already in flight. A boot that still has not
// re-registered after this window is genuinely stuck, and the re-arm is then correct.
// Wider than MONITOR_STARTUP_GRACE_SECS because it must cover a whole model turn.
const BOOT_GATE_GRACE_SECS = 600;
// One re-arm attempt per monitor per this window. Essential: where Monitor spawn is
// blocked outright (seccomp / nested-userns), an undamped liveness-keyed re-arm would
// re-inject every tick forever — each injection a paid full-context wake.
export const MONITOR_REARM_DAMPER_SECS = 6 * 3600;
// Default lower bound on the wedge threshold (step 4), independent of heartbeat.every. The
// nudge is an end-to-end liveness probe and each one is a paid full-context wake, so its
// cadence is a recovery policy, not a function of the poll interval. Operator-settable via
// `watchdog.wedge_floor`: an install that deliberately tightened heartbeat.every keeps its
// own recovery SLA, and "0s" restores the plain stale_factor × every product.
export const WEDGE_FLOOR_DEFAULT = '4h';

/**
 * True when a monitor that should be ticking has a liveness timestamp stale past
 * thresholdSecs — or, lacking any trusted tick, a registration older than the startup
 * grace. Trust mirrors doctor: a tick predating started_at belongs to a prior session's
 * monitor and is not proof the current one is alive. A monitor never registered
 * (runtimeData null, so started_at unknown) returns false — re-registering that is
 * session-start's job, not the watchdog's.
 */
function monitorLivenessStale(
  livenessFile: string,
  runtimeData: Json,
  thresholdSecs: number,
  predatesGraceSecs: number = MONITOR_STARTUP_GRACE_SECS,
): boolean {
  const startedAt: string | null =
    runtimeData && typeof runtimeData.started_at === 'string' ? runtimeData.started_at : null;
  const liveness = readJson(path.join(STATE_DIR, livenessFile));
  const lastPeekAt: string | null =
    liveness && typeof liveness.last_peek_at === 'string' ? liveness.last_peek_at : null;
  return !monitorFreshness(
    startedAt,
    lastPeekAt,
    thresholdSecs,
    MONITOR_STARTUP_GRACE_SECS,
    Date.now(),
    predatesGraceSecs,
  ).fresh;
}

/**
 * Does this registration belong to a dead previous boot? Liveness alone cannot see
 * that: a monitor dies with its session, so its last tick is at most one interval old
 * and still reads "fresh" for the rest of the window (90 min at the default heartbeat
 * `every`). Held behind BOOT_GATE_GRACE_SECS so a bootstrap still in flight is not
 * mistaken for one that never re-registered. Absent marker or absent stored id →
 * false, falling through to the plain freshness check (see `bootMismatch`).
 */
function monitorBootStale(runtimeData: Json): boolean {
  if (!bootMismatch(runtimeData?.boot_id, readBootId(HERMIT_ROOT))) return false;
  const markerAgeSecs = getFileAgeSecs(path.join(STATE_DIR, '.boot-id'));
  return markerAgeSecs !== null && markerAgeSecs >= BOOT_GATE_GRACE_SECS;
}

/** Heartbeat monitor stale? Gated + thresholded exactly as doctor's checkHeartbeat. */
function heartbeatMonitorStale(config: Json): boolean {
  const hbCfg = config?.heartbeat;
  if (!hbCfg || typeof hbCfg !== 'object' || Array.isArray(hbCfg) || !hbCfg.enabled) return false;
  const thresholdSecs = 3 * parseDuration(hbCfg.every ?? '30m');
  const monRt = readJson(path.join(STATE_DIR, 'heartbeat-monitor.runtime.json'));
  if (monitorBootStale(monRt)) return true;
  // Grace off the registered cadence, not config's: `every` can be edited without a
  // re-arm, and the running loop still polls at the interval it was started with.
  const interval = typeof monRt?.interval === 'number' && monRt.interval > 0
    ? monRt.interval
    : parseDuration(hbCfg.every ?? '30m');
  return monitorLivenessStale(
    'heartbeat-liveness.json',
    monRt,
    thresholdSecs,
    heartbeatPredatesGraceSecs(interval),
  );
}

/** Routine monitor stale? Gated + thresholded exactly as doctor's checkRoutineMonitor. */
function routineMonitorStale(config: Json): boolean {
  const routines = Array.isArray(config?.routines) ? config.routines : [];
  const anyEnabled = routines.some((r: Json) => r && r.enabled === true && r.id !== 'heartbeat-restart');
  if (!anyEnabled) return false;
  const monRt = readJson(path.join(STATE_DIR, 'routine-monitor.runtime.json'));
  if (!monRt) return false; // not loaded — session-start's job, not the watchdog's
  // Boot gate ahead of the fallback bail: croncreate-fallback writes no liveness file,
  // so the boot id is the only evidence its durable:false crons died with that process.
  if (monitorBootStale(monRt)) return true;
  if (monRt.mode === 'croncreate-fallback') return false; // CronCreate fallback (no Monitor)
  const interval = typeof monRt.interval === 'number' && monRt.interval > 0 ? monRt.interval : 60;
  const thresholdSecs = Math.max(10 * interval, 10 * 60);
  return monitorLivenessStale('routine-monitor-liveness.json', monRt, thresholdSecs);
}

/** Damper open when the given re-arm timestamp is older than MONITOR_REARM_DAMPER_SECS
 *  (or missing). Used by the step-5 monitor re-arm, once per monitor. */
export function rearmDamperOpen(lastStamp: unknown, world: World = REAL_WORLD): boolean {
  if (typeof lastStamp !== 'string') return true;
  const age = ageSecs(lastStamp, world);
  return age === null || age >= MONITOR_REARM_DAMPER_SECS;
}

/**
 * Re-arm a heartbeat/routine Monitor that died mid-session, detected via its stale
 * liveness file. Injects only the dead monitor's re-arm command (both are in
 * record-operator-action's INJECTED_EXACT, so neither stamps the operator-activity
 * clock).
 */
function maybeMonitorRearm(config: Json, sessionName: string, sessionAlive: boolean, operatorGraceSecs: number): void {
  if (isPaused(HERMIT_ROOT).paused) return;               // no injection while paused (mirrors doNudge)
  if (!sessionAlive) return;                              // dead session belongs to the doRestart path
  const opAge = getOperatorLastActionAgeSecs();
  if (opAge !== null && opAge < operatorGraceSecs) return; // operator mid-conversation — back off

  const heartbeatStale = heartbeatMonitorStale(config);
  const routineStale = routineMonitorStale(config);
  if (!heartbeatStale && !routineStale) return;

  const state = readWatchdogState();
  const lastRearm =
    state.last_monitor_rearm && typeof state.last_monitor_rearm === 'object' && !Array.isArray(state.last_monitor_rearm)
      ? state.last_monitor_rearm
      : {};

  const doHeartbeat = heartbeatStale && rearmDamperOpen(lastRearm.heartbeat);
  const doRoutines = routineStale && rearmDamperOpen(lastRearm.routines);
  if (!doHeartbeat && !doRoutines) return; // stale but still inside the per-monitor damper window

  // `load` arms both monitors, so a both-stale pass is one injection: sending
  // `heartbeat start` behind it would load a second skill body only to be told the
  // leg it re-registers is already FRESH. A heartbeat-only staleness still takes the
  // cheaper single-leg skill.
  if (doRoutines) sendKeys(sessionName, '/claude-code-hermit:hermit-routines load');
  else if (doHeartbeat) sendKeys(sessionName, '/claude-code-hermit:heartbeat start');

  const stamp = utcStamp();
  if (doHeartbeat) lastRearm.heartbeat = stamp;
  if (doRoutines) lastRearm.routines = stamp;
  state.last_monitor_rearm = lastRearm;
  writeWatchdogState(state);

  const targets = [doHeartbeat ? 'heartbeat' : null, doRoutines ? 'routine-monitor' : null].filter(Boolean).join('+');
  appendEvent('monitor-rearm', `${targets} liveness stale`);
  process.stderr.write(`[watchdog] monitor re-arm "${sessionName}" (${targets})\n`);
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
  if (isPaused(HERMIT_ROOT).paused) return; // PROP-015 — never clear while paused

  const runtime = readRuntimeJson();
  if (!runtime) return;
  if (runtime.session_state !== 'idle') return;
  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) return; // never clear a stopping hermit

  const sessionName = runtime.tmux_session ?? '';
  if (!sessionName) return;
  if (!tmuxSessionAlive(sessionName)) return;

  const opAge = getOperatorLastActionAgeSecs();
  if (opAge !== null && opAge < AUTO_CLOSE_LULL_MS / 1000) return; // operator active within the lull — back off

  if (!tryAcquireLifecycleLock()) return; // another lifecycle action in flight, retry next tick
  try {
    // Deliberately NOT applyContextReset: this path has never written a SHELL.md
    // breadcrumb (the close itself already left an archived report), and adding one
    // here would change shipped behaviour. Only the stamp + cache clear are shared.
    runtime.context_cleared = true;
    writeRuntimeJson(runtime);
    // Same machine-readable reset stamp every other reset path writes: PreCompact never
    // fires for /clear, so without it the pre-clear cost entry stays the newest one for
    // this session and poisonedEntrySkip cannot tell it apart from a live reading.
    stampContextReset(HERMIT_ROOT);
    sendKeys(sessionName, '/clear');
    clearStatusCacheAt(HERMIT_ROOT);
    try { fs.rmSync(CLEAR_REQUESTED_JSON); } catch {}
    appendEvent('post-close-clear', 'daily-auto-close context reset');
  } finally {
    releaseLock(LIFECYCLE_LOCK);
  }
  process.exit(0);
}

// --- Shared lifecycle/token guards (maybeContextClear + maybeContextCompact) ---

/** Discriminated result for passesLifecycleGuards — the reason string feeds
 *  last_hygiene_eval so a starved hygiene tier is diagnosable from state alone. */
export type GuardReason = 'paused' | 'interactive' | 'transition' | 'suspect-process' | 'shutdown-stamp' | 'no-tmux' | 'operator-recent';
export type GuardResult = { ok: true; sessionName: string } | { ok: false; reason: GuardReason };

/**
 * Common lifecycle gates for the two auto-compaction mechanisms: not paused
 * (PROP-015), always-on only, no in-flight transition, no watchdog-internal
 * suspect state, no shutdown in progress, a live tmux session, and operator
 * silence ≥10 min. Returns the live session name when every gate passes, or
 * a reason string when the caller should bail.
 */
export function passesLifecycleGuards(runtime: Json, world: World = REAL_WORLD): GuardResult {
  if (isPaused(world.paths.hermitRoot).paused) return { ok: false, reason: 'paused' }; // PROP-015 — never auto-clear/compact while paused
  if (runtime.runtime_mode === 'interactive') return { ok: false, reason: 'interactive' }; // interactive sessions must never be auto-managed
  if (runtime.transition) return { ok: false, reason: 'transition' }; // archiving/cleaning recovery is mid-flight — never interfere
  const sessionState: string = runtime.session_state ?? '';
  if (sessionState === 'suspect_process') return { ok: false, reason: 'suspect-process' }; // exclusion model: only bail on watchdog-internal state

  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) return { ok: false, reason: 'shutdown-stamp' };

  const sessionName: string = runtime.tmux_session ?? '';
  if (!sessionName || !world.tmux.alive(sessionName)) return { ok: false, reason: 'no-tmux' };

  const opAge = getOperatorLastActionAgeSecs(world);
  if (opAge !== null && opAge < 10 * 60) return { ok: false, reason: 'operator-recent' }; // operator-recency backoff

  return { ok: true, sessionName };
}

// Shared between maybeContextClear and maybeContextCompact — both need "the last
// cost-log entry for this session" on every tick. Memoized per invocation (this
// script is single-shot, one process per scheduler tick) so the two mechanisms
// don't each re-read and re-parse the full (append-only, unbounded-growth) cost
// log JSONL in the same tick.
function getLastCostLogEntry(sessionId: string, world: World = REAL_WORLD): Json {
  const cached = world.memo.costLogEntry;
  if (cached && cached.sessionId === sessionId) return cached.entry;
  let lastEntry: Json = null; // stays null when the cost-log is absent — fail safe
  const raw = world.files.readText(world.paths.costLog);
  for (const rawLine of raw?.split('\n') ?? []) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      // isOwnTurn (lib/context-signal.ts) owns the match rule, shared with
      // doctor-check.ts's mirror of this scan so the two cannot drift on what
      // counts as this session's own turn.
      if (isOwnTurn(e, sessionId)) lastEntry = e;
    } catch {}
  }
  world.memo.costLogEntry = { sessionId, entry: lastEntry };
  return lastEntry;
}

// promptTokens (context size from a cost-log entry), isEstimateOnly and
// MAX_PLAUSIBLE_PROMPT_TOKENS now live in lib/context-signal.ts, shared with
// doctor-check.ts and cost-tracker.ts so they can't drift again.

/**
 * Why this cost-log entry must not drive a hygiene decision, or null when it may.
 *
 * Both tiers act on "the last cost entry for this session", which is only a proxy for
 * current context size. Two ways that proxy lies: the entry was observed before the
 * context was reset (it describes a context that no longer exists — measured live, where
 * a re-billed pre-compaction turn drove a compaction of a context 47k UNDER the
 * threshold), or the number itself is impossible. Both skip rather than guess: a real
 * turn produces a fresh entry within one wake.
 */
function poisonedEntrySkip(entry: Json, runtime: Json): PoisonReason | null {
  // observed_at is the source-side observation; the row's own timestamp is ingestion time,
  // which is fresh even on an entry describing an old context. Legacy rows have only the
  // latter — better than nothing, and they age out within a session.
  const observedAt: string = entry.observed_at ?? entry.timestamp ?? '';
  const resetAt: string = runtime.last_context_reset_at ?? '';
  if (observedAt && resetAt && observedAt < resetAt) return 'stale-entry';
  if (promptTokens(entry) > MAX_PLAUSIBLE_PROMPT_TOKENS) return 'aberrant-reading';
  return null;
}

/** The resident's own Claude Code session id, stamped by startup-context.ts under
 *  HERMIT_MANAGED. This is the ONLY acceptable identity for a hygiene decision.
 *
 *  Neither of the two ids this used to consult identifies a harness session:
 *  `runtime.session_id` is the S-NNN work-arc label, which cost-tracker stamps onto
 *  every session's rows while an arc is open, and `sessions/.status.json` is rewritten
 *  by whichever session's Stop hook fired last — a worktree guest, a hand-launched
 *  maintenance session, anyone in the folder. Measured live (issue #916): 13 of 14
 *  watchdog compactions read another session's context, citing 177k-272k while the
 *  resident sat at 67k-117k, and typed /compact into the resident's pane anyway.
 *
 *  Absent resolves to '' and both tiers skip. Skipping is the safe failure — acting on a
 *  frozen row from a session that is not this one is what #916 was. Two writers keep it
 *  present: the SessionStart hook stamps it at start/resume/compact/clear, and the Stop
 *  hook re-asserts it on each of the resident's own turns, so a resident already running
 *  when this version lands is unstamped for one turn rather than until its next restart.
 *  Both writers refuse when a live registry entry at another pid holds the stamp, which is
 *  what keeps a claude the resident launched itself from claiming the tiers. */
function resolveHygieneSessionId(runtime: Json, world: World = REAL_WORLD): string {
  const sid: unknown = runtime.cc_session_id;
  const resolved = typeof sid === 'string' ? sid : '';
  // Sole writer of the tick's identity, so every eval stamped after this point names
  // the session the reading came from without threading it through four helpers.
  world.memo.hygieneSessionId = resolved;
  return resolved;
}

/** The two ways a cost-log entry can be poisoned (see poisonedEntrySkip). Typed so
 *  the `skip:${PoisonReason}` template below stays a closed set. */
type PoisonReason = 'stale-entry' | 'aberrant-reading';

/** Closed registry of hygiene evaluation outcomes — every setHygieneEval call site
 *  resolves into this union, so hygiene_eval_counts has a fixed key set by
 *  construction (≤20 distinct strings across both mechanisms) and a typo'd or
 *  novel outcome is a compile error, not a silent new counter key. */
export type HygieneOutcome =
  | 'fired'
  | `skip:lifecycle:${GuardReason}`
  | `skip:${PoisonReason}`
  | 'skip:no-session-id'
  | 'skip:no-cost-entry'
  | 'skip:estimate-only'
  | 'skip:under-threshold'
  | 'skip:below-floor'
  | 'skip:interval-cooldown'
  | 'skip:midnight-adjacent'
  | 'skip:already-processed'
  | 'skip:quiescence-pending'
  | 'skip:lock-held';

/** Records this tick's hygiene outcome on a held watchdog-state object, keyed by
 *  mechanism, so the clear and compact tiers each keep their own most-recent eval.
 *  A single tick runs clear then compact; a shared slot would let compact's outcome
 *  clobber clear's every time compact is enabled, hiding the clear tier's skip/fire
 *  reason — the exact diagnosability this record exists to provide. The caller owns
 *  the subsequent writeWatchdogState (folds into a write it was already making).
 *
 *  Also increments hygiene_eval_counts[mechanism][outcome] — durable, monotonic
 *  FIRST-BLOCKER counters (each evaluation stamps exactly one outcome, the first
 *  guard that returned, not every simultaneously-binding constraint). Counts ≠
 *  scheduler ticks: disabled/invalid config, a missing runtime.json, post-close-clear
 *  ticks, and the process.exit(0) after a clear-tier fire all leave one or both
 *  mechanisms unstamped. Readers diff snapshots against `since` for rates. */
export function setHygieneEval(world: World, ws: Json, mechanism: 'clear' | 'compact', outcome: HygieneOutcome, promptTokensVal?: number, compactibleVal?: number): void {
  if (!ws.last_hygiene_eval || typeof ws.last_hygiene_eval !== 'object') ws.last_hygiene_eval = {};
  ws.last_hygiene_eval[mechanism] = {
    ts: worldStamp(world),
    outcome,
    // Which session's context this verdict describes. Absent until the tick's first
    // resolution; the clear tier runs before the compact tier, so a later compact skip
    // can carry an id its own gate never reached. Harmless — the resident's id does not
    // change mid-tick — and nothing branches on the field, it is forensics only.
    ...(world.memo.hygieneSessionId ? { cc_session_id: world.memo.hygieneSessionId } : {}),
    ...(promptTokensVal != null ? { prompt_tokens: promptTokensVal } : {}),
    ...(compactibleVal != null ? { compactible_tokens: compactibleVal } : {}),
  };
  if (!ws.hygiene_eval_counts || typeof ws.hygiene_eval_counts !== 'object') {
    ws.hygiene_eval_counts = { since: worldStamp(world), clear: {}, compact: {} };
  }
  if (!ws.hygiene_eval_counts[mechanism] || typeof ws.hygiene_eval_counts[mechanism] !== 'object') {
    ws.hygiene_eval_counts[mechanism] = {};
  }
  ws.hygiene_eval_counts[mechanism][outcome] = (ws.hygiene_eval_counts[mechanism][outcome] ?? 0) + 1;
}

/** stampHygieneEval that also returns the outcome, so an early-exit branch reads as
 *  `return stamped(...)` — one line per gate, and the outcome the gate decided on is
 *  the function's return value rather than something a test has to read back off disk. */
function stamped(world: World, mechanism: 'clear' | 'compact', outcome: HygieneOutcome, promptTokensVal?: number, compactibleVal?: number): HygieneOutcome {
  stampHygieneEval(world, mechanism, outcome, promptTokensVal, compactibleVal);
  return outcome;
}

/** Read-modify-write variant of setHygieneEval for early-exit branches that don't
 *  already hold a loaded watchdogState in hand. */
export function stampHygieneEval(world: World, mechanism: 'clear' | 'compact', outcome: HygieneOutcome, promptTokensVal?: number, compactibleVal?: number): void {
  const ws = readWatchdogState(world);
  setHygieneEval(world, ws, mechanism, outcome, promptTokensVal, compactibleVal);
  writeWatchdogState(ws, world);
}

/** stamped() for a branch that already holds a loaded watchdogState. Not stamped()
 *  itself: that re-reads state from disk, which would drop whatever the caller has
 *  already mutated in memory but not yet written — a freshly recorded pane hash,
 *  say — and silently cost a quiescence tick. */
function stampedState(world: World, ws: Json, mechanism: 'clear' | 'compact', outcome: HygieneOutcome, promptTokensVal?: number, compactibleVal?: number): HygieneOutcome {
  setHygieneEval(world, ws, mechanism, outcome, promptTokensVal, compactibleVal);
  writeWatchdogState(ws, world);
  return outcome;
}

// --- Context-size clear ---

/**
 * Runs before the watchdog.enabled gate — independent of watchdog restart behavior.
 * Sends /clear when the last hermit-owned turn exceeded a prompt-side token threshold
 * and the session is quiescent (pane unchanged across two consecutive ticks).
 * Guards: always-on only, no in-flight transition, operator silent ≥10 min, no shutdown.
 */
export function maybeContextClear(config: Json, world: World = REAL_WORLD): HygieneOutcome | null {
  const threshold = config.watchdog?.context_clear_tokens;
  if (typeof threshold !== 'number' || threshold <= 0) return null;

  const runtime = readRuntimeJson(world.paths.stateDir);
  if (!runtime) return null;

  const guard = passesLifecycleGuards(runtime, world);
  if (!guard.ok) return stamped(world, 'clear', `skip:lifecycle:${guard.reason}`);
  const sessionName = guard.sessionName;

  // Token check: find the last cost-log entry for this hermit session
  const sessionId = resolveHygieneSessionId(runtime, world);
  if (!sessionId) return stamped(world, 'clear', 'skip:no-session-id');

  const lastEntry = getLastCostLogEntry(sessionId, world);
  if (!lastEntry) return stamped(world, 'clear', 'skip:no-cost-entry');

  const poisoned = poisonedEntrySkip(lastEntry, runtime);
  if (poisoned) return stamped(world, 'clear', `skip:${poisoned}`, promptTokens(lastEntry));

  // Never fire the DESTRUCTIVE /clear on an estimated context size — the per-call mean
  // could sit either side of the 700k threshold. The non-destructive compact tier keeps
  // using the estimate (it self-corrects, and would compact the same context anyway one
  // turn later when a real entry lands).
  if (isEstimateOnly(lastEntry)) return stamped(world, 'clear', 'skip:estimate-only');

  const prompt = promptTokens(lastEntry);
  if (prompt <= threshold) return stamped(world, 'clear', 'skip:under-threshold', prompt);

  // Idempotence: bail if this entry was already cleared
  const watchdogState = readWatchdogState(world);
  if (watchdogState.last_cleared_cost_ts && watchdogState.last_cleared_cost_ts === lastEntry.timestamp) {
    return stampedState(world, watchdogState, 'clear', 'skip:already-processed', prompt);
  }

  // Quiescence guard: require pane unchanged across two consecutive ticks
  const currentHash = getPaneHash(sessionName, world);
  const prevHash = watchdogState.last_pane_hash_ctx ?? null;
  if (currentHash === null || currentHash !== prevHash) {
    // First qualifying tick — record hash and wait for next tick
    watchdogState.last_pane_hash_ctx = currentHash;
    return stampedState(world, watchdogState, 'clear', 'skip:quiescence-pending', prompt);
  }

  // Pane stable across two ticks — safe to clear
  if (!tryAcquireLifecycleLock(world)) {
    return stampedState(world, watchdogState, 'clear', 'skip:lock-held', prompt);
  }
  try {
    // Runtime stamp + breadcrumb + status-cache clear, shared with every other reset
    // path (lib/context-reset.ts). Runs BEFORE the destructive keystroke: PreCompact
    // never fires on /clear (see precompact-stamp.ts), so the breadcrumb is the only
    // trace, and an interrupted reset must still leave it. Fail-open internally — it
    // can never delay or suppress the safety clear below.
    applyContextReset(world.paths.hermitRoot, runtime, {
      kind: 'cleared',
      trigger: `watchdog-${Math.round(threshold / 1000)}k`,
      hhmm: nowHHMM(config.timezone ?? 'UTC', new Date(world.clock.nowMs())),
      tokens: prompt,
    });
    world.tmux.send(sessionName, '/clear');
    watchdogState.last_cleared_cost_ts = lastEntry.timestamp;
    // Cross-stamp: runtime.cc_session_id survives the reset (only the next
    // SessionStart restamps it), so the compact tier can still resolve this same
    // (now-destroyed) entry on the next tick — mark it consumed for compact too.
    // The stale-entry guard covers it as well; this is belt-and-braces redundancy.
    watchdogState.last_compacted_cost_ts = lastEntry.timestamp;
    watchdogState.last_pane_hash_ctx = null; // reset so next bloat cycle re-arms
    setHygieneEval(world, watchdogState, 'clear', 'fired', prompt);
    writeWatchdogState(watchdogState, world);
    appendEvent('context-clear', `prompt tokens ${prompt} over threshold ${threshold}, cc_session_id ${sessionId}`, world);
  } finally {
    releaseLock(lifecycleLockPath(world));
  }
  // The caller exits the tick on 'fired' (main step 0b) — returning it rather than
  // calling process.exit here keeps the fired path reachable from an in-process test.
  return 'fired';
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
 * Fires arc-preserving /compact at a low threshold (default 100k of estimated
 * compactible conversation — total prompt minus the recorded fixed-surface upper
 * bound, or minus the 50k cold-start assumption) so cold-cache wakes
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
export function maybeContextCompact(config: Json, world: World = REAL_WORLD): HygieneOutcome | null {
  const compactCfg = config.context_hygiene?.compact;
  if (!compactCfg || compactCfg.enabled !== true) return null;

  const threshold = compactCfg.min_context_tokens;
  if (typeof threshold !== 'number' || threshold <= 0) return null;

  const minIntervalSecs = parseDuration(compactCfg.min_interval ?? '4h');

  const runtime = readRuntimeJson(world.paths.stateDir);
  if (!runtime) return null;

  const guard = passesLifecycleGuards(runtime, world);
  if (!guard.ok) return stamped(world, 'compact', `skip:lifecycle:${guard.reason}`);
  const sessionName = guard.sessionName;

  // Boundary marker: a fresh marker keeps its interval-cooldown waiver until the
  // compact it enables actually fires (deleted in the success block below). The
  // two-tick quiescence gate lands a full tick after this read, so a fresh marker
  // consumed here would be gone before the pane is confirmed stable — wasting the
  // waiver in exactly the interval-cooldown case it exists for. A stale marker is
  // consumed on read so it can never linger into a later tick/arc.
  let boundaryWaive = false;
  const markerPath = path.join(world.paths.stateDir, 'compact-requested.json');
  const marker = world.files.readJson(markerPath);
  if (marker && typeof marker.requested_at === 'string') {
    const markerAge = ageSecs(marker.requested_at, world);
    if (markerAge !== null && markerAge <= COMPACT_MARKER_TTL_SECS) {
      boundaryWaive = true; // fresh — leave on disk until the compact fires or it goes stale
    } else {
      world.files.rm(markerPath); // stale — never let it linger
    }
  }

  // Midnight-adjacency suppression: the post-close /clear wipes context for free
  // right after daily-auto-close archives — a compact just before it is wasted spend.
  // Scoped to hermits that actually run that clear — with post_close_clear off no free
  // reset is coming at all, so there is nothing to wait for — and to a 10-minute window:
  // a wider one blanks the compact tier across the whole evening operator slot. The size
  // is borrowed from AUTO_CLOSE_LULL_MS, but this measures something else than the lull
  // does there (time until the close, not operator silence after it), so the edge is
  // pinned by its own callsite test at 11 minutes out, not by the lull constant.
  if (config.post_close_clear === true
      && isNearDailyAutoClose(config, AUTO_CLOSE_LULL_MS / 1000, new Date(world.clock.nowMs()))) {
    return stamped(world, 'compact', 'skip:midnight-adjacent');
  }

  // Token check: find the last cost-log entry for this hermit session
  const sessionId = resolveHygieneSessionId(runtime, world);
  if (!sessionId) return stamped(world, 'compact', 'skip:no-session-id');

  const lastEntry = getLastCostLogEntry(sessionId, world);
  if (!lastEntry) return stamped(world, 'compact', 'skip:no-cost-entry');

  const poisoned = poisonedEntrySkip(lastEntry, runtime);
  if (poisoned) return stamped(world, 'compact', `skip:${poisoned}`, promptTokens(lastEntry));

  const prompt = promptTokens(lastEntry);

  // Conversation gate (PROP-076): subtract the hermit's recorded fixed-surface
  // upper bound (state/context-surface.json, derived by cost-tracker at each
  // compaction boundary) — or the 50k cold-start assumption before the first
  // measurement — so min_context_tokens denominates estimated compactible
  // conversation rather than total prompt. Total prompt included a per-hermit
  // fixed surface compaction cannot reclaim, which made one configured number
  // fire at very different conversation sizes per hermit and silently tighten
  // as plugins/memory grew. The recorded value is an upper bound (it carries
  // post-boundary wake messages), so `compactible` is a lower bound: the gate
  // errs toward compacting later, never earlier.
  const surface = readContextSurface(world.paths.hermitRoot);
  const compactible = compactibleTokens(lastEntry, surface?.surface_upper_bound_tokens ?? null);

  // Token floor: never compact away a small compactible conversation, even with a
  // boundary marker in play — same units as the threshold above.
  if (compactible < MIN_COMPACT_FLOOR_TOKENS) return stamped(world, 'compact', 'skip:below-floor', prompt, compactible);
  if (compactible <= threshold) return stamped(world, 'compact', 'skip:under-threshold', prompt, compactible);

  const watchdogState = readWatchdogState(world);

  // Quiescence tracking: record the pane hash on every qualifying tick, independent
  // of whether interval/idempotence will end up blocking. If recording were gated
  // behind those checks, a single interval-blocked tick would erase the "pane
  // observed stable" progress and cost an extra tick once the interval reopened
  // (e.g. via a boundary marker) — even though the pane never actually moved.
  // Own hash key (last_pane_hash_compact) so this tracker never collides with
  // maybeContextClear's (last_pane_hash_ctx) — both can be mid-cycle at once.
  const currentHash = getPaneHash(sessionName, world);
  const prevHash = watchdogState.last_pane_hash_compact ?? null;
  const paneStable = currentHash !== null && currentHash === prevHash;
  if (currentHash !== prevHash) {
    watchdogState.last_pane_hash_compact = currentHash;
    writeWatchdogState(watchdogState, world);
  }

  // Interval cooldown — waived only by a fresh boundary marker
  if (!boundaryWaive && watchdogState.last_compacted_at) {
    const sinceLast = ageSecs(watchdogState.last_compacted_at, world);
    if (sinceLast !== null && sinceLast < minIntervalSecs) {
      return stampedState(world, watchdogState, 'compact', 'skip:interval-cooldown', prompt, compactible);
    }
  }

  // Idempotence: bail if this cost-log entry was already compacted
  if (watchdogState.last_compacted_cost_ts && watchdogState.last_compacted_cost_ts === lastEntry.timestamp) {
    return stampedState(world, watchdogState, 'compact', 'skip:already-processed', prompt, compactible);
  }

  if (!paneStable) {
    return stampedState(world, watchdogState, 'compact', 'skip:quiescence-pending', prompt, compactible);
  }

  // Pane stable across two ticks — safe to compact
  if (!tryAcquireLifecycleLock(world)) {
    return stampedState(world, watchdogState, 'compact', 'skip:lock-held', prompt, compactible);
  }
  try {
    // session_state is read at fire time; boundaryWaive was resolved at the top of this
    // same tick and the marker is still on disk, so both halves describe this instant.
    // A marker that went stale between the two quiescence ticks was consumed on the
    // second read, which correctly demotes the flavor to mid-arc.
    const flavor = compactFlavor(runtime.session_state, boundaryWaive);
    world.tmux.send(sessionName, composeCompactSteeringMessage(flavor));
    watchdogState.last_compacted_cost_ts = lastEntry.timestamp;
    watchdogState.last_compacted_at = worldStamp(world);
    watchdogState.last_pane_hash_compact = null; // reset so next bloat cycle re-arms
    setHygieneEval(world, watchdogState, 'compact', 'fired', prompt, compactible);
    writeWatchdogState(watchdogState, world);
    world.files.rm(markerPath); // consume the boundary waiver now that it fired
    // Both token counts travel in the event so the next cost-log entry gives a
    // before/after for free — feeds /hermit-evolution and threshold calibration.
    appendEvent('context-compact', `prompt tokens ${prompt} (compactible ~${compactible}) over threshold ${threshold}, flavor ${flavor}, cc_session_id ${sessionId}`, world);
  } finally {
    releaseLock(lifecycleLockPath(world));
  }
  // The caller exits the tick on 'fired' (main step 0c) — see maybeContextClear.
  return 'fired';
}

// --- Pause enforcement (PROP-015) ---

/**
 * Escape-to-pane while paused. The PreToolUse gate (pause-gate.ts) blocks the
 * model's *next* tool call the instant state/pause.json is set, but the
 * currently in-flight call (if any) runs to completion — tmux Escape kills it
 * immediately (probe-verified: compiled/spike-channel-stop-probe-2026-07-03.md).
 * Runs independent of watchdog.enabled, like 0a-0c — pause must interrupt
 * whether or not wedge-detection/nudging is turned on.
 *
 * Deliberately does NOT reuse passesLifecycleGuards()'s operator-recency
 * backoff: pause is an explicit override that must act immediately, not defer
 * because the operator/sender was just active — recency is exactly what a
 * "stop" is responding to.
 *
 * One-shot per pause episode: setPause() stamps a fresh `ts` on every call, so
 * comparing against the last-escaped ts (persisted in watchdog-state.json)
 * sends Escape once per pause, not every tick — repeat Escapes would also
 * interrupt the reply the paused hermit is still allowed to send.
 */
function maybeEscapePausedSession(timezone: string): void {
  const status = isPaused(HERMIT_ROOT);
  if (!status.paused) return;

  const runtime = readRuntimeJson();
  if (!runtime) return;
  if (runtime.runtime_mode === 'interactive') return; // never auto-manage an attended session
  if (runtime.transition) return; // archiving/cleaning recovery mid-flight
  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) return;
  if (runtime.session_state !== 'in_progress') return; // nothing plausibly in flight

  const sessionName: string = runtime.tmux_session ?? '';
  if (!sessionName || !tmuxSessionAlive(sessionName)) return;

  const watchdogState = readWatchdogState();
  // Dedup per pause episode by the flag's `ts`. Fall back to a fixed sentinel
  // for a ts-less flag (hand-crafted/partial write) so the guard still fires
  // exactly once — a bare `status.ts` comparison would read undefined === undefined
  // as "already escaped" on the first tick and skip the interrupt entirely.
  const episodeKey = status.ts ?? 'no-ts';
  if (watchdogState.last_escaped_pause_ts === episodeKey) return; // already escaped this episode

  spawnSync('tmux', ['send-keys', '-t', sessionName, 'Escape'], { stdio: 'ignore' });
  watchdogState.last_escaped_pause_ts = episodeKey;
  writeWatchdogState(watchdogState);
  appendEvent('pause-enforced', status.reason ?? 'operator');
  pushOperatorMessage(composePauseMessage(status.reason ?? 'operator', status.until ?? null, timezone));
}

// --- Main decision loop ---

async function main(): Promise<void> {
  if (!fs.existsSync(CONFIG_PATH)) process.exit(0); // absence: not a hermit project
  const config: Json = readSettledConfig(HERMIT_ROOT); // malformed settles to defaults

  // 0. Liveness stamp — record that the scheduler/loop invoked us, before any gate or
  // pre-gate handler (which can process.exit(0)). A fresh last_run proves the watchdog
  // is firing (systemd/launchd/cron or the Docker entrypoint loop); doctor reads it as
  // the liveness signal. Stamped even when watchdog.enabled is false.
  const liveness = readWatchdogState();
  liveness.last_run = utcStamp();
  writeWatchdogState(liveness);

  // Pause enforcement (PROP-015) — independent of watchdog.enabled; see
  // maybeEscapePausedSession for why this doesn't wait for the later
  // config/runtime gates below.
  const timezone = config.timezone ?? 'UTC';
  OPERATOR_LOCALE = resolveLocale(config.language); // pins the locale for every compose call below
  maybeEscapePausedSession(timezone);

  // 0a. Post-close clear — independent of watchdog.enabled; runs on any hermit with a scheduler
  maybePostCloseClear(config);

  // 0b. Context-size clear — independent of watchdog.enabled; runs on any always-on hermit.
  // A fired clear ends the tick: the context it was measuring no longer exists, so every
  // gate below would be deciding on a stale reading.
  if (maybeContextClear(config) === 'fired') process.exit(0);

  // 0c. Routine-hygiene compact — independent of watchdog.enabled; runs on any always-on
  // hermit. Evaluated after the emergency clear so a 700k context takes the /clear path,
  // not compact, on the same tick.
  if (maybeContextCompact(config) === 'fired') process.exit(0);

  // 0d. Telemetry export — independent of watchdog.enabled, like 0a-0c; opt-in via
  // config.telemetry_export. Self-gates on enabled + interval and always returns
  // (never process.exit(0)) so it can't skip steps 1-5 below.
  //
  // Wall-capped so a slow/hung endpoint can't delay dead-session recovery (steps
  // 3-5) — recovery is the core promise; telemetry is a best-effort nicety. The
  // cap equals one POST timeout, so the fresh bundle POST completes-or-times-out
  // within it (recording its own state); only a multi-bundle spool drain can be
  // cut short, and those bundles simply retry next tick. Left unawaited past the
  // cap, so it doesn't block the tick further. (A full reorder is avoided because
  // telemetry must run even when the watchdog is disabled, whereas recovery is
  // gated on watchdog.enabled below.)
  const TELEMETRY_WALL_MS = Number(process.env.HERMIT_TELEMETRY_TIMEOUT_MS) || 5000;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  const telemetryResult = await Promise.race([
    runTelemetryExportIfDue(config, HERMIT_ROOT).finally(() => { if (wallTimer) clearTimeout(wallTimer); }),
    new Promise<{ ran: boolean; ok?: boolean; detail?: string }>((resolve) => {
      wallTimer = setTimeout(() => resolve({ ran: false, detail: 'deferred (wall-cap)' }), TELEMETRY_WALL_MS);
      // Don't let the cap timer itself hold the process open when telemetry isn't due.
      if (typeof wallTimer.unref === 'function') wallTimer.unref();
    }),
  ]);
  if (telemetryResult.ran) {
    appendEvent('telemetry-export', telemetryResult.ok ? 'success' : (telemetryResult.detail ?? 'failed'));
  }

  // 0e. State backup — independent of watchdog.enabled, like 0a-0d; opt-in via
  // config.backup. Self-gates on the cron cursor and spawns a detached child, so
  // a slow push can never delay steps 1-6 below.
  maybeSpawnBackup(config);

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

  // The session's launch environment, adopted before any auth decision below.
  adoptSessionConfigDir(runtime);
  const sessionEnvAuth = typeof runtime.env_auth === 'boolean' ? runtime.env_auth : null;
  // Read once per tick, AFTER the config dir is adopted (the registry lives
  // under it) and shared by 3b and step 4.
  const resident = resolveResident(runtime);

  // 2. Shutdown-intent gate — never resurrect a deliberately-stopped hermit.
  //
  // `session_state: 'idle'` used to exit here outright. It cannot: 'in_progress' is written
  // only by the model-driven /session-start open path (session-archive.ts), and session-close
  // returns it to 'idle', so a healthy hermit rests at 'idle' between arcs. Exiting on it
  // disabled the alert tiers (3b/3c) on every hermit, permanently — and self-sealingly, since
  // leaving 'idle' requires the model to take a turn, which is exactly what a blocking dialog
  // prevents. A session blocked that way stayed blocked indefinitely, in silence.
  //
  // So 'idle' now demotes the tick to supervision-only: the alert-only tiers still run and
  // still notify, while every tier that sends keystrokes or restarts stays suppressed. The
  // explicit stop markers below remain hard exits — those DO carry operator intent.
  const supervisionOnly = runtime.session_state === 'idle';
  if (runtime.shutdown_requested_at || runtime.shutdown_completed_at) process.exit(0);
  if (runtime.runtime_mode === 'interactive') process.exit(0);

  const sessionName = runtime.tmux_session ?? '';
  if (!sessionName) process.exit(0);

  const sessionState = runtime.session_state ?? '';

  // 3. Dead-session detection
  // Deliberately NOT gated on isPaused() (PROP-015): the channel MCP plugin
  // lives inside the session, so a dead+paused session can't hear "resume" —
  // restart must stay live. The PreToolUse gate (pause-gate.ts) keeps the
  // restarted session inert until resumed.
  //
  // The verdict is cached: step 3c below asks the identical `tmux has-session` question
  // about the same session moments later, and nothing in between mutates tmux state
  // (evaluateReauth only spawns a detached relay, capturePane is a read-only subcommand).
  // Recomputing it there would spawn tmux twice per tick on the common alive path.
  let sessionAlive: boolean | null = null;
  if (['in_progress', 'waiting', 'suspect_process'].includes(sessionState)) {
    sessionAlive = tmuxSessionAlive(sessionName);
    if (!sessionAlive) {
      // A gone tmux session with FRESH shared-state activity is the orphan shape
      // (process survived, tmux didn't) — restarting would spawn a second claude
      // beside the live one. Abort and alert instead; only restart when the
      // signal is stale, i.e. the old process really is dead.
      const age = sharedLivenessAgeSecs();
      const ws = readWatchdogState();
      const looksAlive = age !== null && age < LIVENESS_FRESH_SECS;
      if (looksAlive && !ws.orphan_notified) {
        pushOperatorMessage(composeOrphanMessage(timezone));
        appendEvent('restart-aborted', 'liveness-fresh-no-tmux');
        ws.orphan_notified = true;
        writeWatchdogState(ws);
      }
      if (looksAlive) process.exit(0);
      if (ws.orphan_notified) {
        ws.orphan_notified = false;
        writeWatchdogState(ws);
      }
      await doRestart(sessionName, 'dead-process', runtime, timezone, config);
      process.exit(0);
    }
  }

  // The pane is read once here and shared by 3a, 3a-bis and 3b. It has to come before
  // 3a because the pane carries the only signal that a *token* died early — before the
  // recorded expiry — which 3a now accepts as a trigger.
  const paneContent = capturePane(sessionName);
  const authLapsed =
    paneContent !== null && hasLapsedLogin(paneContent) && !envAuthOwnsCredential(sessionEnvAuth);

  // 3a. Re-auth relay — runs after dead-session restart on purpose (see the
  // block comment above evaluateReauth). While a relay is in flight the session
  // can't do useful work, so the nudge/wedge tiers below are suppressed: they'd
  // be noise, and an escalated restart mid-flow would churn the session the
  // relay is about to bounce itself.
  const reauth = evaluateReauth(config, authLapsed, sessionEnvAuth);
  if (reauth === 'spawned' || reauth === 'active') process.exit(0);

  // 3a-bis. The same lapse on a hermit the relay cannot reach — no channel, or one
  // whose send failed. There is no deterministic recovery there: the sign-in link has
  // nowhere to go, so the whole tier is one notice, and then silence. Restarting or
  // nudging a session that cannot authenticate only produces churn and misleading
  // "I restarted your hermit" pushes, which is what this hermit did before.
  //
  // Keyed on the relay's own verdict rather than on the auth mode: a login-mode hermit
  // WITH a working channel is now recoverable (evaluateReauth spawns the relay above
  // and returns 'spawned'), so mode is no longer what decides whether help is possible.
  //
  // Re-arming is keyed on a usable credential returning, never on the pane clearing.
  // Two reasons, both observed: the error scrolls off as soon as anything else renders,
  // and a failed refresh rewrites .credentials.json into an empty stub — so mtime moves
  // and the file still exists while the hermit stays just as dead. `notified_at` also
  // ages out after a day, so a lapse nobody has fixed says so again tomorrow rather
  // than going quiet forever.
  if (authLapsed && reauth === 'unreachable') {
    const ws = readWatchdogState();
    const notifiedAt = typeof ws.lapsed_login_notified_at === 'string' ? ws.lapsed_login_notified_at : null;
    const age = notifiedAt ? ageSecs(notifiedAt) : null;
    const stale = age === null || age > 24 * 3600;
    if (stale) {
      pushOperatorMessage(composeLapsedLoginMessage(timezone));
      appendEvent('lapsed-login-detected', notifiedAt ? 'still lapsed after 24h' : 'auth failure on pane, no token to mint');
      ws.lapsed_login_notified_at = worldStamp(REAL_WORLD);
      writeWatchdogState(ws);
    }
    process.exit(0);
  }

  // 3a-ter. The session's own environment owns the credential (API key, bearer token,
  // Bedrock/Vertex/Foundry), so its 401 is not a lapsed login and 3a/3a-bis correctly sat
  // out. It still has to stop the tick. Falling through would reach the pane-frozen
  // restart, and doRestart spawns hermit-start with this process's environment — on a host
  // unit carrying only PATH, that forwards no ANTHROPIC_API_KEY and nothing re-derives one
  // (unlike the setup token, which hydrateSetupTokenEnv reads back off disk). The restarted
  // session would come up with no credential at all, show the same failing pane, and be
  // restarted again on the next escalation: a loop that strips the key and never recovers.
  // Suppressing here is the fix, because the credential lives somewhere the hermit cannot
  // reach — runtime.json stamps a path and a boolean, never a secret.
  const envAuthFailing =
    paneContent !== null && hasLapsedLogin(paneContent) && envAuthOwnsCredential(sessionEnvAuth);
  if (envAuthFailing) {
    const ws = readWatchdogState();
    const notifiedAt =
      typeof ws.env_auth_failure_notified_at === 'string' ? ws.env_auth_failure_notified_at : null;
    const age = notifiedAt ? ageSecs(notifiedAt) : null;
    if (age === null || age > 24 * 3600) {
      pushOperatorMessage(composeEnvAuthFailureMessage(timezone));
      appendEvent('env-auth-failure-detected', notifiedAt ? 'credential still rejected after 24h' : 'auth failure on pane, credential owned by the session env');
      ws.env_auth_failure_notified_at = worldStamp(REAL_WORLD);
      writeWatchdogState(ws);
    }
    // Unconditional: the exit IS the suppression, whether or not a notice was due.
    process.exit(0);
  }

  // Both recoveries share one state read. This point is reached on every ordinary healthy
  // tick, and `!hasLapsedLogin(paneContent)` already forces `authLapsed` false — the one
  // case where it would not is envAuthFailing, which exited above — so reading the file
  // once per check billed the common path twice for nothing.
  //
  // A cleared pane is the only recovery signal available for the env-auth stamp: there is
  // no storedLoginUsable() equivalent for a key held in the operator's shell, which the
  // watchdog cannot see even when it is working.
  if (!authLapsed) {
    const ws = readWatchdogState();
    let recovered = false;
    if (paneContent !== null && !hasLapsedLogin(paneContent) && ws.env_auth_failure_notified_at) {
      delete ws.env_auth_failure_notified_at;
      appendEvent('env-auth-failure-recovered', 'pane no longer shows an auth failure');
      recovered = true;
    }
    const loginUsable = storedLoginUsable(defaultConfigDir());
    if (ws.lapsed_login_notified_at && loginUsable) {
      delete ws.lapsed_login_notified_at;
      appendEvent('lapsed-login-recovered', 'usable stored login present again');
      recovered = true;
    }
    // The unreachable stamp is a suppression, so it has to be cleared by the same
    // signal that ends the lapse — otherwise a hermit whose channel came back would
    // stay silently suppressed until the 24h age-out.
    //
    // Keyed on the reauth verdict rather than on a stored login: 'idle' means the
    // credential this hermit actually runs on is neither expired nor lapsed, in
    // whatever mode. storedLoginUsable() alone would never clear it in token mode,
    // where the login file is parked by construction.
    if (reauth === 'idle') {
      try {
        fs.unlinkSync(RELAY_UNREACHABLE_JSON);
      } catch {}
    }
    if (recovered) writeWatchdogState(ws);
  }

  // 3b. Stall-question detection (PROP-024) — catches the un-redirectable remainder
  // the AskUserQuestion PreToolUse gate (ask-gate.ts) can't reach: native permission
  // dialogs and harness-rendered prompts below the tool layer. Notify only, once per
  // episode (re-arms when the pane clears) — never auto-answer or send Escape, that's
  // always the operator's call.
  //
  // The registry's `waiting` status is the shape-independent second trigger:
  // the harness sets it for any permission dialog, so a modal whose footer the
  // pane scanner above doesn't recognise — a future CC release's, or one that
  // scrolled — is still caught, and caught by the session's own account of
  // itself rather than by a regex over rendered text.
  //
  // Bounded, unlike the pane leg. Both suppress the restart tiers below, but the
  // pane leg fires on modals the operator is watching, while this one fires on the
  // ones nothing else recognises — where step 11's pane-frozen restart used to be
  // the only thing that ever cleared them on an unattended hermit. `statusUpdatedAt`
  // dates the current state, so it is the dialog's own age: honour it for a day,
  // then let that tier reclaim the session.
  const registryWaiting =
    resident?.status === 'waiting' && Date.now() - resident.statusUpdatedAt < 24 * 3600 * 1000;
  const pendingQuestion = (paneContent !== null && hasPendingQuestion(paneContent)) || registryWaiting;
  {
    const watchdogState = readWatchdogState();
    if (pendingQuestion) {
      if (!watchdogState.stall_question_notified) {
        const paneTail = paneContent !== null ? nonBlankTail(paneContent, 8) : undefined;
        pushOperatorMessage(composeStallQuestionMessage(timezone, OPERATOR_LOCALE, paneTail));
        appendEvent('stall-question-detected', registryWaiting ? 'pending dialog, session alive — via registry' : 'pending dialog on pane, session alive');
        watchdogState.stall_question_notified = true;
        writeWatchdogState(watchdogState);
      }
    } else if (watchdogState.stall_question_notified) {
      watchdogState.stall_question_notified = false;
      writeWatchdogState(watchdogState);
    }
  }

  // 3c. Queue-liveness wedge detection — the shape-independent net behind 3b. Whatever
  // holds stdin (a dialog 3b's pane scanner doesn't recognise, a modal from a future CC
  // release), the harness keeps enqueueing monitor notifications it never dequeues.
  // Alert-only, deduped like 3b: the operator decides how to clear it, and sending keys
  // into an unknown blocker is exactly the auto-answer 3b refuses to do.
  //
  // The tmux check is load-bearing, not decorative: a wedge means "the session is UP but not
  // draining". A stopped hermit's last transcript record is often a trailing enqueue that was
  // never drained, which classifies as 'wedged' forever. This tier used to reach that case
  // only because the idle gate above exited first; now that it doesn't, the aliveness
  // condition this tier always documented has to actually be tested. 3b needs no equivalent —
  // capturePane returns null on a dead session and the `paneContent !== null` check catches it.
  // Reuses step 3's verdict when it ran; falls back to a fresh check when it didn't —
  // 'idle' (the path this fix enables) and any other unlisted session_state. The fallback
  // is cached back, not discarded: on an idle arc step 3 never ran, so this is the tick's
  // only has-session call and step 5 below reuses it rather than spawning tmux again.
  sessionAlive = sessionAlive ?? tmuxSessionAlive(sessionName);
  if (sessionAlive) {
    // `opened_transcript` — the CC transcript UUID that names the .jsonl file.
    // `session_id` is the logical S-NNN arc id and resolves to a path that never exists.
    const transcriptId = typeof runtime.opened_transcript === 'string' ? runtime.opened_transcript : null;
    const tail = readTranscriptTail(transcriptId);
    const verdict = tail === null ? 'unknown' : classifyQueueTail(tail, Date.now());
    const watchdogState = readWatchdogState();
    if (verdict === 'wedged') {
      if (!watchdogState.session_wedged_notified) {
        pushOperatorMessage(composeSessionWedgedMessage(timezone));
        appendEvent('session-wedged', 'queued notifications not draining, session alive');
        watchdogState.session_wedged_notified = true;
        writeWatchdogState(watchdogState);
      }
    } else if (watchdogState.session_wedged_notified) {
      // Re-arm on ANY non-wedged verdict, 'unknown' included: a restart starts a fresh
      // transcript with no queue records yet, and holding the flag through that would
      // suppress the NEXT genuine wedge — the silent stall this check exists to prevent.
      watchdogState.session_wedged_notified = false;
      writeWatchdogState(watchdogState);
    }

    // 3d. Upstream API failure — visibility only, nothing suppressed or restarted.
    // The agent already recovers on its own (heartbeat-monitor.sh's `--peek` poll is
    // read-only, so a failed turn leaves the next wake due), so this exists purely so
    // an operator watching from Discord can tell "Claude is down" from "my agent is
    // broken". Reuses the same tail read above; auth failures return null here and
    // are left to the lapsed-login/env-auth tiers so one event isn't notified twice.
    //
    // Two sources, newest wins. CC's StopFailure hook stamps the typed `error` for the
    // turn that just failed, which is the category itself rather than a regex over
    // rendered text — but only while a session is alive to fire hooks, so the transcript
    // scan stays the source for a dead-session post-mortem and for any episode that
    // predates the stamp.
    const stamp = readStopFailureStamp();
    const stampAt = stamp ? Date.parse(String(stamp.at ?? '')) : NaN;
    const newestRecord = tail === null ? null : newestAssistantRecord(tail);
    // Compared at whole-second granularity: `at` is a localISOStamp (seconds), while a
    // transcript record carries milliseconds and CC writes that record just BEFORE firing
    // the hook (22ms earlier when probed). A strict `>` on the truncated value therefore
    // loses the same-second tie the stamp always creates, and the stamp path would only
    // ever win when the record and the hook straddle a second boundary. The cost is up to
    // one second of ambiguity in the other direction, far below any real episode gap.
    const stampIsNewer = !Number.isNaN(stampAt)
      && (newestRecord === null || stampAt + 999 >= newestRecord.ts);
    let apiFailure: ApiFailureVerdict | null;
    if (stampIsNewer) apiFailure = classifyStopFailureStamp(stamp);
    else if (newestRecord === null) apiFailure = null;
    else apiFailure = verdictFromAssistantRecord(newestRecord.rec);
    if (apiFailure) {
      if (!watchdogState.api_failure_notified_at) {
        pushOperatorMessage(composeApiFailureMessage(apiFailure, timezone));
        appendEvent('api-failure', apiFailure.kind);
        watchdogState.api_failure_notified_at = worldStamp(REAL_WORLD);
        writeWatchdogState(watchdogState);
      }
    } else if (tail !== null && watchdogState.api_failure_notified_at) {
      // Re-arm once a newer, healthy assistant record supersedes the failure, so a later
      // episode can notify again. Unlike the session-wedged re-arm above, an unreadable
      // tail must NOT re-arm: a restart mid-episode leaves `opened_transcript` pointing at
      // a file that doesn't exist yet, and clearing the stamp there would push a second
      // notice for the same still-active outage on the very next tick.
      delete watchdogState.api_failure_notified_at;
      writeWatchdogState(watchdogState);
    }
  }

  // A pane stalled on a pending prompt is not a wedge — the operator has just been
  // notified above (once per episode). Stop here: never fall through to the wedge
  // nudge (step 4) or the monitor re-arm (step 5), both of which send keystrokes
  // into the pane. On a focused permission / AskUserQuestion modal those keystrokes
  // (a command string then Enter) would confirm the highlighted default option, or
  // the pane-frozen restart path would kill the session outright — either way
  // auto-answering a decision that is always the operator's to make.
  if (pendingQuestion) process.exit(0);

  // Supervision-only scope. An idle session arc suppresses step 4 — the wedge nudge and the
  // pane-frozen restart, the two tiers that act on a pane whose intent the watchdog cannot
  // read. It does NOT suppress the re-arm injections in step 5: a hermit rests at
  // 'idle' between arcs, so that is exactly where a dead heartbeat/routine Monitor has to be
  // recovered from, and until this it was not — the only recovery was the daily
  // heartbeat-restart anchor, a CronCreate that dies with the process it was registered in,
  // i.e. in the same event that kills the monitors. That step carries its own guards
  // (pause, dead tmux, operator-recency, a per-monitor damper) and injects only slash commands
  // whose skills are stop-then-start idempotent, so a re-arm cannot stack duplicate Monitors.
  //
  // "Never resurrect a deliberately-stopped hermit" still holds: hermit-stop stamps
  // shutdown_completed_at, which step 2 hard-exits on — a stopped hermit is never merely
  // 'idle'. Step 3's dead-session restart needs no guard either: its state whitelist
  // (in_progress / waiting / suspect_process) already excludes 'idle'.
  //
  // Step 3a can also reach a restart from an idle arc: the re-auth relay's `finish` verb
  // calls requestRestart() once the operator has completed the browser sign-in. That is
  // deliberate — an expired setup-token strands a RESTING hermit just as hard as a working
  // one, and the restart only follows the operator acting on the relay's message.

  // 4. Wedge detection (only when heartbeat is enabled + within active hours, and never on an
  //    idle arc — see the supervision-only scope note above)
  const heartbeatCfg = config?.heartbeat ?? {};
  const heartbeatIsObj = heartbeatCfg && typeof heartbeatCfg === 'object' && !Array.isArray(heartbeatCfg);
  if (!supervisionOnly && heartbeatIsObj && ('enabled' in heartbeatCfg ? heartbeatCfg.enabled : true)) {
    const activeHours = heartbeatCfg.active_hours;
    const activeHoursIsObj = activeHours && typeof activeHours === 'object' && !Array.isArray(activeHours);
    if (!activeHoursIsObj || inActiveHours(activeHours, config.timezone ?? 'UTC')) {
      const heartbeatEverySecs = parseDuration(heartbeatCfg.every ?? '30m');
      const wedgeFloorSecs = parseDuration(watchdogCfg.wedge_floor ?? WEDGE_FLOOR_DEFAULT);
      const staleThresholdSecs = Math.max(heartbeatEverySecs * staleFactor, wedgeFloorSecs);

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

          const monitorDead = heartbeatMonitorDead();

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
            await doRestart(sessionName, 'pane-frozen', runtime, timezone, config);
            // doRestart kills the tmux session and spawns a detached replacement, so the
            // verdict cached at step 3c is stale from here on. Step 5 below sends
            // keys into this pane and guards on it: reusing the pre-restart `true` would
            // inject slash commands into a killed (or still-booting) session and burn the
            // per-monitor re-arm damper for 6h on a send that never landed.
            sessionAlive = tmuxSessionAlive(sessionName);
          } else {
            await doNudge(sessionName, watchdogState, consecutive, currentPaneHash, timezone, staleThresholdSecs, { inboxSocket: resolveInboxSocket(runtime), resident });
          }
        } else {
          // Heartbeat recovered — reset the episode and re-arm the wedge push so a
          // genuinely new wedge later can notify again. Clearing last_nudge_at re-arms
          // the nudge throttle for the same reason: a new episode's first probe should
          // fire immediately, not wait out the previous episode's window.
          const recovered = watchdogState.wedge_notified === true;
          watchdogState.consecutive_stale = 0;
          watchdogState.wedge_notified = false;
          watchdogState.wedge_escalated = false;
          watchdogState.last_nudge_at = null;
          // Same re-arm, for the transport alternation: the next episode's first
          // probe should try the socket again, not inherit this one's fallback.
          watchdogState.last_nudge_transport = null;
          watchdogState.last_pane_hash = currentPaneHash;
          writeWatchdogState(watchdogState);
          // Flag cleared before the send, as doNudge does: pushOperatorMessage blocks
          // for up to 12s, and a tick killed inside that window would otherwise leave
          // wedge_notified set and repeat the all-clear on the next tick.
          if (recovered) {
            pushOperatorMessage(composeWedgeRecoveredMessage(timezone));
            appendEvent('wedge-recovered', 'heartbeat fresh');
          }
        }
      }
    }
  }

  // 5. Liveness-keyed monitor re-arm: recover a heartbeat/routine Monitor that died
  // mid-session, detected via its stale liveness file — ground truth the monitors
  // stamp themselves, never a model-issued routine metric.
  maybeMonitorRearm(config, sessionName, sessionAlive, operatorGraceSecs);
}

// --- Install / uninstall ---

/** Read tmux session name from config for install commands. */
function getSessionName(): string {
  if (!fs.existsSync(CONFIG_PATH)) return 'hermit';
  return deriveSessionName(readSettledConfig(HERMIT_ROOT));
}

/** Locate state-templates/watchdog/ relative to this script's plugin root. */
function findTemplatesDir(): string | null {
  const candidate = path.resolve(import.meta.dir, '..', 'state-templates', 'watchdog');
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {}
  return null;
}

/**
 * The PATH to bake into generated units.
 *
 * systemd user services, launchd agents and cron all run with an environment
 * that does not carry ~/.bun/bin, so the bare `bun` at the end of the
 * hermit-watchdog shim exits 127 on every tick — silently, forever. Baking a
 * PATH fixes that, but a hardcoded directory list cannot: it varies by OS, by
 * architecture (Intel vs Apple Silicon homebrew prefixes) and by how the
 * operator installed each tool. Snapshotting the installer's own environment is
 * correct by construction — cmdInstall runs under bun in the operator's shell,
 * so process.execPath is exactly the bun being used and process.env.PATH is an
 * environment where claude and tmux resolve too. The restart path needs those:
 * hermit-start's preflight hard-fails without them.
 */
function resolveUnitPath(): string {
  const seen = new Set<string>();
  const out: string[] = [];
  // Absolute entries only: a relative one (npm/bun script wrappers prepend
  // `node_modules/.bin`) would resolve against the unit's WorkingDirectory —
  // the project root — turning a repo-writable dir into a lookup path the
  // watchdog consults every five minutes.
  for (const entry of [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)]) {
    if (!entry || !path.isAbsolute(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(path.delimiter);
}

// One value, three renderers, three escaping grammars. systemd expands
// %-specifiers in unit files, so a literal percent must be doubled
// (systemd.unit(5)). cron converts an unescaped % to a newline and feeds
// everything after it to the command as stdin, truncating the line
// (crontab(5)). The plist value sits inside an XML <string>. Applied to every
// substituted value, not just PATH — a project path can carry the same
// characters.
const escapeSystemd = (v: string) => v.replaceAll('%', '%%');
const escapeCron = (v: string) => v.replaceAll('%', '\\%');
const escapeXml = (v: string) =>
  v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function printCronFallback(root: string, unitPath: string): void {
  // The assignment must sit on the watchdog invocation itself: a shell
  // assignment prefix applies only to the single command it precedes, and `cd`
  // is a builtin, so `PATH=... cd x && cmd` leaves cmd on cron's default PATH.
  const cronLine =
    `*/5 * * * * cd "${escapeCron(root)}" && PATH="${escapeCron(unitPath)}" ` +
    `.claude-code-hermit/bin/hermit-watchdog run ` +
    `2>>.claude-code-hermit/state/watchdog.log`;
  console.log('[watchdog] Add the following line via `crontab -e`:');
  console.log(`  ${cronLine}`);
  // In the Docker container this same fallback prints from the "systemctl not found"
  // branch, where /docker-setup has already set enabled: true — so only say it when it
  // is actually false.
  if (readWatchdogEnabled() === false) console.log(ENABLE_GUIDANCE);
}

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'inherit' });

const ENABLE_GUIDANCE =
  '[watchdog] Restarts stay off until watchdog.enabled is true — enable it via ' +
  '`/claude-code-hermit:hermit-settings watchdog`.';

/** The settled watchdog.enabled value, or undefined when the project has no config.json. */
function readWatchdogEnabled(): boolean | undefined {
  if (!fs.existsSync(CONFIG_PATH)) return undefined;
  const config: Json = readSettledConfig(HERMIT_ROOT);
  return config.watchdog?.enabled === true;
}

/**
 * Flip a watchdog boolean through the audited settings-edit path (validated, logged
 * to the settings ledger — same call /docker-setup makes). Only called from branches
 * that actually registered or removed a timer; the cron fallback prints guidance
 * instead, since flipping there would claim an activation that never happened.
 * Reads the raw on-disk value so a missing key is written rather than treated as
 * already matching the settled default. No-ops when there is no config, or the
 * raw value already matches.
 */
function setWatchdogConfig(key: 'enabled' | 'scheduler_enabled', value: boolean): void {
  if (!fs.existsSync(CONFIG_PATH)) return;
  const raw = readConfigRaw(HERMIT_ROOT);
  const current = raw?.watchdog?.[key];
  if (current === value) return;
  const r = run(process.execPath, [
    path.join(import.meta.dir, 'settings-edit.ts'),
    CONFIG_PATH,
    'set',
    `watchdog.${key}`,
    String(value),
  ]);
  if (r.status !== 0) {
    console.log(`[watchdog] Could not write watchdog.${key} to config.json — set it manually.`);
    process.exitCode = 1;
    return;
  }
  console.log(`[watchdog] ${value ? 'Enabled' : 'Disabled'} watchdog.${key} in config.json.`);
}

/**
 * After a successful timer registration: stamp scheduler_enabled true, and turn
 * the restart tier on for a *first* registration only. Re-running install is
 * the doctor's own remedy for a stale tick or an unbaked unit PATH, and hygiene-only
 * (`enabled: false` with the timer installed) is a state the doctor reports as ok — so a
 * repair run reports what is off instead of silently switching restarts on.
 */
function enableAfterInstall(firstRegistration: boolean): void {
  setWatchdogConfig('scheduler_enabled', true);
  if (firstRegistration) setWatchdogConfig('enabled', true);
  else if (readWatchdogEnabled() === false) console.log(ENABLE_GUIDANCE);
}

/** Platform-dispatching install: systemd (Linux/WSL), launchd (macOS), cron fallback. */
function cmdInstall(): void {
  const root = fs.realpathSync(process.cwd());
  const name = getSessionName();
  const templates = findTemplatesDir();
  const unitPath = resolveUnitPath();

  const render = (templateText: string, escape: (v: string) => string) =>
    templateText
      .replaceAll('{{NAME}}', escape(name))
      .replaceAll('{{ROOT}}', escape(root))
      .replaceAll('{{UNIT_PATH}}', escape(unitPath));

  if (process.platform === 'linux') {
    if (!Bun.which('systemctl')) {
      console.log('[watchdog] systemctl not found — systemd is unavailable on this host.');
      console.log(
        '[watchdog] In the hermit Docker container the entrypoint already runs the ' +
          'watchdog on a ~5 min cycle; no install is needed there.'
      );
      printCronFallback(root, unitPath);
      return;
    }

    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(systemdDir, { recursive: true });
    const serviceName = `hermit-watchdog@${name}`;
    const firstRegistration = !fs.existsSync(path.join(systemdDir, `${serviceName}.timer`));

    let rendered = true;
    for (const [tplName, outName] of [
      ['hermit-watchdog@.service', `${serviceName}.service`],
      ['hermit-watchdog@.timer', `${serviceName}.timer`],
    ]) {
      if (templates) {
        const tpl = fs.readFileSync(path.join(templates, tplName), 'utf-8');
        fs.writeFileSync(path.join(systemdDir, outName), render(tpl, escapeSystemd));
      } else {
        process.stderr.write(`[watchdog] template ${tplName} not found; skipping\n`);
        rendered = false;
      }
    }

    // `systemctl --user` fails routinely over SSH (no user D-Bus session, no lingering).
    // Reporting an install that did not happen would leave the operator with a config
    // flag on and nothing behind it.
    const reloaded = run('systemctl', ['--user', 'daemon-reload']).status === 0;
    const registered = run('systemctl', ['--user', 'enable', '--now', `${serviceName}.timer`]).status === 0;
    if (!rendered || !reloaded || !registered) {
      console.log(`[watchdog] Failed to install systemd user timer: ${serviceName}.timer`);
      process.exitCode = 1;
      return;
    }
    console.log(`[watchdog] Installed systemd user timer: ${serviceName}.timer`);
    enableAfterInstall(firstRegistration);
    console.log('[watchdog] To persist across reboots without a user session: loginctl enable-linger');
  } else if (process.platform === 'darwin') {
    const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgents, { recursive: true });
    const label = `com.hermit.watchdog.${name}`;
    const plistName = `${label}.plist`;
    const plistPath = path.join(launchAgents, plistName);
    const firstRegistration = !fs.existsSync(plistPath);

    let plist: string;
    if (templates) {
      const tpl = fs.readFileSync(path.join(templates, 'com.hermit.watchdog.plist'), 'utf-8');
      plist = render(tpl, escapeXml);
    } else {
      process.stderr.write('[watchdog] plist template not found; using inline fallback\n');
      plist = render(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
          '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
          '<plist version="1.0"><dict>' +
          '<key>Label</key><string>com.hermit.watchdog.{{NAME}}</string>' +
          '<key>ProgramArguments</key><array>' +
          '<string>{{ROOT}}/.claude-code-hermit/bin/hermit-watchdog</string>' +
          '<string>run</string></array>' +
          '<key>WorkingDirectory</key><string>{{ROOT}}</string>' +
          '<key>EnvironmentVariables</key><dict>' +
          '<key>PATH</key><string>{{UNIT_PATH}}</string>' +
          '</dict>' +
          '<key>StartInterval</key><integer>300</integer>' +
          '<key>RunAtLoad</key><false/>' +
          '</dict></plist>\n',
        escapeXml
      );
    }

    // Every surviving tmux boot re-runs install, and a watchdog-ordered restart
    // spawns that boot from inside the tick itself, so an unconditional reload
    // unloads the LaunchAgent executing the very restart it was told to make,
    // cutting the tick off mid-notice. A byte-identical render means there is
    // nothing to re-register, so leave the running job alone.
    //
    // Matching content alone is not enough: the write lands before the load, so a
    // failed load (or an operator's own unload) leaves the file intact with nothing
    // running, and re-running install is the documented repair for exactly that.
    // Ask launchctl whether the label is live before skipping, after the cheap
    // content compare so a drifted plist never pays for the subprocess.
    const labelLoaded = () => spawnSync('launchctl', ['list', label], { stdio: 'ignore' }).status === 0;
    if (REAL_WORLD.files.readText(plistPath) === plist && labelLoaded()) {
      console.log(`[watchdog] LaunchAgent unchanged: ${plistName}`);
      enableAfterInstall(firstRegistration);
      return;
    }

    fs.writeFileSync(plistPath, plist);
    // load is a no-op when the label is already loaded, so re-running install —
    // the documented remedy for a bad unit — would silently keep the old plist.
    // Ignore output: on a first install there is nothing to unload.
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    if (run('launchctl', ['load', plistPath]).status !== 0) {
      console.log(`[watchdog] Failed to install LaunchAgent: ${plistName}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[watchdog] Installed LaunchAgent: ${plistName}`);
    enableAfterInstall(firstRegistration);
  } else {
    console.log('[watchdog] systemd and launchd not available on this platform.');
    printCronFallback(root, unitPath);
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
    setWatchdogConfig('scheduler_enabled', false);
    setWatchdogConfig('enabled', false);
  } else if (process.platform === 'darwin') {
    const plistName = `com.hermit.watchdog.${name}.plist`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', plistName);
    if (fs.existsSync(plistPath)) {
      run('launchctl', ['unload', plistPath]);
      fs.unlinkSync(plistPath);
    }
    console.log(`[watchdog] Removed LaunchAgent: ${plistName}`);
    setWatchdogConfig('scheduler_enabled', false);
    setWatchdogConfig('enabled', false);
  } else {
    console.log('[watchdog] Cron entries must be removed manually with `crontab -e`.');
  }
}

/**
 * Bounce the managed session on demand, reusing the same locked restart path
 * the watchdog's own recovery uses. Exists because credentials are read at
 * process start: after a token renewal something has to restart claude, and
 * every front door (terminal mint, relay, /relogin skill) should go through
 * one implementation rather than improvising its own kill-and-respawn.
 */
async function cmdRestart(reason: string): Promise<void> {
  if (!fs.existsSync(CONFIG_PATH)) {
    process.stderr.write('[watchdog] no config — nothing to restart\n');
    process.exit(0);
  }
  const config: Json = readSettledConfig(HERMIT_ROOT);
  const runtime = readRuntimeJson();
  if (runtime === null) process.exit(0);
  // Same adoption main() does: hermit-start is spawned below and reads the setup
  // token from defaultConfigDir(). Invoked from a plain shell (the operator, or a
  // mint whose own env is bare), this process would otherwise resolve ~/.claude and
  // restart a token hermit with no token exported into its session.
  adoptSessionConfigDir(runtime);
  const sessionName = runtime.tmux_session || deriveSessionName(config);
  if (!sessionName) process.exit(0);
  await doRestart(sessionName, reason, runtime, config.timezone ?? 'UTC', config);
}

if (import.meta.main) {
  const subcommand = process.argv[2] ?? 'run';
  if (subcommand === 'run' || subcommand === '') {
    try {
      await main();
    } catch (e) {
      process.stderr.write(`[watchdog] fatal: ${e}\n`);
      process.exit(0); // fail-open: watchdog must never crash the calling shell
    }
  } else if (subcommand === 'install') {
    cmdInstall();
  } else if (subcommand === 'uninstall') {
    cmdUninstall();
  } else if (subcommand === 'restart') {
    await cmdRestart(process.argv[3] ?? 'manual');
  } else {
    process.stderr.write(`[watchdog] unknown subcommand: ${subcommand}\n`);
    process.exit(1);
  }
}
