import { lookup } from '../conversations';
import { resolveSlashCommand } from '../channel-slash-address';
import { channelBotIdentity, isAllowedSender, isSelfMentioned } from '../channel-auth';
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
    // `!help` is answerable anywhere, so it gets its annotation rather than the
    // "needs a binding" refusal — without one the model has nothing to act on.
    if (conversationCommand) {
      return { context: name === 'help' ? '[conversation command: help]' : '[conversation command outside a bound conversation]' };
    }
    return;
  }
  ctx.conversation = { key, record };
  const context = `[bound conversation ${key}: ${record.status}, muted=${record.muted}]`;
  if (name === 'model' || name === 'effort') {
    ctx.skipHarnessCommand = true;
    return { context: `${context}\n[conversation command refused: per-conversation model/effort not supported]` };
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
