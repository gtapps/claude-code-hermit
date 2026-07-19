#!/usr/bin/env bun
// Zero-token heartbeat/routine precheck for the error watch loop.
//
// Prints exactly one verdict line and exits 0. The routine's error-triage skill
// runs this as step 1 and stops on SKIP — so a quiet tracker costs no LLM tokens.
//
//   SKIP|no new error groups          nothing since the cursor — stop
//   EVALUATE|<n> new groups           n groups appeared — run triage
//   EVALUATE|no cursor — bootstrap    first run, no cursor yet — run triage
//   ERROR|<scrubbed reason>           config/network/HTTP failure — triage DMs
//                                     the operator after 3 consecutive ERRORs
//
// CURSOR RULE: this script only READS state/error-cursor.json. The error-triage
// skill is the sole writer — a broken precheck must never advance the cursor and
// silently skip real errors forever.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiRequest,
  buildIssuesUrl,
  isoMinus,
  projectRoot,
  resolveConfig,
} from './error-api-lib';

// Widen the firstSeen:>= window by this much so a group that lands with a
// slightly-backdated firstSeen is still fetched. The seen_ids dedup below keeps
// the overlap from re-triggering EVALUATE, so the only cost is a marginally
// larger response. Groups backdated beyond this window are still missed — the
// lookback bounds, it does not eliminate, that risk.
const LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6h

function emit(line: string): never {
  process.stdout.write(`${line}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  const root = projectRoot();
  const { config, missing } = resolveConfig(root);
  if (!config) emit(`ERROR|config incomplete: ${missing.join(', ')}`);

  let cursor: string | undefined;
  let seenIds = new Set<string>();
  try {
    const raw = readFileSync(join(root, '.claude-code-hermit', 'state', 'error-cursor.json'), 'utf8');
    const parsed = JSON.parse(raw) as { last_seen_first_seen?: string; seen_ids?: string[] };
    cursor = parsed.last_seen_first_seen;
    if (Array.isArray(parsed.seen_ids)) seenIds = new Set(parsed.seen_ids.map(String));
  } catch {
    cursor = undefined;
  }

  if (!cursor) emit('EVALUATE|no cursor — bootstrap');

  // Raise the page size for this widened query. The lookback re-includes
  // already-seen groups, and with no `sort` param the server's ordering isn't
  // guaranteed to favor new groups — at limit=25 a burst of reappearing overlap
  // groups could crowd a real new group off the single page this gate fetches,
  // silently skipping an EVALUATE. `limit` is backend-agnostic (GlitchTip's
  // `sort` support is buggy, so it's avoided); this bounds the risk, cheaply.
  const url = buildIssuesUrl(config, { since: isoMinus(cursor, LOOKBACK_MS), limit: '100' });
  const res = await apiRequest<Array<{ id?: unknown }>>(url, config.token);
  if (!res.ok) emit(`ERROR|HTTP ${res.status}${res.error ? ' — ' + res.error : ''}`);

  // Dedup against ids the triage skill already processed. The firstSeen:>= bound
  // is inclusive and widened by the lookback, so groups seen last run reappear —
  // count only the genuinely-new ids, else the loop can never reach SKIP.
  const groups = Array.isArray(res.data) ? res.data : [];
  const fresh = groups.filter((g) => !seenIds.has(String(g?.id)));
  if (fresh.length === 0) emit('SKIP|no new error groups');
  emit(`EVALUATE|${fresh.length} new groups`);
}

if (import.meta.main) {
  main();
}
