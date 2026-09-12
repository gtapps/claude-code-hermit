import { isTrustedController } from './lib/channel-auth';
import { createThread, isThreadType, lookupChat } from './lib/channel-chats';
import { conversationHistory } from './lib/channel-log';
import { readSettledConfig } from './lib/config-read';
import { bind, list, lookup, prune, unbind, update, type ConversationPatch } from './lib/conversations';

function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    // Normalize before the duplicate check, not after: `--session-name` lands under
    // `session_name`, so testing the raw spelling never sees the key it just wrote.
    const key = name?.startsWith('--') ? name.slice(2).replaceAll('-', '_') : null;
    if (!key || value === undefined || Object.hasOwn(result, key)) throw new Error('invalid-options');
    result[key] = value;
  }
  return result;
}

async function main(): Promise<void> {
  const [dir, verb, key, ...args] = process.argv.slice(2);
  if (!dir || !verb) throw new Error('usage');
  if (verb === 'prune') {
    if (key) throw new Error('invalid-options');
    prune(dir, await Bun.stdin.text());
    console.log('OK|prune');
    return;
  }
  if (verb === 'list') {
    if (key) throw new Error('invalid-options');
    console.log(JSON.stringify(list(dir)));
    return;
  }
  // Keyless verbs wrapping the channel library calls channel-responder makes
  // around a binding. A CLI verb rides the script's allow-list grant; the
  // `bun -e` import the skill used to name draws a classifier denial and matches
  // no prefix rule (apply-settings.ts), so on a live hermit the call never ran.
  if (['history', 'chat-lookup', 'thread-create', 'is-trusted'].includes(verb)) {
    const opts = options(key ? [key, ...args] : args);
    const require = (names: string[], optional: string[] = []) => {
      if (Object.keys(opts).some(k => !names.includes(k) && !optional.includes(k))) throw new Error('invalid-options');
      for (const name of names) if (!opts[name]) throw new Error(`missing-${name.replaceAll('_', '-')}`);
    };
    const config = readSettledConfig(dir);
    switch (verb) {
      case 'history': {
        require(['source', 'chat_id'], ['limit']);
        const limit = opts.limit === undefined ? 100 : Number(opts.limit);
        if (!Number.isInteger(limit) || limit <= 0) throw new Error('invalid-limit');
        console.log(JSON.stringify(conversationHistory(dir, opts.source, opts.chat_id, { limit })));
        return;
      }
      case 'chat-lookup': {
        require(['chat_id']);
        const chat = await lookupChat(dir, config, opts.chat_id);
        if (!chat) throw new Error('not-found');
        console.log(JSON.stringify({ ...chat, thread: isThreadType(chat) }));
        return;
      }
      case 'thread-create': {
        require(['chat_id', 'message_id', 'name']);
        const id = await createThread(dir, config, opts.chat_id, opts.message_id, opts.name);
        if (!id) throw new Error('thread-failed');
        console.log(`OK|${id}`);
        return;
      }
      case 'is-trusted': {
        require(['source', 'user_id', 'chat_id']);
        // Asserts, not answers: a denial is ERROR|untrusted so a caller reading
        // only the exit code fails closed, like every other verb here.
        if (!isTrustedController(config, opts.source, opts.user_id, opts.chat_id)) throw new Error('untrusted');
        console.log('OK|trusted');
        return;
      }
    }
  }
  if (!key) throw new Error('missing-key');
  const opts = options(args);
  switch (verb) {
    case 'lookup': {
      if (args.length) throw new Error('invalid-options');
      const record = lookup(dir, key);
      if (!record) throw new Error('not-found');
      console.log(JSON.stringify(record));
      return;
    }
    case 'bind':
      if (Object.keys(opts).some(k => !['session_name', 'session_id', 'worktree'].includes(k))) throw new Error('invalid-options');
      bind(dir, key, { session_name: opts.session_name ?? '', session_id: opts.session_id ?? '', worktree: opts.worktree ?? '' });
      break;
    case 'update': {
      const patch: ConversationPatch = {};
      for (const [name, value] of Object.entries(opts)) {
        switch (name) {
          case 'status':
            if (!['running', 'idle', 'parked', 'unknown'].includes(value)) throw new Error('invalid-status');
            patch.status = value as ConversationPatch['status'];
            break;
          case 'muted':
            if (value !== 'true' && value !== 'false') throw new Error('invalid-muted');
            patch.muted = value === 'true';
            break;
          case 'generation':
            if (value !== '+1') throw new Error('invalid-generation');
            patch.generation = value;
            break;
          case 'session_name': case 'session_id': case 'worktree':
            if (!value) throw new Error('invalid-binding');
            patch[name] = value;
            break;
          case 'card': {
            const card = JSON.parse(value);
            if (card !== null && (typeof card?.chat_id !== 'string' || typeof card?.message_id !== 'string' || Object.keys(card).length !== 2)) throw new Error('invalid-card');
            patch.card = card;
            break;
          }
          default: throw new Error('invalid-options');
        }
      }
      update(dir, key, patch);
      break;
    }
    case 'unbind':
      if (args.length) throw new Error('invalid-options');
      unbind(dir, key);
      break;
    default: throw new Error('unknown-verb');
  }
  console.log(`OK|${key}`);
}

if (import.meta.main) {
  main().catch(error => {
    const token = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'operation-failed';
    console.log(`ERROR|${token}`);
    process.exitCode = 1;
  });
}
