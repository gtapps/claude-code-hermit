import fs from 'node:fs';
import path from 'node:path';
import { ensureLedgerFile } from './append-jsonl';

type Json = any;

// Writer for state/usage-metrics.jsonl — usage-track.ts's Read PostToolUse
// hook is the only capture point. Single owner of the record shape and the
// ledger-start seeding rule, mirroring how lib/cost-log.ts owns the cost-log
// record shape.
//
// No parent-dir existence pre-check: an unhatched project (no state/ dir) makes
// appendFileSync throw ENOENT, which every caller already catches and treats as
// fail-open — a pre-check would just be a redundant stat syscall on a path this
// hook runs on every single Read tool call.
function appendUsageEvent(hermitDir: string, event: Json): void {
  const ledgerPath = path.join(hermitDir, 'state', 'usage-metrics.jsonl');
  if (!fs.existsSync(ledgerPath)) {
    // Create at 0600 inside the existence branch this hot path already pays for,
    // so the new file is not left at the process umask for doctor to flag.
    ensureLedgerFile(ledgerPath);
    fs.appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), kind: 'meta', event: 'ledger-start' }) + '\n');
  }
  fs.appendFileSync(ledgerPath, JSON.stringify(event) + '\n');
}

export { appendUsageEvent };
