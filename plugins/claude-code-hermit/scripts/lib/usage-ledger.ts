import fs from 'node:fs';
import path from 'node:path';

type Json = any;

// Shared writer for state/usage-metrics.jsonl — both capture points
// (usage-track.ts's Skill/Read PostToolUse hook, and record-operator-action.ts's
// operator-typed slash-command path) need identical seed+append behavior. Single
// owner of the record shape and the ledger-start seeding rule, mirroring how
// lib/cost-log.ts owns the cost-log record shape.
//
// No parent-dir existence pre-check: an unhatched project (no state/ dir) makes
// appendFileSync throw ENOENT, which every caller already catches and treats as
// fail-open — a pre-check would just be a redundant stat syscall on a path this
// hook runs on every single Skill/Read tool call.
function appendUsageEvent(hermitDir: string, event: Json): void {
  const ledgerPath = path.join(hermitDir, 'state', 'usage-metrics.jsonl');
  if (!fs.existsSync(ledgerPath)) {
    fs.appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), kind: 'meta', event: 'ledger-start' }) + '\n');
  }
  fs.appendFileSync(ledgerPath, JSON.stringify(event) + '\n');
}

export { appendUsageEvent };
