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
