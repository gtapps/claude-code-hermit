import { readTasks } from '../tasks';
import { lookup } from '../conversations';
import { resolveSlashCommand } from '../channel-slash-address';
import { channelBotIdentity, isAllowedSender, isHomeChat, isSelfMentioned, isTrustedController } from '../channel-auth';
import { cachedChat } from '../channel-chats';
import { helperCommandTarget, parseHarnessCommand, permissionModeRefusal } from '../harness-command';
import { safeForLLM } from '../sanitize';
import { capture } from './channel-reply-reminder';
import type { StageContext, StageResult } from './types';

// `!fork` is the one conversation command that carries free text, and that text is
// the sender's raw message body. Every other stage that puts channel-derived text
// into additionalContext clamps and defuses it first (channel-reply-reminder,
// pause-keyword, harness-command); without that an allowed sender can embed a
// newline and forge a hook-authored line the model is told to trust.
const MAX_ARGS_LEN = 400;

export async function run(ctx: StageContext): Promise<StageResult | void> {
  const env = ctx.envelope;
  if (!env || !isAllowedSender(ctx.config(), env.source, env.userId)) return;
  const key = `${env.sourceKey}:${env.chatId}`;
  const record = lookup(ctx.dir, key);
  const addressed = resolveSlashCommand(env.body, channelBotIdentity(ctx.config(), env.source));
  const name = addressed?.command.slice(1);
  const args = addressed?.rest.trim() ?? '';
  const conversationCommand = name && (
    (['help', 'mute', 'unmute', 'restart'].includes(name) && !args)
    || (name === 'fork' && !!args)
  );
  const safeArgs = safeForLLM(args.slice(0, MAX_ARGS_LEN));
  if (!record) {
    const residentTask = !conversationCommand
      && (env.sourceKey !== 'discord' || ![0, 5].includes(cachedChat(ctx.dir, env.chatId)?.type ?? -1))
      && readTasks(ctx.dir).find(task => task.status === 'open'
        && task.owner === 'resident' && task.conversation === key);
    if (residentTask) {
      ctx.conversation = { key, owner: 'resident' };
      return { context: `[resident task thread ${safeForLLM(key)}]` };
    }
    // `!help` is answerable anywhere, so it gets its annotation rather than the
    // "needs a binding" refusal — without one the model has nothing to act on.
    if (conversationCommand) {
      return { context: name === 'help' ? '[conversation command: help]' : '[conversation command outside a bound conversation]' };
    }
    return;
  }
  ctx.conversation = { key, record };
  const context = `[bound conversation ${key}: ${record.status}, muted=${record.muted}]`;
  // A harness command (/clear, /compact, /model, /effort, /permission-mode,
  // /advisor) in a bound, non-home chat from an allowed sender acts on the
  // helper instead of the resident: route it here and skip the harness-command
  // stage entirely so no pending-harness-command.json marker is ever written for
  // it. /doctor stays resident (it is a relayed skill invocation, not a session
  // setting), and the home chat always keeps its existing resident behavior —
  // when either condition fails, fall through as if this branch did not exist.
  //
  // The sender gate is this stage's own isAllowedSender check above, deliberately
  // not isTrustedController: outside the home chat that gate reduces to the
  // pinned-home binding whenever no allowed_users list exists, so requiring it
  // here would make the branch unsatisfiable on an accept-all channel and send
  // the command to the resident instead. An allowed sender in a bound chat can
  // already steer this helper with arbitrary prose, so its launch options are not
  // a wider authority.
  //
  // /permission-mode is the exception: no amount of prose changes a helper's
  // permission mode, so that one keeps the stricter controller gate. An allowed
  // but untrusted sender falls through instead, where the harness-command stage's
  // own isTrustedController check turns it into a silent no-op.
  const harnessParsed = addressed && parseHarnessCommand(`${addressed.command}${addressed.rest}`);
  const helperTarget = harnessParsed && helperCommandTarget(harnessParsed.command);
  const helperAuthorized = harnessParsed?.command !== '/permission-mode'
    || isTrustedController(ctx.config(), env.source, env.userId, env.chatId);
  if (harnessParsed && helperTarget && helperAuthorized
    && !isHomeChat(ctx.config(), env.source, env.chatId)) {
    ctx.skipHarnessCommand = true;
    if (helperTarget === 'restart') {
      return { context: `${context}\n[conversation command: restart]` };
    }
    if (harnessParsed.command === '/permission-mode' && harnessParsed.arg) {
      const refusal = permissionModeRefusal(harnessParsed.arg);
      if (refusal) return { context: `${context}\n[conversation command refused: ${refusal}]` };
    }
    const arg = harnessParsed.arg ? ` ${harnessParsed.arg}` : '';
    return { context: `${context}\n[conversation command: harness ${harnessParsed.command}${arg}]` };
  }
  if (conversationCommand) return { context: `${context}\n[conversation command: ${name}${safeArgs ? ' ' + safeArgs : ''}]` };
  // Mute silences ordinary steering, not an addressed command: pause/resume/snooze
  // and status are documented as always reachable from chat, and blocking here
  // settles the disposition before their stages ever run.
  if (record.muted && !addressed && !await isSelfMentioned(ctx.dir, ctx.config(), env.sourceKey, env.chatId, env.body)) {
    capture(ctx, env, true);
    return { block: 'muted conversation: recorded' };
  }
  return { context };
}
