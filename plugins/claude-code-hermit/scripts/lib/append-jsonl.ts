// Shared validated-append primitive for JSONL event ledgers (proposal-metrics.jsonl,
// observations.jsonl, micro-proposals.json's metrics companion, etc). Extracted from
// append-metrics.ts so record-gate.ts and queue-micro-proposal.ts can append
// pre-built events through the same validate-then-append contract instead of
// re-implementing it.

import fs from 'node:fs';

/**
 * Validates `eventJson` is non-empty parseable JSON, then appends it (+ newline)
 * to `filePath`. Returns null on success, or an error message on failure (no write).
 * Error strings match append-metrics.ts's original CLI-facing messages verbatim.
 */
function appendJsonlLine(filePath: string, eventJson: string): string | null {
  if (!eventJson) return 'Error: event payload is empty';
  try {
    JSON.parse(eventJson);
  } catch (err: any) {
    return `Invalid JSON: ${err.message}`;
  }
  fs.appendFileSync(filePath, eventJson + '\n', 'utf-8');
  return null;
}

export { appendJsonlLine };
