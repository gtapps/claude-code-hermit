// Sums cost-log.jsonl entries for the current logical session and prints the result.
// Usage: bun session-cost.ts <session_id> [--opened-at <iso>] [--closed-at <iso>]
// Output: JSON {"cost_usd": <number>, "tokens": <number>}
//
// Primary mode: window-delta. cost-log.jsonl rows are tagged with the transcript's
// process session_id (a UUID), never the logical S-NNN id (assigned only at close),
// and one long-lived transcript holds many logical sessions — so an exact session_id
// match against S-NNN always misses. Instead, sum every row whose timestamp falls in
// the arc window [opened_at, closed_at]. Both bounds are read from state/runtime.json
// (maintained by cost-tracker.ts: opened_at re-stamped per arc keyed on the transcript
// id, closed_at stamped on the idle transition) unless overridden via --opened-at /
// --closed-at. A live arc has no closed_at yet, so the window ends at now.
//
// Fallback mode: when no opened_at is available (older runtime.json, or none yet),
// fail open to the legacy exact session_id sum — same zeros-for-unknown-id behavior
// as before.
// Fails open throughout: missing log or unreadable state prints {"cost_usd": 0, "tokens": 0}.

import fs from 'node:fs';
import { costLogPath } from './lib/cc-compat';
import { readRuntimeJson } from './lib/runtime';

const COST_LOG = costLogPath('.claude-code-hermit');

const argv = process.argv.slice(2);
let sessionId = '';
let openedAtOverride: string | undefined;
let closedAtOverride: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--opened-at') { openedAtOverride = argv[++i]; continue; }
  if (a === '--closed-at') { closedAtOverride = argv[++i]; continue; }
  if (!sessionId) sessionId = a;
}

// Arc-window rationale is in the file header above; this just applies the
// --opened-at / --closed-at overrides on top of runtime.json's values.
function readWindow(): { openedAt?: string; closedAt?: string } {
  const rt = readRuntimeJson() || {};
  return {
    openedAt: openedAtOverride ?? (typeof rt.opened_at === 'string' ? rt.opened_at : undefined),
    closedAt: closedAtOverride ?? (typeof rt.closed_at === 'string' ? rt.closed_at : undefined),
  };
}

function sumMatching(predicate: (e: any) => boolean): { cost: number; tokens: number } {
  let cost = 0;
  let tokens = 0;
  try {
    for (const line of fs.readFileSync(COST_LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (predicate(e)) {
          cost += e.estimated_cost_usd || 0;
          tokens += e.total_tokens || 0;
        }
      } catch {}
    }
  } catch {}
  return { cost, tokens };
}

const { openedAt, closedAt } = readWindow();
const openedMs = openedAt ? Date.parse(openedAt) : NaN;
// A malformed/absent closed bound parses to NaN, which would silently zero the
// window sum (every `ts <= NaN` is false); fall back to now, mirroring the
// openedMs guard below. A live arc (no closed_at yet) also falls back to now.
const closedParsed = closedAt ? Date.parse(closedAt) : NaN;
const closedMs = Number.isFinite(closedParsed) ? closedParsed : Date.now();

const result = Number.isFinite(openedMs)
  ? sumMatching(e => {
      const ts = Date.parse(e.timestamp);
      return Number.isFinite(ts) && ts >= openedMs && ts <= closedMs;
    })
  : sumMatching(e => e.session_id === sessionId);

process.stdout.write(JSON.stringify({ cost_usd: Math.round(result.cost * 10000) / 10000, tokens: result.tokens }) + '\n');
