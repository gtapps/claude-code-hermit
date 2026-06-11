// Hermit-owned cost-log index: incremental byte-offset tracking + corrupt-line counting.
// cc-compat.js owns the cost-log PATH only; this module owns the record shape and the index.
//
// Index schema (state/cost-index.json):
//   version               — schema version (bump on breaking changes)
//   byte_offset           — position in cost-log.jsonl after last processed line
//   total_cost_usd        — all-time cumulative cost
//   total_tokens          — all-time cumulative tokens
//   total_sessions        — running count of distinct sessions (incremented when session_id changes)
//   last_session_id       — most recent session_id seen (drives total_sessions; bounded, O(1))
//   by_source             — {[source]: {cost, tokens}} buckets
//   by_date               — {[YYYY-MM-DD]: {cost, tokens, session_ids[]}} per-day aggregates,
//                            pruned to the trailing BY_DATE_RETENTION_DAYS window
//   skipped_corrupt_lines — count of JSONL lines that failed JSON.parse (Known Limitation #3)
//   updated_at            — ISO timestamp of last index write
//
// Sole writer: cost-tracker.ts (calls updateCostIndex after every log append).
// Readers: cost-tracker.ts (writeCostSummary, getCumulativeCost fallback), doctor-check.ts.

import fs from 'node:fs';
import path from 'node:path';

type Json = any;

const INDEX_VERSION = 2;

// writeCostSummary reads today + the trailing 7 days; keep one extra day of buffer.
const BY_DATE_RETENTION_DAYS = 8;

function costIndexPath(hermitRoot: string): string {
  return path.join(path.resolve(hermitRoot), 'state', 'cost-index.json');
}

function readCostIndex(indexPath: string): Json | null {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    if (data && data.version === INDEX_VERSION) return data;
    return null;
  } catch {
    return null;
  }
}

function _emptyIndex(): Json {
  return {
    version: INDEX_VERSION,
    byte_offset: 0,
    total_cost_usd: 0,
    total_tokens: 0,
    total_sessions: 0,
    last_session_id: null,
    by_source: {},
    by_date: {},
    skipped_corrupt_lines: 0,
    updated_at: new Date().toISOString(),
  };
}

function _writeIndex(indexPath: string, index: Json): Json {
  const tmp = indexPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, indexPath);
  return index;
}

// Drop by_date buckets older than the retention window. Keeps the index bounded
// regardless of how long the hermit runs; total_* counters are unaffected.
function _pruneByDate(index: Json): void {
  const cutoff = new Date(Date.now() - BY_DATE_RETENTION_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  for (const date of Object.keys(index.by_date)) {
    if (date < cutoff) delete index.by_date[date];
  }
}

// Process one log line into the index in-place.
function _processLine(index: Json, line: string): void {
  try {
    const entry = JSON.parse(line);
    const cost = entry.estimated_cost_usd || 0;
    const tokens = entry.total_tokens || 0;
    const sid = entry.session_id || null;
    const source = entry.source || 'other';
    const date = (entry.timestamp || '').slice(0, 10);

    index.total_cost_usd += cost;
    index.total_tokens += tokens;

    // Count a new session each time the session_id changes. Cost-log lines for one
    // session are contiguous (one always-on hermit runs a single session at a time),
    // so tracking only the last id keeps the counter bounded and O(1).
    if (sid && sid !== index.last_session_id) {
      index.total_sessions += 1;
      index.last_session_id = sid;
    }

    if (!index.by_source[source]) index.by_source[source] = { cost: 0, tokens: 0 };
    index.by_source[source].cost += cost;
    index.by_source[source].tokens += tokens;

    if (date) {
      if (!index.by_date[date]) index.by_date[date] = { cost: 0, tokens: 0, session_ids: [] };
      index.by_date[date].cost += cost;
      index.by_date[date].tokens += tokens;
      if (sid && !index.by_date[date].session_ids.includes(sid)) {
        index.by_date[date].session_ids.push(sid);
      }
    }
  } catch {
    index.skipped_corrupt_lines++;
  }
}

// Full O(n) rebuild from scratch. Only called: first run, version mismatch, or log truncation.
function rebuildCostIndex(logPath: string, indexPath: string): Json {
  const index = _emptyIndex();

  let fileSize = 0;
  try {
    fileSize = fs.statSync(logPath).size;
  } catch {
    return _writeIndex(indexPath, index);
  }

  try {
    const content = fs.readFileSync(logPath, 'utf-8').trim();
    if (content) {
      for (const line of content.split('\n')) {
        if (line.trim()) _processLine(index, line);
      }
    }
  } catch {
    // Non-fatal — partial read still gives partial totals
  }

  index.byte_offset = fileSize;
  _pruneByDate(index);
  index.updated_at = new Date().toISOString();
  return _writeIndex(indexPath, index);
}

// Incremental update: read only bytes appended since last call. O(1) in the common case.
// Falls back to rebuildCostIndex when the index is missing, version-mismatched, or the log
// appears truncated (byte_offset > fileSize).
function updateCostIndex(logPath: string, indexPath: string): Json {
  let fileSize = 0;
  try {
    fileSize = fs.statSync(logPath).size;
  } catch {
    // Log absent — ensure an empty index exists and return it
    const existing = readCostIndex(indexPath);
    if (existing) return existing;
    return _writeIndex(indexPath, _emptyIndex());
  }

  const index = readCostIndex(indexPath);

  // Rebuild triggers
  if (!index || index.byte_offset > fileSize) {
    return rebuildCostIndex(logPath, indexPath);
  }

  // No new bytes
  if (index.byte_offset === fileSize) return index;

  // Read only the new bytes
  const newByteCount = fileSize - index.byte_offset;
  let text = '';
  try {
    const buf = Buffer.alloc(newByteCount);
    const fd = fs.openSync(logPath, 'r');
    try {
      fs.readSync(fd, buf, 0, newByteCount, index.byte_offset);
    } finally {
      fs.closeSync(fd);
    }
    text = buf.toString('utf-8');
  } catch {
    // Non-fatal — skip this increment, try again next call
    return index;
  }

  for (const line of text.split('\n')) {
    if (line.trim()) _processLine(index, line);
  }

  index.byte_offset = fileSize;
  _pruneByDate(index);
  index.updated_at = new Date().toISOString();
  return _writeIndex(indexPath, index);
}

// Warn-only: surfaces tier-drift cost without a hard block.
function scanAutomatedOpus(costLogFile: string, sinceDateInclusive: string): { count: number; cost: number } {
  let count = 0;
  let cost = 0;
  if (!fs.existsSync(costLogFile)) return { count, cost };
  for (const line of fs.readFileSync(costLogFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const date = (e.timestamp || '').slice(0, 10);
      const src = e.source || 'other';
      const automated = src === 'heartbeat' || src.startsWith('routine:');
      if (date >= sinceDateInclusive && e.model === 'opus' && automated) {
        count += 1;
        cost += e.estimated_cost_usd || 0;
      }
    } catch { /* skip corrupt lines — checkCost already surfaces corruption */ }
  }
  return { count, cost };
}

export { costIndexPath, readCostIndex, updateCostIndex, rebuildCostIndex, scanAutomatedOpus };
