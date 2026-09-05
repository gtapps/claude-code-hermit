// UserPromptSubmit stage — deterministic harness-command recorder.
//
// Native Claude Code slash commands that control the HARNESS (/model, /effort,
// /compact, /clear) are unreachable from a channel: inbound channel prompts are
// enqueued with `skipSlashCommands:true` (probe-verified, see
// compiled/spike-channel-block-responder-probe-2026-07-04.md), so the text arrives as
// literal prose and the model can only look for a matching *skill*, which never exists.
//
// Harness state cannot be written to a file the way pause.json can — it has to be driven
// through the pane. So this hook does the deterministic half (authorize + record) and the
// Stop hook does the delivery, once the turn it arrived on has ended and the pane is
// idle. Splitting it this way keeps the authorization model identical to pause-keyword.ts
// and never types into a pane mid-turn.
//
// /permission-mode is the exception to "typed into the pane": no native slash command sets
// a permission mode, so the Stop hook drives Claude Code's own Shift+Tab cycle instead
// (lib/harness-drain.ts → cycle-permission-mode.ts). Only the modes a channel may steer
// the session into are recorded; the rest are refused here with a reason.
//
// Probe-verified limit (inherited from pause-keyword.ts): a UserPromptSubmit hook only
// fires BETWEEN turns. A command sent while a turn is genuinely in flight arrives as
// steering text and lands when that turn ends, not during it. Background work still
// counts as idle.
//
// Gated by isTrustedController — the same stricter-than-a-plain-reply gate pause uses,
// because these commands mutate session state. An unauthorized sender is a silent no-op:
// no marker, no stdout, so the mechanism can't be probed by an unauthorized prompt.

import { safeForLLM } from '../sanitize';
import { senderLabel } from '../channel-envelope';
import { isTrustedController, channelBotIdentity } from '../channel-auth';
import { parseHarnessCommand, writePendingCommand, renderCommand, permissionModeRefusal } from '../harness-command';
import { resolveSlashCommand } from '../channel-slash-address';
import type { StageContext, StageResult } from './types';

export function run(ctx: StageContext): StageResult | void {
  const env = ctx.envelope;
  if (!env) return;
  if (!env.body) return;

  const dir = ctx.dir;
  const config = ctx.config();

  // Addressing runs BEFORE the grammar, not inside it: parseHarnessCommand stays a
  // pure harness parser that knows nothing about channels. Resolving here is what
  // makes a Telegram group's `/clear@thebot` and a mention-gated `<@us> /clear`
  // work, and keeps `/clear@someoneelse` a no-op.
  const addressed = resolveSlashCommand(env.body, channelBotIdentity(config, env.source));
  if (!addressed) return;

  const parsed = parseHarnessCommand(`${addressed.command}${addressed.rest}`);
  if (!parsed) return;

  const authorized = isTrustedController(config, env.source, env.userId, env.chatId);
  if (!authorized) return; // unauthorized — silent no-op

  // Interactive sessions store tmux_session: null (hermit-start.ts), so there is no pane
  // to deliver into. Refuse HERE rather than recording a marker the drain could never
  // consume — otherwise the operator gets an acknowledgement for a command that silently
  // never happens.
  const runtime = ctx.runtime();
  if (!runtime || runtime.runtime_mode === 'interactive' || !runtime.tmux_session) return;

  // Refuse an unsettable permission mode HERE, for the same reason the interactive check
  // above refuses: recording a marker the drain will not act on would acknowledge a switch
  // that never happens. Unlike an unauthorized sender this is not silent — the request was
  // legitimate, so the operator gets told why it is being declined.
  if (parsed.command === '/permission-mode' && parsed.arg) {
    const refusal = permissionModeRefusal(parsed.arg);
    if (refusal) {
      return {
        context: `[harness-command] refused "${renderCommand(parsed)}": ${refusal}\n`,
      };
    }
  }

  const by = safeForLLM(senderLabel(env).slice(0, 64));
  const isRelayedSkillCommand = parsed.command === '/doctor';
  const ok = writePendingCommand(dir, {
    command: parsed.command,
    arg: parsed.arg,
    by,
    ...(isRelayedSkillCommand ? { reply_to: { source: env.source, chat_id: env.chatId } } : {}),
    requested_at: new Date().toISOString(),
  });
  if (!ok) return;

  const rendered = renderCommand(parsed);
  return {
    context: isRelayedSkillCommand
      ? `[harness-command] "${rendered}" requested by ${by} — will run when the current turn ends; its result comes back to this chat.\n`
      : `[harness-command] "${rendered}" requested by ${by} — will be applied to this session when the current turn ends.\n`,
  };
}
