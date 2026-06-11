// Sums cost-log.jsonl entries for a given session_id and prints the result.
// Usage: bun session-cost.ts <session_id>
// Output: JSON {"cost_usd": <number>, "tokens": <number>}
// Fails open: missing log or unknown session_id prints {"cost_usd": 0, "tokens": 0}.

import fs from 'node:fs';
import { costLogPath } from './lib/cc-compat';

const COST_LOG = costLogPath('.claude-code-hermit');

const sessionId = process.argv[2] || '';

let cost = 0;
let tokens = 0;

try {
  for (const line of fs.readFileSync(COST_LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.session_id === sessionId) {
        cost += e.estimated_cost_usd || 0;
        tokens += e.total_tokens || 0;
      }
    } catch {}
  }
} catch {}

process.stdout.write(JSON.stringify({ cost_usd: Math.round(cost * 10000) / 10000, tokens }) + '\n');
