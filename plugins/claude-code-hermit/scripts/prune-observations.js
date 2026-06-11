// Prunes the sub-threshold observations ledger (state/observations.jsonl).
// Zero npm dependencies, Node stdlib only.
// Usage: node prune-observations.js <hermit-state-dir>
//
// Keep rule: an entry survives iff its ts is within the retention window, OR
// any entry sharing its pattern is within the window (recurrence keeps a
// pattern's full history alive so graduation can cite every sighting).
// Unparseable lines are kept verbatim — never destroy data we can't read.

'use strict';

const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 30;

const stateDir = process.argv[2];

if (!stateDir) {
  console.error('Usage: node prune-observations.js <hermit-state-dir>');
  process.exit(1);
}

const ledgerPath = path.join(stateDir, 'state', 'observations.jsonl');

let content;
try {
  content = fs.readFileSync(ledgerPath, 'utf-8');
} catch {
  console.log('pruned 0, kept 0');
  process.exit(0);
}

const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
const lines = content.split('\n').filter(l => l.trim());

const freshPatterns = new Set();
const parsed = lines.map(line => {
  try {
    const e = JSON.parse(line);
    const fresh = typeof e.ts === 'string' && e.ts >= cutoff;
    if (fresh && e.pattern) freshPatterns.add(e.pattern);
    return { line, pattern: e.pattern, fresh };
  } catch {
    return { line, keep: true };
  }
});

const kept = parsed.filter(p => p.keep || p.fresh || freshPatterns.has(p.pattern));

if (kept.length < lines.length) {
  const tmp = ledgerPath + '.tmp';
  fs.writeFileSync(tmp, kept.map(p => p.line).join('\n') + (kept.length ? '\n' : ''), 'utf-8');
  fs.renameSync(tmp, ledgerPath);
}

console.log(`pruned ${lines.length - kept.length}, kept ${kept.length}`);
