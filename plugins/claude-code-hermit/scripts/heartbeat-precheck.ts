// heartbeat-precheck.ts — fast-path verdict before the LLM evaluates HEARTBEAT.md.
// Usage: bun heartbeat-precheck.ts [--peek] <hermit-state-dir>
// Output (stdout, one line): SKIP|<reason>  |  OK  |  AUTO_CLOSE  |  EVALUATE  |  ALERT|<detail>
// Exit 0 always. Without --peek: writes updated alert-state.json (increments total_ticks).
// With --peek: read-only — computes the same verdict without any state mutation.
//
// Owner contract (write-field split with SKILL.md):
//   This script owns: alert-state.json total_ticks, last_stale_wake_at
//   SKILL.md owns:    alert-state.json alerts{}, self_eval{}, last_digest_date, last_clean_eval_at

import fs from 'node:fs';
import path from 'node:path';
import { currentHHMM, todayYMD, parseDuration } from './lib/time';
import { readAlertState, defaultAlertState, quarantineAlertState, writeAlertState, readMergedAlerts } from './lib/alert-state';
import { readFrontmatter, listProposalFiles } from './lib/frontmatter';
import { isProposalScanItem } from './lib/heartbeat-items';
import { isPaused } from './lib/pause';
import { scanForInjection } from './lib/injection-scan';
import { sha256 } from './lib/hash';
import { AUTO_CLOSE_LULL_MINUTES } from './lib/auto-close';

type Json = any;

function emit(verdict: string): never {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

const peek = process.argv[2] === '--peek';
const stateDir = peek ? process.argv[3] : process.argv[2];
if (!stateDir) emit('EVALUATE');

const alertStatePath = path.join(stateDir, 'state', 'alert-state.json');

// An un-notified budget alert in the merged alert view (cost-tracker writes
// budget-alerts.json; readMergedAlerts unions the per-writer files). Shared by
// the pause-escape gate, the pending-budget gate, and the injection branch.
const budgetPending = (dir: string): boolean =>
  Object.values(readMergedAlerts(dir)).some((e: Json) => e?.kind === 'budget' && e.notified === false);

// Earliest gate (PROP-015) — ahead of the pending-close drain below, so a
// paused hermit also suppresses AUTO_CLOSE, not just the checklist. Read-only:
// identical under --peek since it writes nothing.
const pauseStatus = isPaused(stateDir);
if (pauseStatus.paused) {
  // PROP-016: a budget-triggered pause is itself the enforcement action, so the
  // plain SKIP|paused below would also silence the one wake needed to tell the
  // operator why every tool is now denied and how to resume. Let exactly one
  // EVALUATE escape when an un-notified budget alert is waiting — the pending-budget
  // gate further down (after alert-state is loaded) is what actually emits it; the
  // heartbeat skill announces and marks `notified:true`, and every subsequent tick
  // falls back to the plain SKIP|paused here (no un-notified entry left to escape on).
  if (pauseStatus.reason === 'budget') {
    if (!budgetPending(stateDir)) emit('SKIP|paused');
    // else fall through to the gates below, which will reach the pending-budget
    // check and emit EVALUATE.
  } else {
    emit('SKIP|paused');
  }
}

const readJSON = (p: string): Json => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
};

// True when an in_progress session has been operator-quiet for >12h (prefers
// last-operator-action.json, falls back to SHELL.md mtime). Pure read; fail-open
// to false so a read error never forces a close. Shared by the injection branch
// (AUTO_CLOSE never reads HEARTBEAT.md, so it survives a tainted checklist) and
// the stale-session block below.
function staleAutoCloseDue(dir: string, nowMs: number): boolean {
  try {
    const runtime = readJSON(path.join(dir, 'state', 'runtime.json')) ?? {};
    if ((runtime.session_state ?? 'idle') !== 'in_progress') return false;
    const lastAction = readJSON(path.join(dir, 'state', 'last-operator-action.json'));
    if (lastAction && typeof lastAction.at === 'string') {
      const t = new Date(lastAction.at).getTime();
      if (!isNaN(t)) return (nowMs - t) / 3600000 > 12;
    }
    // Absent/malformed action file → SHELL.md mtime fallback.
    const mtime = fs.statSync(path.join(dir, 'sessions', 'SHELL.md')).mtime.getTime();
    return (nowMs - mtime) / 3600000 > 12;
  } catch { return false; }
}

// Normalises a HEARTBEAT.md checklist item to its dedup key.
// Key format mirrors SKILL.md: 'checklist:<first-8-chars-normalized>'.
function normalizeItemKey(itemText: string): string | null {
  const text = itemText
    .replace(/^[-*+]\s*(\[.\]\s*)?/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  return text ? `checklist:${text}` : null;
}

// The default HEARTBEAT.md checklist item scans `proposals/` for review-worthy
// proposals. Its alerts are keyed `proposal-pending:<PROP-NNN>`, NOT the generic
// `checklist:<hash>` key the item loop below uses — so the generic rule can never
// satisfy it and the item always forces EVALUATE (the bug this resolves). Resolve
// it against real proposal frontmatter + proposal-pending alerts instead. The
// `isProposalScanItem` classifier lives in ./lib/heartbeat-items (shared with its
// coherence test).

// 'clean' → item satisfied, continue the loop. 'evaluate' → dispatch the LLM.
// Fail-open in every ambiguous case (unreadable dir/file, legacy no-frontmatter,
// lingering alerts that need LLM-owned resolution detection): never a false OK.
// Read-only — writes nothing, so it is identical under --peek.
function resolveProposalScanItem(dir: string, alertMap: Json): 'clean' | 'evaluate' {
  const proposalsDir = path.join(dir, 'proposals');
  // listProposalFiles distinguishes ENOENT (ok:true, empty — nothing to review,
  // fall through to the empty-scan branch that still honors a lingering alert)
  // from any other readdir error (ok:false — EACCES/EIO/ENOTDIR, realistic under
  // the Docker runtime), which is ambiguous → fail-open, never a false OK. Shared
  // with the alert-state derivers so both scans agree on what counts as readable.
  const listed = listProposalFiles(proposalsDir);
  if (!listed.ok) return 'evaluate';
  const files = listed.files.map(f => path.join(proposalsDir, f));
  const proposedIds: string[] = [];
  for (const f of files) {
    const fm = readFrontmatter(f);
    if (!fm || typeof fm.status !== 'string') return 'evaluate'; // legacy/unreadable/malformed
    if (fm.status === 'proposed') {
      const m = path.basename(f).match(/^(PROP-\d+)/);
      if (!m) return 'evaluate';
      proposedIds.push(m[1]);
    }
  }
  const hasPendingAlert = Object.keys(alertMap).some(k => /^proposal-pending:/.test(k));
  if (proposedIds.length === 0) {
    // Nothing to review. A lingering proposal-pending alert means a proposal was
    // resolved/accepted since it fired; resolution detection + consecutive_clean
    // cleanup are SKILL.md-owned (this script never writes alerts{}), so defer.
    return hasPendingAlert ? 'evaluate' : 'clean';
  }
  // Some proposals are awaiting review — each needs a suppressed, non-resolving
  // alert entry, the same predicate the generic item loop applies.
  for (const id of proposedIds) {
    const entry = alertMap[`proposal-pending:${id}`];
    if (!entry || !entry.suppressed || (entry.consecutive_clean ?? 0) > 0) return 'evaluate';
  }
  return 'clean';
}

// Resolve "now" once: real wall-clock, overridable by HERMIT_NOW for deterministic
// tests. Shared by the pending-close drain and the in_progress 12h check below.
let now = Date.now();
if (process.env.HERMIT_NOW) {
  const d = new Date(process.env.HERMIT_NOW).getTime();
  if (!isNaN(d)) now = d;
}

// Pending-close drain: if the daily-auto-close routine queued a close because the
// operator was active at midnight, drain it as soon as a 10-min lull appears.
// Runs BEFORE every other gate (HEARTBEAT.md presence, active-hours, 20-tick,
// micro-proposal) — the close is the signal, not a notification, and must not
// depend on operator-editable HEARTBEAT.md being present.
{
  const pendingClose = readJSON(path.join(stateDir, 'state', 'pending-close.json'));
  if (pendingClose !== null) {
    const runtime = readJSON(path.join(stateDir, 'state', 'runtime.json')) ?? {};
    if (runtime.session_state === 'in_progress' || runtime.session_state === 'idle') {
      const lastAction = readJSON(path.join(stateDir, 'state', 'last-operator-action.json'));
      const tStr = lastAction && typeof lastAction.at === 'string' ? lastAction.at : null;
      const t = tStr ? new Date(tStr).getTime() : NaN;
      if (!isNaN(t)) {
        // Valid last-operator-action → standard 10-min lull check.
        if ((now - t) / (1000 * 60) > AUTO_CLOSE_LULL_MINUTES) emit('AUTO_CLOSE');
      } else {
        // Absent/malformed last-operator-action → fail-open per daily-auto-close
        // SKILL.md step 5, BUT only when the flag itself is recent. A stale flag
        // left over from a crashed prior session must not auto-close a fresh
        // session whose last-op clock has not yet been seeded. The routine fires
        // every 24h and overwrites or cleans up the flag, so a queued_at older
        // than 24h means the routine has stopped firing and the flag cannot be
        // trusted.
        const qStr = typeof pendingClose.queued_at === 'string' ? pendingClose.queued_at : null;
        const q = qStr ? new Date(qStr).getTime() : NaN;
        if (!isNaN(q) && (now - q) / (1000 * 60 * 60) <= 24) emit('AUTO_CLOSE');
      }
    }
  }
}

let heartbeatContent: string;
try { heartbeatContent = fs.readFileSync(path.join(stateDir, 'HEARTBEAT.md'), 'utf-8'); }
catch { emit('SKIP|HEARTBEAT.md missing'); }

const checklistItems = heartbeatContent
  .split('\n')
  .map(l => l.trim())
  .filter(l => /^[-*+]\s/.test(l));

if (checklistItems.length === 0) emit('SKIP|HEARTBEAT.md has no checklist items');

// Injection gate: HEARTBEAT.md is model-editable and feeds the autonomous
// evaluation subagent verbatim, so a poisoned item written in one session
// would steer every future wake. On a hit, ALERT wakes the model to notify
// the operator WITHOUT evaluating the checklist; the announced-hash damper
// (state/injection-alert.json, written by the SKILL.md ALERT branch) keeps
// it to one alert per file version. Deterministic operator-safety escalations
// survive the suspension: a pending budget alert pierces the damper (the SKILL
// ALERT branch delivers it without reading HEARTBEAT.md), and a due stale
// auto-close still fires (AUTO_CLOSE never reads HEARTBEAT.md). One verdict per
// tick, budget before the destructive close. Scan errors fall through — never
// block the tick. Pause still pre-empts this (gate at top of file).
try {
  const hit = scanForInjection(heartbeatContent);
  if (hit) {
    const hash = sha256(heartbeatContent).slice(0, 8);
    const verdict = `ALERT|injection-suspect:${hash}|${hit.cls} at line ${hit.line}`;
    if (budgetPending(stateDir)) emit(verdict);
    if (staleAutoCloseDue(stateDir, now)) emit('AUTO_CLOSE');
    const announced = readJSON(path.join(stateDir, 'state', 'injection-alert.json'));
    if (announced?.hash === hash) emit('SKIP|injection-suspect (announced)');
    emit(verdict);
  }
} catch { /* fail-open: scan trouble must not block the tick */ }

const config = readJSON(path.join(stateDir, 'config.json')) ?? {};
const hbConfig = config.heartbeat ?? {};
const timezone = config.timezone ?? 'UTC';
const activeHours = hbConfig.active_hours;

if (activeHours?.start && activeHours?.end) {
  const hhmm = currentHHMM(timezone);
  if (hhmm !== null && (hhmm < activeHours.start || hhmm >= activeHours.end)) {
    emit('SKIP|outside active hours');
  }
}

// Split read from parse so a transient read error never destroys a healthy file:
// only a genuine parse failure (corrupt) quarantines and rebuilds. ioerror
// (EACCES/EMFILE/EIO) leaves the file untouched and re-evaluates next tick.
const r = readAlertState(alertStatePath);
let alertState: Json;
if (r.kind === 'ok') {
  alertState = r.value;
} else if (r.kind === 'missing') {
  alertState = defaultAlertState();
} else if (r.kind === 'corrupt') {
  if (!peek) quarantineAlertState(alertStatePath, now);
  emit('EVALUATE');
} else {
  // ioerror — never reinit skill-owned alerts/self_eval over a file we couldn't read.
  emit('EVALUATE');
}
if (typeof alertState.total_ticks !== 'number' || !Number.isFinite(alertState.total_ticks)) {
  alertState.total_ticks = 0;
}
if (!peek) {
  alertState.total_ticks += 1;
  writeAlertState(alertStatePath, alertState);
}

// peek fires one tick early; the subsequent mutating call lands on the multiple-of-20
if (peek ? (alertState.total_ticks + 1) % 20 === 0 : alertState.total_ticks % 20 === 0) emit('EVALUATE');

const microProposals = readJSON(path.join(stateDir, 'state', 'micro-proposals.json')) ?? { pending: [] };
const hasPendingMicro = Array.isArray(microProposals.pending) &&
  microProposals.pending.some((p: Json) => p.status === 'pending' && p.tier === 1);
if (hasPendingMicro) emit('EVALUATE');

// PROP-016: an un-notified budget alert (cost-tracker.ts writes these directly,
// bypassing the LLM-owned suppressed/digest dance the generic checklist alerts use)
// forces an immediate EVALUATE — this is both how `action:"alert"` breaches surface
// at all, and the mechanism the pause-escape gate above depends on to actually emit
// EVALUATE rather than just falling through.
if (budgetPending(stateDir)) emit('EVALUATE');

const runtime = readJSON(path.join(stateDir, 'state', 'runtime.json')) ?? {};
const sessionState = runtime.session_state ?? 'idle';

if (sessionState === 'in_progress') {
  // 12h operator-quiet → auto-close. The action-file resolution below is kept
  // only to feed the separate stale-EVALUATE damper (different threshold/purpose).
  if (staleAutoCloseDue(stateDir, now)) emit('AUTO_CLOSE');
  // Prefer last-operator-action.json: records genuine operator prompts only, unaffected
  // by routine writes (reflect, scheduled-checks, heartbeat alerts) that bump SHELL.md mtime.
  // Absent/malformed → !usedActionFile leaves opQuiet true, so the damper still wakes.
  let usedActionFile = false;
  let lastActionAt = NaN;
  try {
    const lastAction = readJSON(path.join(stateDir, 'state', 'last-operator-action.json'));
    if (lastAction && typeof lastAction.at === 'string') {
      const t = new Date(lastAction.at).getTime();
      if (!isNaN(t)) {
        usedActionFile = true;
        lastActionAt = t;
      }
    }
  } catch { /* fail-open */ }

  // Stale-session check: wake once per stale_threshold, not every tick.
  // Falls back to EVALUATE when last-operator-action.json is absent (pre-upgrade installs),
  // mtime fallback was used, or timestamp is future-dated (clock skew / cross-machine).
  // Damped by last_stale_wake_at: if the staleness condition is unchanged and stale_threshold
  // hasn't elapsed since last wake, fall through to the digest/checklist gates instead of
  // emitting EVALUATE — identical operator-visible behavior, 1 LLM wake per interval instead of N.
  const staleMs = parseDuration(hbConfig.stale_threshold, 2 * 3600000);
  const opQuiet = !usedActionFile || lastActionAt > now || (now - lastActionAt) > staleMs;
  const staleAlertActive = !!(alertState.alerts ?? {})['stale-session'];
  if (opQuiet || staleAlertActive) {
    const lastStaleWakeAt = typeof alertState.last_stale_wake_at === 'string'
      ? new Date(alertState.last_stale_wake_at).getTime()
      : NaN;
    const operatorAdvanced = usedActionFile && !isNaN(lastStaleWakeAt) && lastActionAt > lastStaleWakeAt;
    const wakeDue = isNaN(lastStaleWakeAt) || operatorAdvanced || (now - lastStaleWakeAt) >= staleMs;
    if (wakeDue) {
      if (!peek) {
        alertState.last_stale_wake_at = new Date(now).toISOString();
        writeAlertState(alertStatePath, alertState);
      }
      emit('EVALUATE');
    }
  }
}

// waiting-timeout check requires elapsed computation — delegate to LLM
if (sessionState === 'waiting' && hbConfig.waiting_timeout) emit('EVALUATE');

const alerts: Json = alertState.alerts ?? {};
const alertValues = Object.values(alerts);
const hasSuppressed = alertValues.some((e: Json) => e?.suppressed === true);
const today = todayYMD(timezone);
if (hasSuppressed && alertState.last_digest_date !== today) emit('EVALUATE');

// Clean-recheck damper: suppress re-evaluation for clean_recheck_cooldown after a tick
// concludes nothing actionable. Sits after all change-detecting gates so stale/micro-
// proposal/suppressed-digest still pre-empt it. Active alerts (unsuppressed or resolving)
// bypass the damper so a firing alert is never masked. `null` cooldown disables it.
if (hbConfig.clean_recheck_cooldown !== null) {
  const hasActiveFollowup = alertValues.some(
    (e: Json) => e && (e.suppressed !== true || (e.consecutive_clean ?? 0) > 0));
  const lastCleanEvalAt = typeof alertState.last_clean_eval_at === 'string'
    ? new Date(alertState.last_clean_eval_at).getTime()
    : NaN;
  const cooldownMs = parseDuration(hbConfig.clean_recheck_cooldown, 6 * 3600000);
  if (!hasActiveFollowup && !isNaN(lastCleanEvalAt) && lastCleanEvalAt <= now &&
      (now - lastCleanEvalAt) < cooldownMs) {
    emit('OK');
  }
}

// OK fires only when every item in HEARTBEAT.md is satisfied. The default
// proposals-scan item is resolved against real proposal frontmatter (so a hermit
// with no proposals awaiting review reaches OK without an LLM wake); every other
// item needs a matching entry in alerts{} that is suppressed (count > 5) and not
// approaching resolution (consecutive_clean === 0).
for (const item of checklistItems) {
  if (isProposalScanItem(item)) {
    if (resolveProposalScanItem(stateDir, alerts) === 'evaluate') emit('EVALUATE');
    continue;
  }
  const key = normalizeItemKey(item);
  if (!key) emit('EVALUATE');
  const entry = alerts[key];
  if (!entry || !entry.suppressed || (entry.consecutive_clean ?? 0) > 0) emit('EVALUATE');
}

emit('OK');
