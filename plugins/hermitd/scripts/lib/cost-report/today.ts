// `cost-report.ts today` — prints today's spend as
// "$X.XX (<tokens>) across N session(s)".
// Log resolved against the anchored hermit root (survives cwd drift), not cwd.
// Unreadable log -> "cost data unavailable" (not a misleading $0.00); a readable
// log with no rows today -> honest $0.00.

import fs from 'node:fs';
import { formatTokens } from '../format';
import { costLogPath, hermitDir } from '../cc-compat';

const UNAVAILABLE = 'cost data unavailable';

function render(costLog: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(costLog, 'utf8');
  } catch {
    return UNAVAILABLE;
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    let cost = 0;
    let tokens = 0;
    const sessions = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.timestamp && e.timestamp.startsWith(today)) {
          cost += e.estimated_cost_usd || 0;
          tokens += e.total_tokens || 0;
          if (e.session_id || e.cc_session_id) sessions.add(e.session_id || e.cc_session_id);
        }
      } catch {}
    }
    return `$${cost.toFixed(2)} (${formatTokens(tokens)}) across ${sessions.size} session(s)`;
  } catch {
    return UNAVAILABLE;
  }
}

// Resolved here rather than at module scope — see the note in session.ts: every
// verb module is imported unconditionally, so a module-scope hermitDir() walk
// would run even for the verbs that never read it.
export function run(): void {
  process.stdout.write(render(costLogPath(hermitDir())) + '\n');
}
