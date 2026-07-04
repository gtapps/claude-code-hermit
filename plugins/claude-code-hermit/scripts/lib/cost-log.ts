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
//   by_week                — {[YYYY-Www]: {cost, tokens}} per-ISO-week aggregates (PROP-016
//                            budget enforcement), pruned to BY_WEEK_RETENTION_WEEKS
//   by_month               — {[YYYY-MM]: {cost, tokens}} per-month aggregates (PROP-016 budget
//                            enforcement), pruned to BY_MONTH_RETENTION_MONTHS
//   skipped_corrupt_lines — count of JSONL lines that failed JSON.parse (Known Limitation #3)
//   updated_at            — ISO timestamp of last index write
//
// by_date/by_week/by_month keys are all derived in the caller-supplied `timezone` (default
// 'UTC') so a budget cap's "daily"/"weekly"/"monthly" window matches the operator's local
// calendar, not the log's UTC timestamps. version 3 (PROP-016) added by_week/by_month and
// tz-aware bucketing — bumped so a v2 index (UTC-only by_date) rebuilds cleanly rather than
// mixing UTC and tz-local keys.
//
// Sole writer: cost-tracker.ts (calls updateCostIndex after every log append).
// Readers: cost-tracker.ts (writeCostSummary, getCumulativeCost fallback), doctor-check.ts.

import fs from 'node:fs';
import path from 'node:path';
import { todayYMD, thisWeekKey, thisMonthYYYYMM } from './time';

type Json = any;

const INDEX_VERSION = 3;

// writeCostSummary reads today + the trailing 7 days; keep one extra day of buffer.
const BY_DATE_RETENTION_DAYS = 8;
const BY_WEEK_RETENTION_WEEKS = 14;
const BY_MONTH_RETENTION_MONTHS = 13;

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
    by_week: {},
    by_month: {},
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

// Months-ago reference date, via UTC calendar-month subtraction (not ms subtraction —
// months have variable length, so `Date.UTC` normalization is the correct way to land
// on "the same day N months back" for a monthly retention cutoff).
function _monthsAgo(n: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, now.getUTCDate()));
}

// Drop by_date/by_week/by_month buckets older than their retention windows. Keeps the
// index bounded regardless of how long the hermit runs; total_* counters are unaffected.
function _pruneBuckets(index: Json, timezone: string): void {
  const dateCutoff = todayYMD(timezone, new Date(Date.now() - BY_DATE_RETENTION_DAYS * 86400000));
  for (const date of Object.keys(index.by_date)) {
    if (date < dateCutoff) delete index.by_date[date];
  }
  const weekCutoff = thisWeekKey(timezone, new Date(Date.now() - BY_WEEK_RETENTION_WEEKS * 7 * 86400000));
  for (const week of Object.keys(index.by_week)) {
    if (week < weekCutoff) delete index.by_week[week];
  }
  const monthCutoff = thisMonthYYYYMM(timezone, _monthsAgo(BY_MONTH_RETENTION_MONTHS));
  for (const month of Object.keys(index.by_month)) {
    if (month < monthCutoff) delete index.by_month[month];
  }
}

// Process one log line into the index in-place. `timezone` determines which calendar
// day/week/month the line's timestamp buckets into.
function _processLine(index: Json, line: string, timezone: string): void {
  try {
    const entry = JSON.parse(line);
    const cost = entry.estimated_cost_usd || 0;
    const tokens = entry.total_tokens || 0;
    const sid = entry.session_id || null;
    const source = entry.source || 'other';
    const ts = entry.timestamp ? new Date(entry.timestamp) : null;
    const validTs = ts && !isNaN(ts.getTime()) ? ts : null;
    const date = validTs ? todayYMD(timezone, validTs) : '';
    const week = validTs ? thisWeekKey(timezone, validTs) : '';
    const month = validTs ? thisMonthYYYYMM(timezone, validTs) : '';

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
    if (week) {
      if (!index.by_week[week]) index.by_week[week] = { cost: 0, tokens: 0 };
      index.by_week[week].cost += cost;
      index.by_week[week].tokens += tokens;
    }
    if (month) {
      if (!index.by_month[month]) index.by_month[month] = { cost: 0, tokens: 0 };
      index.by_month[month].cost += cost;
      index.by_month[month].tokens += tokens;
    }
  } catch {
    index.skipped_corrupt_lines++;
  }
}

// Full O(n) rebuild from scratch. Only called: first run, version mismatch, or log truncation.
function rebuildCostIndex(logPath: string, indexPath: string, timezone: string = 'UTC'): Json {
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
        if (line.trim()) _processLine(index, line, timezone);
      }
    }
  } catch {
    // Non-fatal — partial read still gives partial totals
  }

  index.byte_offset = fileSize;
  _pruneBuckets(index, timezone);
  index.updated_at = new Date().toISOString();
  return _writeIndex(indexPath, index);
}

// Incremental update: read only bytes appended since last call. O(1) in the common case.
// Falls back to rebuildCostIndex when the index is missing, version-mismatched, or the log
// appears truncated (byte_offset > fileSize). `timezone` (default 'UTC') determines the
// by_date/by_week/by_month bucketing — pass config.timezone so budget windows match the
// operator's local calendar.
function updateCostIndex(logPath: string, indexPath: string, timezone: string = 'UTC'): Json {
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
    return rebuildCostIndex(logPath, indexPath, timezone);
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
    if (line.trim()) _processLine(index, line, timezone);
  }

  index.byte_offset = fileSize;
  _pruneBuckets(index, timezone);
  index.updated_at = new Date().toISOString();
  return _writeIndex(indexPath, index);
}

// Warn-only: surfaces tier-drift cost without a hard block. `timezone` (default 'UTC')
// must match whatever produced `sinceDateInclusive` (writeCostSummary's tz-aware "N days
// ago"), or the cutoff comparison silently drifts against UTC-bucketed dates.
function scanAutomatedOpus(costLogFile: string, sinceDateInclusive: string, timezone: string = 'UTC'): { count: number; cost: number } {
  let count = 0;
  let cost = 0;
  if (!fs.existsSync(costLogFile)) return { count, cost };
  for (const line of fs.readFileSync(costLogFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const ts = e.timestamp ? new Date(e.timestamp) : null;
      const date = ts && !isNaN(ts.getTime()) ? todayYMD(timezone, ts) : '';
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

// Counts JSONL lines flagged model_unpriced:true (cost-tracker.ts marks a turn this way
// when the raw model string didn't match any known haiku/sonnet/opus substring — still
// priced at sonnet rates, but flagged so the drift is auditable). Mirrors scanAutomatedOpus's
// date-filtered scan shape.
function scanUnpricedModels(costLogFile: string, sinceDateInclusive: string, timezone: string = 'UTC'): { count: number; cost: number } {
  let count = 0;
  let cost = 0;
  if (!fs.existsSync(costLogFile)) return { count, cost };
  for (const line of fs.readFileSync(costLogFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e.model_unpriced) continue;
      const ts = e.timestamp ? new Date(e.timestamp) : null;
      const date = ts && !isNaN(ts.getTime()) ? todayYMD(timezone, ts) : '';
      if (date >= sinceDateInclusive) {
        count += 1;
        cost += e.estimated_cost_usd || 0;
      }
    } catch { /* skip corrupt lines */ }
  }
  return { count, cost };
}

export { costIndexPath, readCostIndex, updateCostIndex, rebuildCostIndex, scanAutomatedOpus, scanUnpricedModels };
