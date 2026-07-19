// Shared window-cost algorithm used by scripts/session-cost.ts (CLI) and
// scripts/session-archive.ts (report frontmatter). Pure: caller supplies the
// [openedAt, closedAt] arc bounds (from state/runtime.json — see session-cost.ts's
// header for the arc-window rationale) and the cost-log path; no env/argv reads here.
//
// `available` is the contract callers branch on, not `cost_usd === 0` — a session
// with a real opened_at but zero matching cost-log rows is a MEASURED zero and must
// not fall through to a legacy Cost: payload or any other fallback. `available` is
// false only when openedAt itself is missing/unparseable.

import fs from 'node:fs';

function sumWindow(logPath: string, openedMs: number, closedMs: number): { cost: number; tokens: number } {
  let cost = 0;
  let tokens = 0;
  try {
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const ts = Date.parse(e.timestamp);
        if (Number.isFinite(ts) && ts >= openedMs && ts <= closedMs) {
          cost += e.estimated_cost_usd || 0;
          tokens += e.total_tokens || 0;
        }
      } catch {}
    }
  } catch {}
  return { cost, tokens };
}

export function computeSessionCost(opts: {
  logPath: string;
  openedAt?: string;
  closedAt?: string;
}): { available: boolean; cost_usd: number; tokens: number } {
  const openedMs = opts.openedAt ? Date.parse(opts.openedAt) : NaN;
  if (!Number.isFinite(openedMs)) return { available: false, cost_usd: 0, tokens: 0 };
  // A malformed/absent closed bound parses to NaN, which would silently zero the
  // window sum (every `ts <= NaN` is false); fall back to now. A live arc (no
  // closed_at yet) also falls back to now.
  const closedParsed = opts.closedAt ? Date.parse(opts.closedAt) : NaN;
  const closedMs = Number.isFinite(closedParsed) ? closedParsed : Date.now();
  const { cost, tokens } = sumWindow(opts.logPath, openedMs, closedMs);
  return { available: true, cost_usd: Math.round(cost * 10000) / 10000, tokens };
}
