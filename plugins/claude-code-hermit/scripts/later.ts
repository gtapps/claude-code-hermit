import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlLine } from './lib/append-jsonl';
import { flagValue, readStdinIfFlagged } from './lib/cli';
import { checkKey } from './lib/conversations';
import { scanForInjection } from './lib/injection-scan';
import { readConfigRaw } from './lib/config-read';
import { compileCron, cronMatchesCompiled, makeTzFormatter, partsFromFormatter } from './lib/cron-match';
import { acquireLockWithWait, releaseLock } from './lib/lockfile';
import { writeFileAtomic } from './lib/md-write';
import { resolveHermitNowMs } from './lib/time';

type State = 'pending' | 'held' | 'broken' | 'indeterminate' | 'cancelled';
interface Row {
  id: string; claim: string; cmd: string | null; chat?: string; due: string; origin: 'operator' | 'hermit';
  session: string | null; created_at: string; state: State;
  timeout_s?: number;
  checked_at?: string; late?: boolean; exit?: number | null; output?: string; reason?: string;
}

const DAY_MS = 86400000;
const MINUTE_MS = 60000;
/** Long enough for a monthly schedule to resolve; one formatter is reused across the scan. */
const SCAN_MINUTES = 32 * 24 * 60;

/** First fire of the enabled `later-check` routine strictly after `after`, or null. */
function nextFire(dir: string, after: Date): Date | null {
  const config = readConfigRaw(dir);
  const routine = config?.routines?.find((r: any) => r?.id === 'later-check');
  if (!routine || routine.enabled !== true) return null;
  const cron = compileCron(String(routine.schedule ?? ''));
  const fmt = makeTzFormatter(config?.timezone ?? null);
  if (!cron || !fmt) return null;
  const first = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let minute = 0; minute < SCAN_MINUTES; minute++) {
    const date = new Date(first + minute * MINUTE_MS);
    const parts = partsFromFormatter(fmt, date);
    if (parts && cronMatchesCompiled(cron, parts)) return date;
  }
  return null;
}

/** Late means the first fire after `due` was missed: checked at or after the second one. */
function isLate(dir: string, row: Row, date: Date): boolean {
  const due = new Date(row.due);
  const first = nextFire(dir, due);
  const second = first && nextFire(dir, first);
  return second ? date.getTime() >= second.getTime() : date.getTime() > due.getTime() + DAY_MS;
}

/** A truncated trailing line (crash mid-append) must not brick every verb; it is dropped on the next rewrite. */
function readRows(file: string): Row[] {
  if (!fs.existsSync(file)) return [];
  const rows: Row[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

function withLedgerLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!acquireLockWithWait(lock, 2000)) throw new Error('ledger lock unavailable; retry');
  try { return fn(); } finally { releaseLock(lock); }
}

/** Re-read under the lock and patch one still-pending row; null when it is no longer pending. */
function updatePending(file: string, id: string, patch: Partial<Row>): Row | null {
  return withLedgerLock(file, () => {
    const rows = readRows(file);
    const row = rows.find(r => r.id === id);
    if (!row || row.state !== 'pending') return null;
    Object.assign(row, patch);
    writeFileAtomic(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 0o600);
    return row;
  });
}

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 300;

async function evidence(cmd: string, root: string, timeoutS: number) {
  const proc = Bun.spawn(['bash', '-c', cmd], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const chunks: Buffer[] = [];
  let size = 0;
  let timedOut = false;
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
  // A backgrounded grandchild inherits the pipes and keeps them open after the
  // kill, so the deadline must also stop waiting on EOF, not just kill the child.
  let deadline: (() => void) | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
    for (const reader of readers) void reader.cancel();
    deadline?.();
  }, Number(process.env.LATER_CHECK_TIMEOUT_MS) || timeoutS * 1000); // env: test-only seam
  async function drain(reader: (typeof readers)[number]) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const kept = Buffer.from(value.subarray(0, Math.max(0, 2048 - size)));
      if (kept.length) chunks.push(kept);
      size += kept.length;
    }
  }
  try {
    const drained = Promise.all([drain(readers[0]), drain(readers[1])]);
    await Promise.race([drained, new Promise<void>(resolve => { deadline = resolve; })]);
    const exit = await proc.exited;
    return { exit, output: new TextDecoder('utf-8').decode(Buffer.concat(chunks), { stream: true }), timed_out: timedOut };
  } finally { clearTimeout(timer); }
}

async function main() {
  const [verb, dirArg, ...args] = process.argv.slice(2);
  if (!dirArg) throw new Error('expected verb and hermit directory');
  const dir = path.resolve(dirArg);
  const file = path.join(dir, 'state', 'hypotheses.jsonl');
  const rows = readRows(file);
  const date = new Date(resolveHermitNowMs());
  if (verb === 'due') {
    console.log(rows.some(row => row.state === 'pending' && new Date(row.due) <= date) ? 'WAKE' : 'SKIP');
    return;
  }
  if (verb === 'add') {
    const claim = flagValue(args, '--claim');
    const cmd = flagValue(args, '--cmd') ?? null;
    const chat = flagValue(args, '--chat');
    if (chat !== undefined) checkKey(chat);
    const due = flagValue(args, '--due');
    const origin = flagValue(args, '--origin');
    if (!claim || !due || !Number.isFinite(Date.parse(due)) || (origin !== 'operator' && origin !== 'hermit')) throw new Error('invalid add arguments');
    const timeoutRaw = flagValue(args, '--timeout-s');
    const timeoutS = timeoutRaw === undefined ? DEFAULT_TIMEOUT_S : Number(timeoutRaw);
    if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > MAX_TIMEOUT_S) throw new Error(`--timeout-s must be an integer between 1 and ${MAX_TIMEOUT_S}`);
    const row: Row = { id: crypto.randomUUID(), claim, cmd, due: new Date(due).toISOString(), origin,
      session: flagValue(args, '--session') ?? null, created_at: date.toISOString(), state: 'pending',
      ...(chat !== undefined ? { chat } : {}),
      ...(timeoutS !== DEFAULT_TIMEOUT_S ? { timeout_s: timeoutS } : {}) };
    const error = withLedgerLock(file, () => appendJsonlLine(file, JSON.stringify(row)));
    if (error) throw new Error(error);
    console.log(`OK|${row.id}|next_fire=${nextFire(dir, date)?.toISOString() ?? 'none'}`);
    return;
  }
  if (verb === 'list') {
    const chat = flagValue(args, '--chat');
    const visible = chat === undefined ? rows : rows.filter(row => row.chat === chat);
    for (const row of [...visible.filter(row => row.state === 'pending'), ...visible.filter(row => row.state !== 'pending').slice(-10)]) {
      const { cmd, output, ...summary } = row;
      console.log(JSON.stringify(summary));
    }
    return;
  }
  if (!['cancel', 'check', 'verdict'].includes(verb)) throw new Error('unknown verb');
  const row = rows.find(row => row.id === args[0]);
  if (!row) throw new Error('unknown id');
  // The row can close between the read above and the locked update (a concurrent cancel or verdict).
  const noop = () => console.log(`NOOP|${readRows(file).find(r => r.id === row.id)?.state ?? row.state}`);
  if (row.state !== 'pending') { noop(); return; }
  if (verb === 'cancel') {
    if (!updatePending(file, row.id, { state: 'cancelled' })) { noop(); return; }
    console.log(`OK|${row.id}|cancelled`);
    return;
  }
  if (verb === 'check') {
    const hit = scanForInjection(row.claim) || (row.cmd != null && scanForInjection(row.cmd));
    if (hit) {
      const reason = `injection-suspect:${hit.cls}`;
      if (!updatePending(file, row.id, { state: 'indeterminate', reason, checked_at: date.toISOString(), late: isLate(dir, row, date) })) { noop(); return; }
      console.log(reason);
      return;
    }
    const result = row.cmd == null
      ? { exit: null, output: '', timed_out: false }
      : await evidence(row.cmd, path.dirname(dir), row.timeout_s ?? DEFAULT_TIMEOUT_S);
    if (!updatePending(file, row.id, { exit: result.exit, output: result.output })) { noop(); return; }
    console.log(JSON.stringify({ ...row, ...result, late: isLate(dir, row, date) }));
    return;
  }
  const state = args[1];
  if (!['held', 'broken', 'indeterminate'].includes(state) || !args.includes('--reason-stdin')) throw new Error('invalid verdict arguments');
  const reason = (await readStdinIfFlagged(args, '--reason-stdin')).trim().split(/\r?\n/)[0];
  if (!reason) throw new Error('reason required');
  if (!updatePending(file, row.id, { state: state as State, reason, checked_at: date.toISOString(), late: isLate(dir, row, date) })) { noop(); return; }
  console.log(`OK|${row.id}|${state}`);
}

if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1; });
