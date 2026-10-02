// state/routine-run.json — one run record per routine that declares an
// `expect_artifact` contract. `precheck` writes the record at fire time;
// `finish` reads it to decide the terminal outcome.
//
// Why a sidecar and not extra columns on routine-metrics.jsonl: that ledger's
// row shape is pinned to exactly (ts, routine_id, event, delivery), asserted by
// tests/routine-precheck.test.ts, and every consumer is written against those
// four keys. state/ is the documented bucket for cross-invocation
// coordination (docs/artifact-naming.md), so the run record lives there and
// the ledger keeps its frozen shape.
//
// The baseline is a filesystem identity, not a timestamp comparison:
// utcISOStamp() truncates to whole seconds, so a file written before precheck
// in the same second would compare as "newer" than the `started` stamp. An
// identity captured at start sidesteps clock precision entirely.

import fs from 'node:fs';
import path from 'node:path';
import { todayYMD } from '../time';
import { writeFileAtomic } from '../md-write';

export type Baseline = { size: number; mtimeMs: number; ino: number } | null;

export type RunRecord = {
  started_ts: string;
  resolved_path: string;
  baseline: Baseline;
  /**
   * Set by `finish` once a terminal row has been written: `'fired'`, or the
   * failure reason (`'artifact-missing'`, …). Presence makes finalize idempotent.
   */
  outcome?: string;
};

const RUN_FILE = ['state', 'routine-run.json'];

/** Only these two buckets: raw/ is GC'd domain input, compiled/ is durable domain output. */
const ALLOWED_PREFIXES = ['raw/', 'compiled/'];

/**
 * Validates an `expect_artifact` declaration. Returns an error string, or null when valid.
 *
 * Exact paths only — no globs. docs/artifact-naming.md already mandates
 * `<type>-<slug>-<YYYY-MM-DD>.md` in both buckets, so an exact path is always
 * expressible, and a glob would make both the change check (an unrelated fresh
 * match passes) and the duplicate check (overlapping patterns are not
 * string-equal) unsound.
 */
export function validateExpectArtifact(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'must be a non-empty string';
  const v = value.trim();
  if (path.isAbsolute(v)) return 'must be relative to .hermit/, not absolute';
  if (v.split('/').includes('..')) return 'must not contain ".." path segments';
  if (v.includes('*') || v.includes('?')) return 'must be an exact path — globs are not supported';
  if (!ALLOWED_PREFIXES.some(p => v.startsWith(p))) return 'must start with "raw/" or "compiled/"';
  // Matches any brace group, not just lowercase words: `{DATE}` must be rejected
  // as an unknown token, not silently accepted as a literal filename fragment
  // that resolveArtifactPath will never substitute.
  const tokens = v.match(/\{[^}]*\}/g) ?? [];
  if (tokens.length > 1) return 'may contain at most one {date} token';
  if (tokens.length === 1 && tokens[0] !== '{date}') return `unknown token ${tokens[0]} — only {date} is supported`;
  if (v.endsWith('/')) return 'must name a file, not a directory';
  return null;
}

/**
 * Expands `{date}` to YYYY-MM-DD in `timezone`. Resolved once at fire start and
 * frozen into the run record: a routine that crosses local midnight (the shipped
 * weekly-review runs at 23:00) must be verified against the path it was supposed
 * to write, not the next day's.
 */
export function resolveArtifactPath(pattern: string, timezone: string | null, ref: Date = new Date()): string {
  return pattern.replace('{date}', todayYMD(timezone || 'UTC', ref));
}

/** Filesystem identity of `abs`, or null when it is absent or not a regular file. */
export function statIdentity(abs: string): Baseline {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null; // symlinks and directories never count as the artifact
    return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return null;
  }
}

/** True when the target changed from its baseline (appeared, vanished-and-returned, or was rewritten). */
export function identityChanged(baseline: Baseline, current: Baseline): boolean {
  if (!current) return false; // still absent, or no longer a regular file
  if (!baseline) return true; // absent at start, present now
  return (
    current.ino !== baseline.ino ||
    current.size !== baseline.size ||
    current.mtimeMs !== baseline.mtimeMs
  );
}

function runFilePath(hermitDir: string): string {
  return path.join(hermitDir, ...RUN_FILE);
}

function readAll(hermitDir: string): Record<string, RunRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(runFilePath(hermitDir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Returns null on any write failure — callers decide whether that is fatal. */
function writeAll(hermitDir: string, all: Record<string, RunRecord>): string | null {
  try {
    fs.mkdirSync(path.dirname(runFilePath(hermitDir)), { recursive: true });
    // tmp+rename like every other JSON state writer here (alert-state, due, pause):
    // finish trusts this file to decide a fire's outcome, so a torn read must not
    // be possible.
    writeFileAtomic(runFilePath(hermitDir), JSON.stringify(all, null, 2) + '\n');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Replaces any previous record for `id` — a new fire always starts from a clean baseline. */
export function writeRunRecord(hermitDir: string, id: string, rec: RunRecord): string | null {
  const all = readAll(hermitDir);
  all[id] = rec;
  return writeAll(hermitDir, all);
}

/**
 * Drops `id`'s record. Called by `precheck` when the routine no longer declares a
 * valid contract — a leftover record still carrying the previous fire's `outcome`
 * would make every later `finish` replay it instead of writing a terminal row.
 * No-op when there is nothing to drop, so the common path never rewrites the file.
 */
export function clearRunRecord(hermitDir: string, id: string): void {
  const all = readAll(hermitDir);
  if (!(id in all)) return;
  delete all[id];
  writeAll(hermitDir, all);
}

export function readRunRecord(hermitDir: string, id: string): RunRecord | null {
  const rec = readAll(hermitDir)[id];
  return rec && typeof rec.resolved_path === 'string' ? rec : null;
}

/** Stamps the terminal outcome so a replayed `finish` returns it instead of writing a second row. */
export function markOutcome(hermitDir: string, id: string, outcome: string): void {
  const all = readAll(hermitDir);
  if (!all[id]) return;
  all[id].outcome = outcome;
  writeAll(hermitDir, all);
}
