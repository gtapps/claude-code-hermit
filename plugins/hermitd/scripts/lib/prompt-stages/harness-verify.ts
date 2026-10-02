// UserPromptSubmit stage — report a delivered harness switch back to the session, from
// the transcript for /model and /effort, and from the pane for /permission-mode.
//
// The gap this closes: delivery works (the Stop hook types the command into the pane
// and Claude Code applies it), but the model's sense of WHICH model it is running is
// fixed at session start and does not follow the switch. Asked "did it work?", the
// session answered from that stale self-perception and reported a working switch as a
// silent failure — twice, on two hermits, one of which then filed an upstream bug for
// a bug that did not exist.
//
// So the answer comes from the transcript instead, where the serving model is stamped
// on every assistant entry. This stage states the fact and nothing more; how it reaches
// the operator is the model's business.
//
// The timestamp gate is the whole correctness argument: on the prompt immediately after
// delivery the newest assistant entry is still the PRE-switch one, so reporting it would
// reproduce exactly the stale answer this exists to prevent. Until an entry newer than
// the delivery exists, the marker is held and the session is told only that its
// self-perception may be stale.

import { readSwitchVerify, clearSwitchVerify, renderCommand, HARNESS_CONFIRM_TIMEOUT_MS } from '../harness-command';
import { lastAssistantModel } from '../cc-compat';
import { capturePane, paneModeLine } from '../tmux';
import type { StageContext, StageResult } from './types';

/**
 * delivered_at is stamped when the keys hit the pane, but the switch APPLIES only when
 * confirm-harness-switch.ts accepts the dialog — up to its polling deadline later. An
 * assistant entry inside that window postdates the delivery yet was served by the old
 * model, so treating "newer than delivered_at" as "post-switch" would report the old
 * model as authoritative and burn the marker. Holding for the helper's full deadline
 * closes that window at the cost of one extra held prompt at worst.
 */
const SWITCH_APPLY_GRACE_MS = HARNESS_CONFIRM_TIMEOUT_MS;

const SESSION_SCOPED = 'This lasts for the current session only — a restart, including one the watchdog performs, puts the session back on the configured permission mode.';

/**
 * Report the mode the session is actually in now.
 *
 * The pane is authoritative and current, so unlike the model report below this needs no
 * grace window — but it can be unreadable (a dialog covering the status bar, a session
 * that has since gone away), and saying so is the honest answer. Claiming a switch that
 * may not have happened is the one outcome worth avoiding: the operator asked for this to
 * control what the hermit may do unattended.
 */
function permissionModeReport(ctx: StageContext, requested: string | null): string {
  const sessionName = ctx.runtime()?.tmux_session ?? '';
  const pane = sessionName ? capturePane(sessionName) : null;
  const landed = pane === null ? null : paneModeLine(pane);

  if (!landed) {
    return `[harness-command] "/permission-mode ${requested}" was delivered, but the session's permission mode could not be read back from the pane — report it as delivered, not confirmed, and suggest checking the terminal.\n`;
  }
  if (requested && landed !== requested) {
    return `[harness-command] "/permission-mode ${requested}" did not land — the session is in ${landed} mode. Report the failure and the mode it is actually in; do not claim the requested one.\n`;
  }
  return `[harness-command] the session is now in ${landed} permission mode, as requested. ${SESSION_SCOPED}\n`;
}

export function run(ctx: StageContext): StageResult | void {
  const pending = readSwitchVerify(ctx.dir);
  if (!pending) return;

  const rendered = renderCommand(pending);

  // Permission mode is answered from the pane, not the transcript, so it must be routed
  // before the transcript gate below — that gate exists to stop a stale MODEL being
  // reported and would otherwise hold this marker (and describe it in model terms) while
  // waiting for an assistant entry that has no bearing on it.
  if (pending.command === '/permission-mode') {
    clearSwitchVerify(ctx.dir);
    return { context: permissionModeReport(ctx, pending.arg) };
  }

  const observed = ctx.transcriptPath ? lastAssistantModel(ctx.transcriptPath) : null;

  // No transcript to read, or nothing served since the switch could have applied: hold
  // the marker and warn rather than answer from a pre-switch entry.
  if (!observed || Date.parse(observed.timestamp) <= Date.parse(pending.delivered_at) + SWITCH_APPLY_GRACE_MS) {
    return {
      context: `[harness-command] "${rendered}" was delivered to this session at ${pending.delivered_at} and is not yet observable in the transcript. Your own sense of which model you run is fixed at session start and does not follow a switch — do not report it as the active one.\n`,
    };
  }

  clearSwitchVerify(ctx.dir);
  // The transcript stamps only the serving model. That verifies a /model switch
  // outright; for /effort it can confirm delivery but not the new effort level, and
  // saying otherwise would be a false positive the transcript cannot support.
  if (pending.command === '/effort') {
    return {
      context: `[harness-command] "${rendered}" was delivered at ${pending.delivered_at}. The transcript stamps only the serving model (currently ${observed.model}), not the effort level, so report the switch as delivered — not as confirmed.\n`,
    };
  }
  return {
    context: `[harness-command] "${rendered}" delivered at ${pending.delivered_at} — the transcript now reports model ${observed.model}. That is the session's serving model; prefer it over your own sense of which model you run.\n`,
  };
}
