// Append-only record of auto-mode classifier denials, written by the
// `PermissionDenied` hook (permission-denied-notify.ts) and digested by
// doctor-check.ts's classifier-denials check.
//
// Why an event log rather than the aggregate digest it replaces: Claude Code does
// not serialise hook invocations — parallel tool calls in one assistant turn spawn
// overlapping hook processes (probed 2026-08-28: four denials, four pids, all four
// STARTs before the first END). A read-modify-write digest therefore loses counts
// exactly during the bursts it exists to measure. One line per denial removes the
// class of bug instead of narrowing it, and real timestamps let doctor compute
// clustering rather than trusting a counter incremented across racing processes.
//
// Tool input never reaches this file. Only the tool name (via toolKey) and, for
// Bash, the first word of the command (via bashProgram) are recorded.

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlLine, pruneJsonlIfHeadStale } from './append-jsonl';
import { utcISOStamp } from './time';

export interface DenialRow {
  ts: string;
  tool: string;
  prog?: string;
}

// Strictly greater than doctor's 7-day report window, so a trim can never truncate
// a line the check would have counted and the two boundaries are never adjacent.
export const DENIAL_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export function denialLogPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'permission-denied-events.jsonl');
}

/**
 * Record one denial. Never throws — the hook's contract is to stay out of the way,
 * and a lost diagnostic line must not turn into a failed tool call.
 */
export function appendDenial(stateDir: string, tool: string, prog: string | null): void {
  try {
    const file = denialLogPath(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    pruneJsonlIfHeadStale(file, DENIAL_LOG_RETENTION_MS, new Date());
    const row: DenialRow = { ts: utcISOStamp(), tool, ...(prog ? { prog } : {}) };
    appendJsonlLine(file, JSON.stringify(row));
  } catch {
    // Fail open, like the notifier around it.
  }
}

/**
 * Rows at or newer than `sinceMs`, plus how many lines could not be read as a
 * denial. A JSONL ledger has no whole-file corrupt state, so a torn or malformed
 * line is skipped rather than failing the read; only an unreadable file is an
 * error the caller should surface.
 *
 * `malformed` exists because skipping silently is an undercount with no signal —
 * a torn write (ENOSPC, or an interleaved append on a filesystem that does not
 * serialize concurrent `O_APPEND` writes) would otherwise just make denials
 * vanish from a check whose whole job is to not under-report. An in-range row
 * that is simply older than the window is not malformed and is not counted.
 */
export function readDenials(
  stateDir: string,
  sinceMs: number,
): { rows: DenialRow[]; malformed: number } | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(denialLogPath(stateDir), 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { rows: [], malformed: 0 };
    return { error: err?.code ?? 'unreadable' };
  }
  const rows: DenialRow[] = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!parsed || typeof parsed.ts !== 'string' || typeof parsed.tool !== 'string') {
      malformed++;
      continue;
    }
    const ts = Date.parse(parsed.ts);
    if (Number.isNaN(ts)) {
      malformed++;
      continue;
    }
    if (ts < sinceMs) continue; // aged out, not damaged
    rows.push({
      ts: parsed.ts,
      tool: parsed.tool,
      ...(typeof parsed.prog === 'string' && parsed.prog ? { prog: parsed.prog } : {}),
    });
  }
  return { rows, malformed };
}
