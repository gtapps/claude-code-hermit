// `proposal.ts micro <stateDir> …` — mutates state/micro-proposals.json for the
// micro-approval queue. Every mutation goes through here so the file is only ever
// written by JSON.stringify (issue 649: hand-edited JSON left a trailing comma, and
// every reader treats an unparseable file as an empty queue).
// Usage:
//   proposal.ts micro <hermit-state-dir> resolve <MP-id> --action approved|rejected|answered|expired [--answer "<label>"]
//   proposal.ts micro <hermit-state-dir> nudge <MP-id>
//   proposal.ts micro <hermit-state-dir> brief-cycle
//   proposal.ts micro <hermit-state-dir> match [<MP-id>] --reply <token>
// Output (stdout, one line):
//   MATCH|<id>|<yes|no|label>|<tier>|<on_resolve or ->
//   AMBIGUOUS|<reason>|<id>=<opt1>/<opt2>;<id>=...
//   NONE|no-pending
//   RESOLVED|<id>|<action>
//   NUDGED|<id>|<follow_up_count>
//   NONE|no-match
//   brief-cycle: JSON {"new":[{id,tier,question,options}],
//                      "renudged":[{id,tier,question,options,follow_up_count}],
//                      "expired":[{id,question}],
//                      "dropped":[<id>]}
// brief-cycle ages the whole queue in one pass so the brief skills drive the
// count-0/1/2+ lifecycle through one call instead of one per entry: any entry
// whose status isn't "pending" (issue 676 - a caller resolved it elsewhere but
// left it in the array) is pruned into `dropped`, no ledger event (its
// resolution is already recorded). Of the rest: count-0 entries are reported
// for first display and bumped to 1, count-1 entries reported and re-nudged
// (bumped to 2), count>=2 entries expired. One atomic write (only when
// something changed), one micro-resolved ledger line per expiry.
// Exit 1 (+ stderr) on: unparseable micro-proposals.json (never overwritten),
// unknown verb/action, a missing/flag-shaped <MP-id>, missing --action, or a
// ledger-append failure. Every malformed invocation fails loud rather than
// exiting 0 on `NONE|no-match` — a silent no-op is the failure mode this script
// exists to remove. (Targeted resolve/nudge keep `NONE|no-match` exit 0 for a
// well-formed but absent id — channel-responder's benign double-resolve relies
// on it; brief-cycle never emits NONE.)
// Implements channel-responder/approvals.md § Micro-approval response and
// brief/SKILL.md's MP lifecycle step.

import path from 'node:path';
import { utcISOStamp } from '../time';
import { appendJsonlLine } from '../append-jsonl';
import { writeFileAtomic } from '../md-write';
import { emit, flagValue } from '../cli';
import { readMicroProposals } from '../micro-proposals-io';
import { listProposalFiles, readFrontmatter } from '../frontmatter';

type Json = any;

const VERBS = ['resolve', 'nudge', 'match'];
const ACTIONS = ['approved', 'rejected', 'answered', 'expired'];

// A proposal in one of these states can no longer consume an "how should I
// implement this?" answer, so the ask it parked is moot. Re-accepting a
// deferred proposal queues a fresh entry, so sweeping it loses nothing.
export const MOOT_STATUSES = ['resolved', 'dismissed', 'deferred'];

const USAGE = 'Usage: proposal.ts micro <hermit-state-dir> resolve|nudge <MP-id> [--action <a>] [--answer <label>] | match [<MP-id>] --reply <token> | brief-cycle | sweep';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// Age the whole pending queue in one pass. Bucketing mirrors the per-entry rules
// the brief skills used to issue one call at a time: any non-"pending" status is
// pruned first (issue 676), then count 0 -> report + bump to 1, count 1 ->
// report + bump to 2, count >=2 -> expire. Ledger lines are appended only after
// the queue write lands (same ordering as the resolve path).
function briefCycle(dir: string): never {
  const mp = path.join(dir, 'state', 'micro-proposals.json');
  const r = readMicroProposals(mp);
  if (r.status === 'corrupt') fail(`${r.error} — refusing to write. Repair it first.`);
  const data: Json = r.status === 'missing' ? { pending: [] } : r.data;
  // readMicroProposals guarantees data.pending is an array on 'ok' (non-array is
  // 'corrupt', bailed above; undefined/null is healed to []), and 'missing' set [].
  const pending: Json[] = data.pending;

  const fresh: Json[] = [];
  const renudged: Json[] = [];
  const expired: Json[] = [];
  const dropped: Json[] = [];
  const kept: Json[] = [];

  for (const e of pending) {
    // Whitelist, not blacklist — the wild holds accepted/dismissed/rejected/
    // approved/resolved, none of which the script itself ever writes. The `!e`
    // guard mirrors every other reader (generate-summary, startup-context,
    // channel-status-responder): a hand-edited `null` element must not throw
    // and take the whole brief step down with it.
    if (!e || e.status !== 'pending') {
      dropped.push(e?.id ?? null);
      continue; // already resolved elsewhere; no ledger event, no re-report
    }
    const c = typeof e.follow_up_count === 'number' ? e.follow_up_count : 0;
    if (c >= 2) {
      expired.push({ id: e.id, question: e.question });
      continue; // dropped from the queue
    }
    // `tier` rides along: the brief skills render "MP-… (tier N): <question>" and
    // are told not to re-read the queue file, so the verdict is their only source.
    if (c === 1) {
      e.follow_up_count = 2;
      renudged.push({ id: e.id, tier: e.tier, question: e.question, options: e.options, follow_up_count: 2 });
    } else {
      // Bump 0 -> 1 on first display so the documented lifecycle actually ages
      // the entry (issue 676 also found nothing else ever calls `micro nudge`).
      e.follow_up_count = 1;
      fresh.push({ id: e.id, tier: e.tier, question: e.question, options: e.options });
    }
    kept.push(e);
  }

  // Every entry lands in exactly one of dropped/expired/renudged/fresh, so a
  // non-empty queue always changes something on this pass.
  if (pending.length > 0) {
    data.pending = kept;
    writeFileAtomic(mp, JSON.stringify(data, null, 2) + '\n');
    const ledger = path.join(dir, 'state', 'proposal-metrics.jsonl');
    for (const e of expired) {
      const event: Json = { ts: utcISOStamp(), type: 'micro-resolved', micro_id: e.id, action: 'expired', question: e.question };
      const err = appendJsonlLine(ledger, JSON.stringify(event));
      if (err) fail(`${err} — the queue write landed but the micro-resolved event for ${e.id} was NOT recorded. Do not re-run; append it by hand.`);
    }
  }

  emit(JSON.stringify({ new: fresh, renudged, expired, dropped }));
}

// --- Moot-ask reconciliation -----------------------------------------------
// An ask parked by proposal-act's accept flow can be settled elsewhere: the
// hermit implements it in-session, the operator resolves/dismisses/defers the
// proposal, or reflect auto-resolves it. Nothing then cleared the queue entry,
// so the heartbeat kept deriving a pending-decision alert from a question that
// no longer meant anything. The proposal-status writers call sweepMoot() on
// every moot-status write; the `sweep` verb runs the same pass over the whole
// queue (upgrade migration and manual repair).

const PROPOSAL_ID_RE = /^PROP-(\d+)$/;
// Legacy entries (queued before `proposal_id` existed) carry the link only
// inside the accept callback. Match that documented shape alone: `on_resolve`
// is free-form — channel-responder lets any skill set it — so a bare PROP-NNN
// occurring anywhere in an arbitrary command is not a declared link.
const LEGACY_LINK_RE = /proposal-act accept (PROP-\d+)/;

// Canonical ids are zero-padded to 3 digits (proposals/resolve.ts does the same
// on operator input). Normalizing both sides keeps an unpadded `PROP-19` in a
// legacy on_resolve from silently missing `PROP-019-*.md`.
export function normalizeProposalId(id: string): string | null {
  const m = PROPOSAL_ID_RE.exec(id);
  return m ? `PROP-${m[1].padStart(3, '0')}` : null;
}

export function linkedProposalId(entry: Json): string | null {
  if (typeof entry.proposal_id === 'string') {
    const norm = normalizeProposalId(entry.proposal_id);
    if (norm) return norm;
  }
  if (typeof entry.on_resolve === 'string') {
    const m = LEGACY_LINK_RE.exec(entry.on_resolve);
    if (m) return normalizeProposalId(m[1]);
  }
  return null;
}

// Boundary-safe: `PROP-1` must never match `PROP-12` (same rule as
// apply-reflection-actions.ts), and the legacy slug-less `PROP-NNN.md` form
// still counts. Zero or multiple matches are ambiguous — never destructive.
function proposalStatus(proposalsDir: string, files: string[], id: string): string | null {
  const matches = files.filter(f => f.startsWith(`${id}-`) || f === `${id}.md`);
  if (matches.length !== 1) return null;
  const fm = readFrontmatter(path.join(proposalsDir, matches[0]));
  return fm && typeof fm.status === 'string' ? fm.status : null;
}

export type SweepResult = { ok: boolean; swept: string[]; error?: string };

/**
 * Remove pending asks whose linked proposal has reached a moot status.
 * `opts.proposalId` narrows the pass to one proposal (the status writers);
 * omitted, every linked entry is checked (the `sweep` verb).
 * Never throws: an unreadable queue or proposals dir returns ok:false and
 * leaves both untouched, so a caller that already wrote a proposal can report
 * the miss without pretending its own write failed.
 */
export function sweepMoot(stateDir: string, opts: { proposalId?: string } = {}): SweepResult {
  const target = opts.proposalId ? normalizeProposalId(opts.proposalId) : null;
  if (opts.proposalId && !target) return { ok: false, swept: [], error: `not a proposal id: ${opts.proposalId}` };

  const microPath = path.join(stateDir, 'state', 'micro-proposals.json');
  const read = readMicroProposals(microPath);
  if (read.status === 'missing') return { ok: true, swept: [] };
  if (read.status === 'corrupt') return { ok: false, swept: [], error: read.error };
  const micro: Json = read.data;

  const proposalsDir = path.join(stateDir, 'proposals');
  const listed = listProposalFiles(proposalsDir);
  if (!listed.ok) return { ok: false, swept: [], error: 'proposals/ is unreadable — nothing swept' };

  const statusCache = new Map<string, string | null>();
  const kept: Json[] = [];
  const removed: Json[] = [];

  for (const e of micro.pending) {
    // Same `!e` tolerance as every other reader: a hand-edited null element
    // must not throw. Non-pending rows are brief-cycle's to prune, not ours.
    if (!e || e.status !== 'pending') { kept.push(e); continue; }
    const pid = linkedProposalId(e);
    if (!pid || (target && pid !== target)) { kept.push(e); continue; }
    if (!statusCache.has(pid)) statusCache.set(pid, proposalStatus(proposalsDir, listed.files, pid));
    const status = statusCache.get(pid) ?? null;
    if (status === null || !MOOT_STATUSES.includes(status)) { kept.push(e); continue; }
    removed.push({ id: e.id, question: e.question, proposal_id: pid, proposal_status: status });
  }

  if (removed.length === 0) return { ok: true, swept: [] };

  micro.pending = kept;
  try { writeFileAtomic(microPath, JSON.stringify(micro, null, 2) + '\n'); }
  catch (err: any) { return { ok: false, swept: [], error: `micro-proposals.json write failed (${err.message})` }; }

  // Ledger after the write lands, matching the resolve path's ordering.
  // `moot` is its own action: reflect reads a high `expired` rate as poor
  // question timing, which a settled proposal says nothing about.
  const ledger = path.join(stateDir, 'state', 'proposal-metrics.jsonl');
  // Keep appending past a failure and name every id that went unrecorded: the
  // queue write already landed for all of them, so bailing on the first error
  // would leave the later removals silently absent from the ledger AND absent
  // from the message the caller reports.
  const unrecorded: string[] = [];
  let ledgerError: string | null = null;
  for (const r of removed) {
    const event: Json = {
      ts: utcISOStamp(), type: 'micro-resolved', micro_id: r.id, action: 'moot',
      question: r.question, proposal_id: r.proposal_id, proposal_status: r.proposal_status,
    };
    const err = appendJsonlLine(ledger, JSON.stringify(event));
    if (err) { unrecorded.push(r.id); ledgerError = err; }
  }
  if (unrecorded.length > 0) {
    return {
      ok: false,
      swept: removed.map(x => x.id),
      error: `${ledgerError} — ${unrecorded.join(', ')} removed from pending but the micro-resolved event was NOT recorded.`,
    };
  }

  return { ok: true, swept: removed.map(r => r.id) };
}

function sweepCli(stateDir: string): never {
  const result = sweepMoot(stateDir);
  if (!result.ok) fail(result.error ?? 'sweep failed');
  emit(result.swept.length > 0 ? `SWEPT|${result.swept.join(',')}` : 'NONE|no-moot');
}

// Read-only matching leaves resolution and its write ordering with resolve.
function matchReply(stateDir: string, args: string[]): never {
  const hasId = args.length === 4;
  if ((!hasId && args.length !== 3) || args[hasId ? 2 : 1] !== '--reply'
    || (hasId && args[1].startsWith('-'))) fail(USAGE);
  const id = hasId ? args[1] : undefined;
  const reply = args[hasId ? 3 : 2].trim().toLowerCase();
  const read = readMicroProposals(path.join(stateDir, 'state', 'micro-proposals.json'));
  if (read.status === 'corrupt') fail(`${read.error} — refusing to match. Repair it first.`);
  const pending: Json[] = read.status === 'missing' ? []
    : read.data.pending.filter((entry: Json) => entry?.status === 'pending');
  if (!pending.length) emit('NONE|no-pending');
  const entry = id ? pending.find(entry => entry.id === id) : pending[0];
  if (!entry) emit('NONE|no-match');

  // Embedded newlines in operator-authored labels must not split the protocol line.
  const line = (value: unknown): string => String(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const ambiguous = (reason: string, entries: Json[]): never => emit(
    `AMBIGUOUS|${reason}|${entries.map(entry =>
      `${line(entry.id)}=${(entry.options ?? ['yes', 'no']).map(line).join('/')}`).join(';')}`,
  );
  if (!id && pending.length > 1) ambiguous('multiple-pending', pending);
  let answer: string;
  if (entry.options === undefined) {
    if (reply !== 'yes' && reply !== 'no') emit('NONE|no-match');
    answer = reply;
  } else {
    if (!Array.isArray(entry.options) || !entry.options.every((label: unknown) => typeof label === 'string')) {
      fail('micro-proposals.json options must be an array of labels. Repair it first.');
    }
    const options: string[] = entry.options;
    if (reply === 'yes' || reply === 'no') ambiguous('options-require-choice', [entry]);
    if (/^[+-]?\d+$/.test(reply)) {
      const index = Number(reply) - 1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= options.length) {
        ambiguous('number-out-of-range', [entry]);
      }
      answer = options[index];
    } else {
      const matches = reply ? options.filter(label => label.toLowerCase().startsWith(reply)) : [];
      if (!matches.length) emit('NONE|no-match');
      if (matches.length > 1) ambiguous('multiple-labels', [entry]);
      answer = matches[0];
    }
  }
  emit(`MATCH|${line(entry.id)}|${line(answer)}|${line(entry.tier)}|${line(entry.on_resolve ?? '-')}`);
}

export function run(stateDir: string, args: string[]): never {
  const verb = args[0];
  const id = args[1];

  if (!verb) fail(USAGE);

  // brief-cycle and sweep take no <MP-id> — dispatch before the id requirement.
  if (verb === 'brief-cycle') briefCycle(stateDir);
  if (verb === 'sweep') sweepCli(stateDir);
  if (verb === 'match') matchReply(stateDir, args);

  if (!id) fail(USAGE);

  // Validate the whole invocation before touching disk. Otherwise a dropped id
  // (`resolve --action approved`) makes `--action` the id, misses, and exits 0 on
  // NONE|no-match — the entry stays pending and the caller believes it resolved.
  if (!VERBS.includes(verb)) fail(`Unknown verb: ${verb} (expected ${VERBS.join('|')})`);
  if (id.startsWith('-')) fail(`Missing <MP-id> — got the flag "${id}" in its place.`);

  const action = verb === 'resolve' ? flagValue(args, '--action') : undefined;
  if (verb === 'resolve' && (!action || !ACTIONS.includes(action))) {
    fail(`--action must be one of: ${ACTIONS.join(', ')}`);
  }
  const answer = flagValue(args, '--answer');

  const microPath = path.join(stateDir, 'state', 'micro-proposals.json');

  // Deliberately NOT lib/cli.ts's readJson — it flattens "missing" and "corrupt"
  // to null. Corrupt must fail loud so the file is never silently replaced.
  const read = readMicroProposals(microPath);
  if (read.status === 'missing') emit('NONE|no-match'); // nothing queued, nothing to mutate
  if (read.status === 'corrupt') fail(`${read.error} — refusing to write. Repair it first.`);
  const micro: Json = read.data;

  const idx = micro.pending.findIndex((e: Json) => e.id === id);
  if (idx === -1) emit('NONE|no-match');
  const entry = micro.pending[idx];

  if (verb === 'nudge') {
    const next = (typeof entry.follow_up_count === 'number' ? entry.follow_up_count : 0) + 1;
    entry.follow_up_count = next;
    writeFileAtomic(microPath, JSON.stringify(micro, null, 2) + '\n');
    emit(`NUDGED|${id}|${next}`);
  }

  // Capture the question before removal — the ledger event carries it.
  const question = entry.question;
  micro.pending.splice(idx, 1);
  writeFileAtomic(microPath, JSON.stringify(micro, null, 2) + '\n');

  const event: Json = { ts: utcISOStamp(), type: 'micro-resolved', micro_id: id, action, question };
  if (answer !== undefined) event.answer = answer;
  const err = appendJsonlLine(path.join(stateDir, 'state', 'proposal-metrics.jsonl'), JSON.stringify(event));
  // The queue write already landed, so re-running this command would only report
  // NONE|no-match — say so, or the caller retries and loses the event for good.
  if (err) fail(`${err} — ${id} was already removed from pending; the micro-resolved event was NOT recorded. Do not re-run; append it by hand.`);

  emit(`RESOLVED|${id}|${action}`);
}
