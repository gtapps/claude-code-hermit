import fs from 'node:fs';
import path from 'node:path';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { helperCommandTarget, permissionModeRefusal, parseHarnessCommand } from './harness-command';
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
  // Per-helper launch overrides set by the `harness` verb's relaunch. Absent on
  // existing bindings and on any record that has not had one applied; cleared
  // together on the next `!restart` (generation: '+1') since a fresh helper
  // launches from config defaults again, not from the stopped helper's overrides.
  model?: string;
  effort?: string;
  permission_mode?: string;
  advisor?: string;
}
// The four launch overrides additionally accept `null`, meaning "delete this
// field" — how `harness()` below restores a record to its pre-attempt shape
// after a failed relaunch, distinct from ordinary omission (leave unchanged).
export type ConversationPatch =
  & Partial<Omit<Conversation, 'created' | 'generation' | 'model' | 'effort' | 'permission_mode' | 'advisor'>>
  & { generation?: '+1' }
  & { model?: string | null; effort?: string | null; permission_mode?: string | null; advisor?: string | null };
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

const OVERRIDE_FIELDS = ['model', 'effort', 'permission_mode', 'advisor'] as const;

export function update(dir: string, key: string, patch: ConversationPatch): void {
  checkKey(key);
  withStore(dir, true, store => {
    const record = store[key];
    if (!record) throw new Error('not-found');
    const { generation, ...fields } = patch;
    const next: Conversation = { ...record, ...(fields as Partial<Conversation>), generation: record.generation + (generation === '+1' ? 1 : 0), last_activity: new Date().toISOString() };
    for (const field of OVERRIDE_FIELDS) {
      if (generation === '+1' || (fields as Record<string, unknown>)[field] === null) delete next[field];
    }
    store[key] = next;
  });
}

export function unbind(dir: string, key: string): void {
  checkKey(key);
  withStore(dir, true, store => { delete store[key]; });
}

const JOB_ID = /^[0-9a-f]{8}$/;
const JOB_FIELD_CAP = 120;

export type HelperStatusRow = {
  name: unknown;
  sessionId: unknown;
  state: unknown;
  detail?: string;
  tempo?: string;
  needs?: string;
  age_s?: number;
};

function cappedField(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.slice(0, JOB_FIELD_CAP);
}

export function helperStatus(agentsText: string, jobsDir: string, nowMs: number): HelperStatusRow[] {
  let agents: unknown;
  try { agents = JSON.parse(agentsText); } catch { return []; }
  if (!Array.isArray(agents)) return [];
  const rows: HelperStatusRow[] = [];
  for (const agent of agents) {
    if (agent?.kind !== 'background') continue;
    const row: HelperStatusRow = { name: agent.name, sessionId: agent.sessionId, state: agent.state };
    const id = agent.id;
    if (typeof id === 'string' && JOB_ID.test(id)) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8'));
        if (job && typeof job === 'object' && !Array.isArray(job)) {
          const rec = job as Record<string, unknown>;
          const detail = cappedField(rec.detail);
          if (detail) row.detail = detail;
          if (typeof rec.tempo === 'string') row.tempo = rec.tempo;
          const needs = cappedField(rec.needs);
          if (needs) row.needs = needs;
          if (typeof rec.updatedAt === 'string') {
            const updated = Date.parse(rec.updatedAt);
            if (Number.isFinite(updated)) row.age_s = Math.floor((nowMs - updated) / 1000);
          }
        }
      } catch {}
    }
    rows.push(row);
  }
  return rows;
}

export async function awaitAgent(
  bgId: string,
  opts: { timeoutMs: number; readRegistry: () => unknown },
): Promise<{ sessionId: string; cwd: string } | null> {
  if (!JOB_ID.test(bgId)) throw new Error('invalid-bg-id');
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    let agents: unknown = opts.readRegistry();
    if (typeof agents === 'string') {
      try { agents = JSON.parse(agents); } catch { agents = []; }
    }
    const entry = Array.isArray(agents) ? agents.find(agent => agent?.id === bgId) : undefined;
    if (entry && typeof entry.sessionId === 'string' && typeof entry.cwd === 'string') {
      return { sessionId: entry.sessionId, cwd: entry.cwd };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await Bun.sleep(Math.min(1000, remaining));
  }
}

// --- harness: stop and relaunch a bound helper for a helper-scoped command ---
//
// `/compact` resumes flagless in place (same session id, saved options kept).
// `/model`, `/effort`, `/permission-mode`, `/advisor` resume flagged, which
// Claude Code forks into a copy: every saved launch option is dropped by that
// fork, so this stores the new value on the record first and re-passes every
// stored override on the relaunch, not just the one that changed. See the
// plan's "Harness premises" table for the probed behavior this leans on.

export type HarnessSpawn = (argv: string[], opts?: { cwd?: string }) => { stdout: string; exitCode: number };
export type HarnessDeps = {
  spawn: HarnessSpawn;
  readRegistry: () => unknown;
  awaitTimeoutMs?: number;
};

const HARNESS_FIELD: Partial<Record<string, typeof OVERRIDE_FIELDS[number]>> = {
  '/model': 'model',
  '/effort': 'effort',
  '/permission-mode': 'permission_mode',
  '/advisor': 'advisor',
};

const HARNESS_NOTICE = 'The operator changed a session setting from chat; no work is requested on this turn.';

/**
 * Stops the helper if it is idle, relaunches it per the parsed harness
 * command, and returns its (unchanged) session name. Throws an Error whose
 * message is one of the CLI's `ERROR|` tokens on any failure; the caller
 * (`conversation.ts`'s `harness` verb) reports it and never stops anything
 * more once one of these fires.
 */
export async function harness(
  dir: string, key: string, command: string, arg: string | null, config: any, deps: HarnessDeps,
): Promise<string> {
  const record = lookup(dir, key);
  if (!record) throw new Error('not-found');

  const parsed = parseHarnessCommand(arg ? `${command} ${arg}` : command);
  if (!parsed || helperCommandTarget(parsed.command) !== 'relaunch') throw new Error('invalid-command');
  if (parsed.command === '/permission-mode' && permissionModeRefusal(parsed.arg!)) throw new Error('invalid-command');

  if (parsed.command !== '/permission-mode') {
    const effectiveMode = record.permission_mode ?? config?.permission_mode;
    if (effectiveMode === 'bypassPermissions') throw new Error('bypass-mode');
  }

  let agents: unknown = deps.readRegistry();
  if (typeof agents === 'string') {
    try { agents = JSON.parse(agents); } catch { agents = []; }
  }
  const entry = Array.isArray(agents) ? agents.find((a: any) => a?.sessionId === record.session_id) : undefined;
  if (entry) {
    // `state` is the blocked/working flag, `status` the idle/busy one, and they are
    // not interchangeable: a helper that finished its turn reports `status: idle`
    // with `state: done`, and a blocked one reports `status: idle` with
    // `state: blocked`. So blocked is read off `state` (first, since its status is
    // idle too) and readiness off `status`. A missing status fails closed.
    if (entry.state === 'blocked') throw new Error('helper-blocked');
    if (entry.status !== 'idle') throw new Error('helper-busy');
    const stopped = deps.spawn(['claude', 'stop', entry.id]);
    if (stopped.exitCode !== 0) throw new Error('stop-failed');
  }

  const argv = ['claude', '--bg', '--resume', record.session_id];
  let updated: Conversation = record;
  let previous: ConversationPatch | null = null;

  if (parsed.command === '/compact') {
    argv.push('/compact');
  } else {
    const field = HARNESS_FIELD[parsed.command];
    if (!field) throw new Error('invalid-command');
    previous = {};
    for (const f of OVERRIDE_FIELDS) previous[f] = record[f] ?? null;
    updated = { ...record, [field]: parsed.arg };
    update(dir, key, { [field]: parsed.arg } as ConversationPatch);
    const permMode = updated.permission_mode ?? config?.permission_mode;
    argv.push('--name', updated.session_name, '--permission-mode', permMode);
    if (updated.model) argv.push('--model', updated.model);
    if (updated.effort) argv.push('--effort', updated.effort);
    if (updated.advisor) argv.push('--advisor', updated.advisor);
    if (config?.remote === true) argv.push('--remote-control', updated.session_name);
    argv.push(HARNESS_NOTICE);
  }

  const result = deps.spawn(argv, { cwd: record.worktree });
  if (result.exitCode !== 0) {
    if (previous) update(dir, key, previous);
    throw new Error('resume-failed');
  }

  const copy = result.stdout.match(/started a copy as ([0-9a-f]{8})/);
  const found = copy && await awaitAgent(copy[1], { timeoutMs: deps.awaitTimeoutMs ?? 120_000, readRegistry: deps.readRegistry });
  update(dir, key, found ? { session_id: found.sessionId, status: 'running' } : { status: 'running' });
  return record.session_name;
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
