// `heartbeat.ts precheck` — fast-path verdict before the LLM evaluates HEARTBEAT.md.
// Usage: bun heartbeat.ts precheck [--peek] <hermit-state-dir>
// Output (stdout, one line): SKIP|<reason>  |  OK  |  AUTO_CLOSE  |  EVALUATE  |  ALERT|<detail>
// Exit 0 always. Without --peek: writes updated alert-state.json (increments total_ticks).
// With --peek: read-only — computes the same verdict without any state mutation.
//
// `runPrecheck(stateDir, peek)` is the same logic as a value-returning core, so
// `lib/heartbeat/tick.ts` can run the mutating tick in-process instead of paying a
// second spawn. `main()` below is the CLI wrapper and is the only caller that
// writes stdout or exits, keeping the verb's output byte-identical.
//
// Owner contract (write-field split with SKILL.md):
//   This script owns: alert-state.json total_ticks, last_stale_wake_at, last_micro_corrupt_wake_at;
//                     pending-close-drain.json (shared with lib/routines/due.ts, non-peek only)
//   alert-state owns: alert-state.json alerts{}, self_eval{}, last_digest_date, last_clean_eval_at,
//                     structured_read_failure_notified_date (the `heartbeat.ts alert-state` verb)

import fs from 'node:fs';
import path from 'node:path';
import { currentHHMM, todayYMD, parseDuration } from '../time';
import { readSettledConfig } from '../config-read';
import { readAlertState, defaultAlertState, quarantineAlertState, writeAlertState, readMergedAlerts, MICRO_PREFIX, PROPOSAL_PREFIX } from '../alert-state';
import { readFrontmatter, listProposalFiles } from '../frontmatter';
import { isProposalScanItem, isCredentialExpiryItem, normalizeItemKey, parseChecklistItems } from '../heartbeat-items';
import { isPaused } from '../pause';
import { probeDeclaredCredentials, shadowingCredentialNote } from '../credential-probe';
import { readMicroProposals } from '../micro-proposals-io';
import { scanForInjection } from '../injection-scan';
import { sha256 } from '../hash';
import { pendingCloseDrainDue, operatorTurnOpen, drainCooldownExpired, stampDrainCooldown, PENDING_CLOSE_DRAIN_COOLDOWN_MINUTES } from '../auto-close';

type Json = any;

const readJSON = (p: string): Json => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
};

// An un-notified budget alert in the merged alert view (cost-tracker writes
// budget-alerts.json; readMergedAlerts unions the per-writer files). Shared by
// the pause-escape gate, the pending-budget gate, and the injection branch.
export const budgetPending = (dir: string): boolean =>
  Object.values(readMergedAlerts(dir)).some((e: Json) => e?.kind === 'budget' && e.notified === false);

// A task queued by `proposal-act` / `session-start --task` and not yet consumed.
// Shared by the idle pierce below and the tick's `next_task` composition.
export const nextTaskQueued = (dir: string): boolean =>
  fs.existsSync(path.join(dir, 'sessions', 'NEXT-TASK.md'));

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

// Same shape as resolveProposalScanItem, for the micro-approval queue. A pending
// tier-1 micro-proposal is a structured alert key (MICRO_PREFIX), derived by
// deriveMicroPendingKeys and aged through the same suppress-after-5-fires ladder on
// every EVALUATE tick — this scan is what reads that ladder back. Without it the gate
// fired on raw micro-proposals.json forever, so an unanswered operator question (the
// channel-bridged ask path forces tier 1) turned every poll into a paid full-context
// wake for as long as it went unanswered. Bypassing clean_recheck_cooldown is still
// correct — a pending decision is not "clean" — but bypassing it is not a licence to
// fire indefinitely; once suppressed, the once-daily digest gate keeps surfacing it.
// Read-only — writes nothing, so it is identical under --peek.
// A corrupt file is NOT an empty queue: the sibling scan above fails open on every
// ambiguous read of its source of truth, and this one must too, or a hand-edit typo
// silently buries every pending operator question (#764). Caller damps the repeat.
function resolveMicroPendingScan(dir: string, alertMap: Json): 'clean' | 'evaluate' | 'corrupt' {
  const read = readMicroProposals(path.join(dir, 'state', 'micro-proposals.json'));
  if (read.status === 'corrupt') return 'corrupt';
  const micro = read.status === 'missing' ? { pending: [] } : read.data;
  const pending = Array.isArray(micro.pending)
    ? micro.pending.filter((p: Json) => p && p.status === 'pending' && p.tier === 1)
    : [];
  for (const p of pending) {
    // deriveMicroPendingKeys skips a non-string id, so no alert key exists to suppress
    // against — fail open rather than let a malformed entry read as damped.
    if (typeof p.id !== 'string') return 'evaluate';
    const entry = alertMap[`${MICRO_PREFIX}${p.id}`];
    if (!entry || !entry.suppressed || (entry.consecutive_clean ?? 0) > 0) return 'evaluate';
  }
  return 'clean';
}

// The default HEARTBEAT.md credential-expiry item asks the credential itself.
// Every declared `expiry_probe` (core plus siblings) is run here, so a healthy
// credential reaches OK without an LLM wake and a stale state/doctor-report.json
// can no longer hide an expiry. Anything short of "every probe healthy" — no
// credential declared, a bad note, a probe failure or timeout — evaluates. A
// lingering alerts[key] on an otherwise-healthy credential is SKILL.md-owned
// resolution, so defer. Read-only, identical under --peek.
//
// The shadowing note rides along for the same reason doctor's credential-expiry
// check folds it in: a stored /login next to a token 401s the hermit and no
// expiry_probe reports it, so probing alone would resolve that item clean and
// the operator would never hear about it.
function resolveCredentialExpiryItem(config: Json, alerts: Json, key: string): 'clean' | 'evaluate' {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '../../..');
  let healthy = false;
  try {
    const { okCount, badNotes } = probeDeclaredCredentials(pluginRoot);
    healthy = okCount > 0 && badNotes.length === 0 && shadowingCredentialNote(config) === null;
  } catch {
    healthy = false;
  }
  if (healthy) return alerts[key] ? 'evaluate' : 'clean';
  const entry = alerts[key];
  if (!entry || !entry.suppressed || (entry.consecutive_clean ?? 0) > 0) return 'evaluate';
  return 'clean';
}

/**
 * The verdict, as a value. Every `emit(x)` in the original top-level script is a
 * `return x` here; the gate order and every predicate are otherwise unchanged.
 */
export function runPrecheck(stateDir: string, peek: boolean): string {
  if (!stateDir) return 'EVALUATE';

  const alertStatePath = path.join(stateDir, 'state', 'alert-state.json');

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
      if (!budgetPending(stateDir)) return 'SKIP|paused';
      // else fall through to the gates below, which will reach the pending-budget
      // check and emit EVALUATE.
    } else {
      return 'SKIP|paused';
    }
  }

  // Settled config, read once. Declared here rather than beside the active-hours gate
  // below because the pending-close drain — which runs before every other gate — sizes
  // its cooldown from heartbeat.every. The reader never writes and never throws, so the
  // paths that emit before that gate only pay one extra small read.
  const config = readSettledConfig(stateDir);
  const hbConfig = config.heartbeat;

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
  // The verdict itself lives in lib/auto-close.ts so the routine poll (lib/routines/
  // due.ts) drains on the same terms — this tick is not the only drainer, and is
  // absent entirely when heartbeat.enabled is false.
  //
  // Both guards are shared with that poll. The lull inside pendingCloseDrainDue ages
  // from prompt submission, so an operator watching a long agent turn reads as away
  // while still present — the turn marker is what catches that. The cooldown bounds a
  // close that never completes: without it every tick re-emits, and each emission is a
  // paid full-context wake. Under --peek the verdict is computed but not stamped, so a
  // peek never consumes the cooldown the real tick needs.
  //
  // Hence the half-interval cap below: a cooldown as long as this poller's own interval
  // can never expire on the next tick (drainCooldownExpired's note has the derivation),
  // which is what made a failing close retry only every other tick once heartbeat.every
  // became 30m (#771). The min() only tightens the shared 30-min ceiling, never widens
  // it. Config is read live here while the monitor baked its interval in at launch, so
  // an `every` edited mid-session can diverge from the real poll cadence until the
  // monitor restarts — bounded, self-healing, and never worse than the old behavior.
  //
  // Below a 30-min interval the shipped flat cooldown already expires within a tick or
  // two, so there is nothing to fix and halving would only shorten the backoff: an
  // `every` of 5m would re-wake a failing close every 5 min instead of every ~35. A
  // suppressed tick costs nothing (the peek never wakes the model), so short intervals
  // keep the flat 30. Also absorbs `every: "0m"`, which would otherwise disable the gate.
  const everyMin = parseDuration(hbConfig.every, 30 * 60_000) / 60_000;
  const drainCooldownMin = everyMin < PENDING_CLOSE_DRAIN_COOLDOWN_MINUTES
    ? PENDING_CLOSE_DRAIN_COOLDOWN_MINUTES
    : Math.min(PENDING_CLOSE_DRAIN_COOLDOWN_MINUTES, everyMin / 2);
  if (
    pendingCloseDrainDue(stateDir, now) &&
    !operatorTurnOpen(stateDir, now) &&
    drainCooldownExpired(stateDir, now, drainCooldownMin)
  ) {
    if (peek || stampDrainCooldown(stateDir, now)) return 'AUTO_CLOSE';
  }

  let heartbeatContent: string;
  try { heartbeatContent = fs.readFileSync(path.join(stateDir, 'HEARTBEAT.md'), 'utf-8'); }
  catch { return 'SKIP|HEARTBEAT.md missing'; }

  const checklistItems = parseChecklistItems(heartbeatContent);

  if (checklistItems.length === 0) return 'SKIP|HEARTBEAT.md has no checklist items';

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
      if (budgetPending(stateDir)) return verdict;
      if (staleAutoCloseDue(stateDir, now)) return 'AUTO_CLOSE';
      const announced = readJSON(path.join(stateDir, 'state', 'injection-alert.json'));
      if (announced?.hash === hash) return 'SKIP|injection-suspect (announced)';
      return verdict;
    }
  } catch { /* fail-open: scan trouble must not block the tick */ }

  const timezone = config.timezone ?? 'UTC';
  const activeHours = hbConfig.active_hours;

  if (activeHours?.start && activeHours?.end) {
    const hhmm = currentHHMM(timezone);
    if (hhmm !== null && (hhmm < activeHours.start || hhmm >= activeHours.end)) {
      return 'SKIP|outside active hours';
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
    return 'EVALUATE';
  } else {
    // ioerror — never reinit skill-owned alerts/self_eval over a file we couldn't read.
    return 'EVALUATE';
  }
  if (typeof alertState.total_ticks !== 'number' || !Number.isFinite(alertState.total_ticks)) {
    alertState.total_ticks = 0;
  }
  const microScan = resolveMicroPendingScan(stateDir, alertState.alerts ?? {});
  // Recovery clears the damper: a file repaired and re-broken inside the 24h window is a
  // NEW corruption, and inheriting the previous one's stamp would silence its wake. Folded
  // into the tick-increment write below rather than a second writeAlertState call, since
  // precheck runs on every heartbeat poll.
  if (microScan !== 'corrupt' && !peek && typeof alertState.last_micro_corrupt_wake_at === 'string') {
    delete alertState.last_micro_corrupt_wake_at;
  }
  if (!peek) {
    alertState.total_ticks += 1;
    writeAlertState(alertStatePath, alertState);
  }

  // peek fires one tick early; the subsequent mutating call lands on the multiple-of-20
  if (peek ? (alertState.total_ticks + 1) % 20 === 0 : alertState.total_ticks % 20 === 0) return 'EVALUATE';

  if (microScan === 'evaluate') return 'EVALUATE';
  // Corrupt file: wake so the tick can tell the operator, but at most once a day —
  // the file stays corrupt until a human fixes it, and waking every poll to repeat
  // that is the same unbounded-wake shape the pending-micro damper just removed.
  if (microScan === 'corrupt') {
    const lastWake = typeof alertState.last_micro_corrupt_wake_at === 'string'
      ? new Date(alertState.last_micro_corrupt_wake_at).getTime()
      : NaN;
    if (isNaN(lastWake) || (now - lastWake) >= 24 * 3600000) {
      if (!peek) {
        alertState.last_micro_corrupt_wake_at = new Date(now).toISOString();
        writeAlertState(alertStatePath, alertState);
      }
      return 'EVALUATE';
    }
  }

  // PROP-016: an un-notified budget alert (cost-tracker.ts writes these directly,
  // bypassing the LLM-owned suppressed/digest dance the generic checklist alerts use)
  // forces an immediate EVALUATE — this is both how `action:"alert"` breaches surface
  // at all, and the mechanism the pause-escape gate above depends on to actually emit
  // EVALUATE rather than just falling through.
  if (budgetPending(stateDir)) return 'EVALUATE';

  const runtime = readJSON(path.join(stateDir, 'state', 'runtime.json')) ?? {};
  const sessionState = runtime.session_state ?? 'idle';

  // A queued task on an idle always-on session pierces the damped gates below, the
  // same way a pending budget alert does: the tick composes `next_task` and the skill
  // either notifies (conservative) or starts the session. Without this the queue sits
  // until the next boot.
  //
  // Gated on always_on because that is the same condition session-start applies before
  // it will consume NEXT-TASK.md: an interactive hermit presents the queued task to the
  // operator instead, leaving the file and the idle state exactly as they were — so an
  // ungated pierce would re-fire this EVALUATE on every tick for as long as the task
  // sits there, and each one is a paid full-context wake. Their next boot presents it
  // anyway, which is the wait this pierce exists to remove for unattended hermits only.
  if (sessionState === 'idle' && config.always_on === true && nextTaskQueued(stateDir)) return 'EVALUATE';

  if (sessionState === 'in_progress') {
    // 12h operator-quiet → auto-close. The action-file resolution below is kept
    // only to feed the separate stale-EVALUATE damper (different threshold/purpose).
    if (staleAutoCloseDue(stateDir, now)) return 'AUTO_CLOSE';
    // Prefer last-operator-action.json: records genuine operator prompts only, unaffected
    // by routine writes (reflect, plugin-check routines, heartbeat alerts) that bump SHELL.md mtime.
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
        return 'EVALUATE';
      }
    }
  }

  // waiting-timeout check requires elapsed computation — delegate to LLM
  if (sessionState === 'waiting' && hbConfig.waiting_timeout) return 'EVALUATE';

  const alerts: Json = alertState.alerts ?? {};
  const alertValues = Object.values(alerts);
  const hasSuppressed = alertValues.some((e: Json) => e?.suppressed === true);
  const today = todayYMD(timezone);
  if (hasSuppressed && alertState.last_digest_date !== today) return 'EVALUATE';

  // Clean-recheck damper: suppress re-evaluation for clean_recheck_cooldown after a tick
  // concludes nothing actionable. Sits after all change-detecting gates so stale/micro-
  // proposal/suppressed-digest still pre-empt it. Two bypasses, both bounded:
  //   - a resolving entry (consecutive_clean > 0), so the hysteresis window is never masked;
  //   - a `proposal-pending:*` entry that has not reached suppression yet. These keys bake a
  //     PROP-NNN id into their text, so their first observation is silenced by design
  //     (alert-update's silentOnNewKeys) — the count===6 suppression transition is the
  //     operator's FIRST notice that a decision is waiting. Damping the five ticks in
  //     between would push that notice from ~5 ticks out to ~5 cooldown windows. This
  //     mirrors the micro-proposal gate above, which pre-empts the damper on the same
  //     terms and self-limits the same way.
  // An unsuppressed entry of any other kind needs no bypass — it already notified on first
  // observation, and every apply rewrites last_clean_eval_at while a genuinely new key nulls it.
  // `null` cooldown disables it.
  if (hbConfig.clean_recheck_cooldown !== null) {
    const bypassDamper = Object.entries(alerts).some(([key, e]: [string, Json]) => e
      && ((e.consecutive_clean ?? 0) > 0
        || (key.startsWith(PROPOSAL_PREFIX) && e.suppressed !== true)));
    const lastCleanEvalAt = typeof alertState.last_clean_eval_at === 'string'
      ? new Date(alertState.last_clean_eval_at).getTime()
      : NaN;
    const cooldownMs = parseDuration(hbConfig.clean_recheck_cooldown, 6 * 3600000);
    if (!bypassDamper && !isNaN(lastCleanEvalAt) && lastCleanEvalAt <= now &&
        (now - lastCleanEvalAt) < cooldownMs) {
      return 'OK';
    }
  }

  // OK fires only when every item in HEARTBEAT.md is satisfied. The default
  // proposals-scan item is resolved against real proposal frontmatter; the
  // default credential-expiry item against the credential's own expiry_probe (so
  // a hermit whose credential is healthy reaches OK without an LLM wake); every other
  // item needs a matching entry in alerts{} that is suppressed (count > 5) and not
  // approaching resolution (consecutive_clean === 0).
  for (const item of checklistItems) {
    if (isProposalScanItem(item)) {
      if (resolveProposalScanItem(stateDir, alerts) === 'evaluate') return 'EVALUATE';
      continue;
    }
    const key = normalizeItemKey(item);
    if (!key) return 'EVALUATE';
    if (isCredentialExpiryItem(item)) {
      if (resolveCredentialExpiryItem(config, alerts, key) === 'evaluate') return 'EVALUATE';
      continue;
    }
    const entry = alerts[key];
    if (!entry || !entry.suppressed || (entry.consecutive_clean ?? 0) > 0) return 'EVALUATE';
  }

  return 'OK';
}

/** CLI wrapper for `heartbeat.ts precheck` — the only writer of stdout here. */
export function main(): void {
  const peek = process.argv[2] === '--peek';
  const stateDir = peek ? process.argv[3] : process.argv[2];
  process.stdout.write(runPrecheck(stateDir, peek) + '\n');
  process.exit(0);
}
