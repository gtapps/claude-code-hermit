import fs from 'node:fs';
import path from 'node:path';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { writeFileAtomic } from './md-write';

export type ConversationStatus = 'running' | 'idle' | 'parked' | 'unknown';
export interface Conversation {
  session_name: string;
  session_id: string;
  worktree: string;
  generation: number;
  card: { chat_id: string; message_id: string } | null;
  muted: boolean;
  created: string;
  last_activity: string;
  status: ConversationStatus;
}
export type ConversationPatch = Partial<Omit<Conversation, 'created' | 'generation'>> & { generation?: '+1' };
type Store = Record<string, Conversation>;

function withStore<T>(dir: string, write: boolean, run: (store: Store) => T): T {
  const file = path.join(dir, 'state', 'conversations.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  if (!acquireLockWithWait(lock, 2000)) throw new Error('lock-unavailable');
  try {
    let store: Store;
    try { store = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw new Error('invalid-store');
      store = {};
    }
    if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error('invalid-store');
    const result = run(store);
    if (write) writeFileAtomic(file, JSON.stringify(store, null, 2) + '\n');
    return result;
  } finally { releaseLock(lock); }
}

// `<sourceKey>:<chat_id>`. The source half is a config key, so it stays bare word
// characters; the chat-id half has to admit what real channels hand out — Discord
// snowflakes and Telegram's negative ids, but also iMessage GUIDs (`iMessage;-;+1555…`)
// and whatever a marketplace channel plugin supplies. The charset stays free of
// whitespace, colons, and markup so the key can still be interpolated into
// model-facing context and split back apart on its single separator.
export function checkKey(key: string): void {
  if (!/^[\w-]+:[\w.~+@;=-]{1,128}$/.test(key)) throw new Error('invalid-key');
}

export function lookup(dir: string, key: string): Conversation | null {
  checkKey(key);
  return withStore(dir, false, store => store[key] ?? null);
}

export function list(dir: string): Store {
  return withStore(dir, false, store => store);
}

export function bind(dir: string, key: string, input: Pick<Conversation, 'session_name' | 'session_id' | 'worktree'>): void {
  checkKey(key);
  if (!input.session_name || !input.session_id || !path.isAbsolute(input.worktree)) throw new Error('invalid-binding');
  withStore(dir, true, store => {
    if (store[key]) throw new Error('already-bound');
    const now = new Date().toISOString();
    store[key] = { ...input, generation: 1, card: null, muted: false, created: now, last_activity: now, status: 'running' };
  });
}

export function update(dir: string, key: string, patch: ConversationPatch): void {
  checkKey(key);
  withStore(dir, true, store => {
    const record = store[key];
    if (!record) throw new Error('not-found');
    const { generation, ...fields } = patch;
    store[key] = { ...record, ...fields, generation: record.generation + (generation === '+1' ? 1 : 0), last_activity: new Date().toISOString() };
  });
}

export function unbind(dir: string, key: string): void {
  checkKey(key);
  withStore(dir, true, store => { delete store[key]; });
}

export function prune(dir: string, agentsText: string): void {
  withStore(dir, false, store => {
    let agents: unknown;
    try { agents = JSON.parse(agentsText); } catch { return; }
    if (!Array.isArray(agents) || agents.length === 0) return;
    const ids = new Set(agents.map(agent => agent?.sessionId).filter(id => typeof id === 'string'));
    let changed = false;
    for (const record of Object.values(store)) {
      if ((record.status === 'running' || record.status === 'idle') && !ids.has(record.session_id)) {
        record.status = 'unknown';
        changed = true;
      }
    }
    if (changed) writeFileAtomic(path.join(dir, 'state', 'conversations.json'), JSON.stringify(store, null, 2) + '\n');
  });
}
