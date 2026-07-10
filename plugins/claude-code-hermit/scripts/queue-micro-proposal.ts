// queue-micro-proposal.ts — generates an MP-id, dedups, appends a pending entry to
// state/micro-proposals.json, and logs the micro-queued metric event.
// Usage: bun queue-micro-proposal.ts <hermit-state-dir> <<'HERMIT_MP'
//        {"tier":1,"question":"<full question text>","options":["..."],"on_resolve":"..."}
//        HERMIT_MP
//   — stdin only (question is free text and may contain apostrophes/quotes; no argv mode).
// Output (stdout, one line):
//   QUEUED|<MP-id>
//   DUPLICATE|<existing-id>
// Exit 1 (+ stderr) on malformed input, a missing "question", or a ledger-append
// failure — a silent queue-drop would strand the candidate.
// Implements reflect/branches.md § Micro-approval queuing steps 1-3. `options`/
// `on_resolve` are optional per the channel-bridged-ask extension (branches.md:
// 205-207); when `on_resolve` is present, tier is forced to 1 and the metrics
// event carries "kind":"ask" (branches.md:207,214) regardless of the caller's tier.
// Dedup is by exact `question` match against existing `pending` entries.

import fs from 'node:fs';
import path from 'node:path';
import { todayYMD, utcISOStamp } from './lib/time';
import { appendJsonlLine } from './lib/append-jsonl';
import { readStdin, readJson } from './lib/cli';

type Json = any;

(async () => {
  const stateDir = process.argv[2];
  if (!stateDir) {
    console.error("Usage: bun queue-micro-proposal.ts <hermit-state-dir> <<'HERMIT_MP' ... HERMIT_MP");
    process.exit(1);
  }

  const raw = (await readStdin()).trim();
  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch (err: any) {
    console.error(`Invalid JSON: ${err.message}`);
    process.exit(1);
  }

  const question: string = payload.question;
  if (!question) {
    console.error('Error: "question" is required');
    process.exit(1);
  }
  const onResolve: string | undefined = payload.on_resolve;
  const isBridged = onResolve !== undefined;
  const tier = isBridged ? 1 : (payload.tier ?? 1);
  const options: string[] | undefined = payload.options;

  const stateSubdir = path.join(stateDir, 'state');
  const microPath = path.join(stateSubdir, 'micro-proposals.json');
  let micro = readJson(microPath);
  if (!micro || !Array.isArray(micro.pending)) micro = { pending: [] };

  const existing = micro.pending.find((e: Json) => e.question === question);
  if (existing) {
    process.stdout.write(`DUPLICATE|${existing.id}\n`);
    process.exit(0);
  }

  const config = readJson(path.join(stateDir, 'config.json')) ?? {};
  const timezone = config.timezone || 'UTC';
  const today = todayYMD(timezone).replace(/-/g, '');

  const ledger = path.join(stateSubdir, 'proposal-metrics.jsonl');
  const prefix = `MP-${today}-`;
  let maxN = -1;
  try {
    const lines = fs.readFileSync(ledger, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'micro-queued' && typeof ev.micro_id === 'string' && ev.micro_id.startsWith(prefix)) {
          const n = parseInt(ev.micro_id.slice(prefix.length), 10);
          if (!isNaN(n)) maxN = Math.max(maxN, n);
        }
      } catch { /* skip unparseable line */ }
    }
  } catch { /* no ledger yet -> N starts at 0 */ }

  const id = `${prefix}${maxN + 1}`;

  const entry: Json = { id, tier, status: 'pending', follow_up_count: 0, ts: utcISOStamp(), question };
  if (options) entry.options = options;
  if (onResolve) entry.on_resolve = onResolve;
  micro.pending.push(entry);

  fs.mkdirSync(stateSubdir, { recursive: true });
  const tmp = microPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(micro, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, microPath);

  const event: Json = { ts: utcISOStamp(), type: 'micro-queued', micro_id: id, tier, question };
  if (isBridged) event.kind = 'ask';
  const err = appendJsonlLine(ledger, JSON.stringify(event));
  if (err) {
    console.error(err);
    process.exit(1);
  }

  process.stdout.write(`QUEUED|${id}\n`);
})();
