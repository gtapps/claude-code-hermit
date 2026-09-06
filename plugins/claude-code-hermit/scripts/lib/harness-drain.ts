// Drain a pending channel-requested harness command into the tmux pane.
// Split out of stop-pipeline.ts so the guard cascade is unit-testable without
// spawning the whole Stop hook.

import { readRuntimeJson } from './runtime';
import { capturePane, paneModeLine, sendKeys, tmuxSessionAlive } from './tmux';
import { applyContextReset } from './context-reset';
import { CHANNEL_SETTABLE_MODES, clearPendingCommand, normalizePermissionMode, parseHarnessCommand, readPendingCommand, renderCommand, writeSkillRelay, writeSwitchVerify } from './harness-command';
import type { PendingCommand } from './harness-command';
import { currentHHMMOrUTC } from './time';
import { readSettledConfig } from './config-read';
import path from 'node:path';

/**
 * Hand a permission-mode switch to the detached cycler.
 *
 * The preconditions checked here are the ones that are cheaper to answer before spawning:
 * the pane must be readable and must currently show a mode. A null read also covers the
 * case that matters most — while any dialog is open the status bar is off-screen, so an
 * unreadable mode is exactly the state in which nothing should be typed at all.
 *
 * The pending marker is deliberately left in place: the cycler clears it once its first
 * keystroke lands, so a helper that dies before touching the pane leaves the request for
 * the next turn to retry, the same contract sendKeys gives the typed commands.
 */
function deliverPermissionMode(hermitRoot: string, sessionName: string, pending: PendingCommand): void {
  const target = pending.arg ? normalizePermissionMode(pending.arg) : null;
  // The prompt stage refuses an unsettable mode before a marker is ever written; the
  // actuator re-checks anyway, because a marker reaching here from anywhere else (a
  // hand-edited or model-written state file) must not be able to steer the session into
  // `plan` — the one refused mode that IS in the cycle, and the one that can leave the
  // session unable to receive the command undoing it. Dropped rather than kept: no later
  // turn can make it deliverable, so retrying it until the TTL only respawns this path.
  if (!target || !CHANNEL_SETTABLE_MODES.has(target)) {
    clearPendingCommand(hermitRoot);
    const why = target ? 'is not settable from a channel' : 'does not name a permission mode';
    console.error(`[stop-pipeline] harness-command: "${renderCommand(pending)}" ${why} — dropped`);
    return;
  }

  const pane = capturePane(sessionName);
  const current = pane === null ? null : paneModeLine(pane);
  if (!current) {
    console.error('[stop-pipeline] harness-command: cannot read the permission mode from the pane — marker kept for retry');
    return;
  }

  const helper = path.join(import.meta.dir, '..', 'cycle-permission-mode.ts');
  const child = Bun.spawn([process.execPath, helper, sessionName, target, hermitRoot], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env: process.env,
  });
  child.unref();
  console.error(`[stop-pipeline] harness-command: cycling ${current} → ${target} (requested by ${pending.by})`);
}

/**
 * Deliver a pending channel-requested harness command into the pane.
 *
 * Guards, in order: marker present and within TTL; runtime readable; not interactive
 * (those sessions have no tmux_session); no lifecycle transition or shutdown in flight
 * (the same runtime stamps passesLifecycleGuards checks in hermit-watchdog.ts — a /clear
 * landing mid-archive would destroy the context session-close is still writing from);
 * tmux session alive. The marker is deleted ONLY on a confirmed send — sendKeys returning
 * false means tmux never accepted the keys, so leaving the marker lets the next turn retry
 * rather than silently dropping the request.
 *
 * A /clear additionally routes the hermit-owned bookkeeping through applyContextReset, so
 * an operator-initiated clear leaves the same trace a watchdog-initiated one does —
 * without it the status cache would survive and the watchdog could fire a spurious
 * /compact against the freshly-cleared context. /compact deliberately gets NOTHING: it is
 * exactly what an operator typing /compact in the pane already does, PreCompact fires for
 * a manual /compact and writes the breadcrumb itself (precompact-stamp.ts), and
 * context_cleared is /clear's marker alone (the watchdog's compact tier never sets it).
 *
 * Every path here is anchored to `hermitRoot`, reads included: the runtime object read
 * below is the same object applyContextReset writes back to `hermitRoot/state`, and a
 * cwd-relative read would pair a drifted (or decoy) source with an anchored write — the
 * exact split context-reset.ts already had to fix once.
 */
export function drainHarnessCommand(hermitRoot: string): void {
  const pending = readPendingCommand(hermitRoot);
  if (!pending) return;

  const runtime = readRuntimeJson(path.join(hermitRoot, 'state'));
  if (!runtime || runtime.runtime_mode === 'interactive') return;
  if (runtime.transition || runtime.shutdown_requested_at || runtime.shutdown_completed_at) return;

  const sessionName: string = runtime.tmux_session ?? '';
  if (!sessionName || !tmuxSessionAlive(sessionName)) return;

  const text = renderCommand(pending);

  // A permission mode is not typed — Claude Code has no slash command that sets one, so
  // the text would land as a prompt. It is reached by driving the same Shift+Tab cycle a
  // human uses, which needs a pane that can be read between keystrokes; that belongs in a
  // detached helper for the same reason the /model confirmation does (Claude renders
  // nothing until this hook returns).
  if (pending.command === '/permission-mode') {
    deliverPermissionMode(hermitRoot, sessionName, pending);
    return;
  }

  if (!sendKeys(sessionName, text)) {
    console.error(`[stop-pipeline] harness-command: tmux refused "${text}" — marker kept for retry`);
    return;
  }

  if (pending.command === '/doctor' && pending.reply_to) {
    writeSkillRelay(hermitRoot, {
      command: pending.command,
      arg: pending.arg,
      by: pending.by,
      reply_to: pending.reply_to,
      delivered_at: new Date().toISOString(),
    });
  }
  clearPendingCommand(hermitRoot);

  // Claude does not process the submitted slash command until this Stop hook returns.
  // Delegate the narrowly-scoped confirmation check so it can observe the resulting
  // dialog after this process exits; doing a synchronous capture here races a pane that
  // cannot render yet.
  //
  // /advisor is deliberately NOT in this gate: it has no cached-context dialog to
  // confirm and no self-perception gap to correct (the advisor is a tool attachment,
  // not the serving model) — live-probed CC 2.1.240, every argument form renders
  // inline. It falls through to the plain sendKeys above and needs nothing further.
  if (pending.command === '/model' || pending.command === '/effort') {
    // The session cannot see its own switch: the model's sense of which model it runs
    // is fixed at session start. Leave a marker so the prompt path answers that from
    // the transcript instead of from stale self-perception (lib/prompt-stages/
    // harness-verify.ts). Only a confirmed send reaches here, so the marker can never
    // describe a switch that was not delivered.
    writeSwitchVerify(hermitRoot, {
      command: pending.command,
      arg: pending.arg,
      by: pending.by,
      delivered_at: new Date().toISOString(),
    });

    const helper = path.join(import.meta.dir, '..', 'confirm-harness-switch.ts');
    // The follow-up leg is re-parsed here, not just checked for its command name: the
    // helper refuses an argv it cannot parse and exits without answering the /model
    // dialog, so a marker carrying a malformed `then` (hand-edited or model-written)
    // would leave the resident sitting at an unanswered modal. Dropping the follow-up
    // keeps the /model leg confirmable.
    const followUpText = pending.command === '/model' && pending.then?.command === '/effort'
      ? renderCommand(pending.then) : null;
    const followUp = followUpText && parseHarnessCommand(followUpText)?.command === '/effort'
      ? [followUpText] : [];
    const child = Bun.spawn([process.execPath, helper, sessionName, pending.command, ...followUp], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env: process.env,
    });
    child.unref();
  }

  // Bookkeeping AFTER the confirmed send, not before: a refused send keeps the marker for
  // the next turn, and a pre-send stamp would have recorded a reset that never happened —
  // then re-recorded it on every retry until the TTL expired.
  if (pending.command === '/clear') {
    applyContextReset(hermitRoot, runtime, {
      kind: 'cleared',
      trigger: 'channel',
      hhmm: currentHHMMOrUTC(readSettledConfig(hermitRoot).timezone ?? 'UTC'),
    });
  }
  console.error(`[stop-pipeline] harness-command: delivered "${text}" (requested by ${pending.by})`);
}
