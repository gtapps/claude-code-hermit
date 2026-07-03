// Fails open: missing log or parse errors print $0.00 and exit 0.

import fs from 'node:fs';
import path from 'node:path';
import { formatTokens } from './lib/format';

const COST_LOG = path.resolve('.claude/cost-log.jsonl');

try {
  const today = new Date().toISOString().slice(0, 10);
  let cost = 0;
  let tokens = 0;
  const sessions = new Set<string>();

  try {
    for (const line of fs.readFileSync(COST_LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.timestamp && e.timestamp.startsWith(today)) {
          cost += e.estimated_cost_usd || 0;
          tokens += e.total_tokens || 0;
          if (e.session_id) sessions.add(e.session_id);
        }
      } catch {}
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  process.stdout.write(
    `$${cost.toFixed(2)} (${formatTokens(tokens)}) across ${sessions.size} session(s)\n`
  );
} catch {
  process.stdout.write('$0.00 (0 tokens) across 0 session(s)\n');
}
