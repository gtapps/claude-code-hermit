// reflect-precheck.ts — determines which reflect phases are due before invoking LLM.
// Usage: bun reflect-precheck.ts <hermit-state-dir> <plugin-root> [--quick [--force]]
// Output (stdout, one line): EMPTY  |  RUN|<phases-json>  |  RUN|<sha256-hash> (--quick)
//
// On EMPTY: this script owns the audit trail — it calls update-reflection-state.ts
// and appends the mandatory Progress Log line to SHELL.md before exiting.
//
// --quick gates the event-driven `reflect --quick` chain (reflect_after routines) against
// a content hash of SHELL.md's ## Findings + ## Blockers, isolated from the scheduled
// cadence state above (never touches last_run_at/counters). --force (only meaningful with
// --quick) skips the EMPTY decision entirely and always returns RUN|<hash> — used by manual
// `/reflect --quick` invocations, which need a deterministic hash to commit after processing,
// not a gating decision (the skill is already loaded by the time this runs).
//
// Exit 0 always.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentHHMM } from './lib/time';
import { readFrontmatter, isEmptyAutoArchive } from './lib/frontmatter';
import { findStorageDrift, findSchemaDrift } from './lib/drift';
import { sha256 } from './lib/hash';
import { appendToProgressLog } from './lib/progress-log';

type Json = any;

function emit(verdict: string): never {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

const stateDir = process.argv[2];
const pluginRoot = process.argv[3];
const flags = process.argv.slice(4);
const quickMode = flags.includes('--quick');
const forceMode = flags.includes('--force');

if (!stateDir) emit('RUN|{}');

const readJSON = (p: string): Json => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
};

// Extract a top-level ## Section from SHELL.md, dropping placeholder-comment and
// blank lines so a real finding appended under a retained `<!-- ... -->` placeholder
// still counts (per-line filter, same idiom as startup-context.ts's task scan — a
// whole-body startsWith('<!--') check would mask content sitting below the comment).
// Same boundary convention as startup-context.ts's extractSection and cost-tracker.ts's
// ## Blockers regex: a section ends at the next `\n## ` or EOF.
function extractQuickSection(md: string, name: string): string {
  const idx = md.indexOf(`## ${name}`);
  if (idx === -1) return '';
  const bodyStart = md.indexOf('\n', idx) + 1;
  const nextSection = md.indexOf('\n## ', bodyStart);
  const raw = nextSection !== -1 ? md.slice(bodyStart, nextSection) : md.slice(bodyStart);
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('<!--'))
    .join('\n');
}

function logQuickEmpty(stateDir: string): void {
  const timezone = (readJSON(path.join(stateDir, 'config.json')) ?? {}).timezone ?? 'UTC';
  const hhmm = currentHHMM(timezone);
  appendToProgressLog(
    path.join(stateDir, 'sessions', 'SHELL.md'),
    `- [${hhmm}] reflect (quick, post-routine) — no new candidates`,
  );
}

function runQuickPrecheck(stateDir: string, force: boolean): never {
  const shellPath = path.join(stateDir, 'sessions', 'SHELL.md');
  let shellContent = '';
  try { shellContent = fs.readFileSync(shellPath, 'utf-8'); } catch { /* missing SHELL.md → nothing to scan */ }

  const findings = extractQuickSection(shellContent, 'Findings');
  const blockers = extractQuickSection(shellContent, 'Blockers');
  const hash = sha256(`${findings}\n---\n${blockers}`);

  if (force) emit('RUN|' + hash);

  if (!findings && !blockers) {
    logQuickEmpty(stateDir);
    emit('EMPTY');
  }

  const reflectionState = readJSON(path.join(stateDir, 'state', 'reflection-state.json')) ?? {};
  const storedHash = reflectionState.last_quick_hash;

  // No prior cursor (storedHash undefined) never equals a hex hash, so first-run
  // correctly falls through to RUN below without a separate branch.
  if (storedHash === hash) {
    logQuickEmpty(stateDir);
    emit('EMPTY');
  }

  emit('RUN|' + hash);
}

if (quickMode) runQuickPrecheck(stateDir, forceMode);

function computePhase(since: string | null) {
  if (!since) return 'adult';
  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) return 'adult';
  const ageDays = Math.floor((Date.now() - sinceDate.getTime()) / (1000 * 60 * 60 * 24));
  if (ageDays < 3) return 'newborn';
  if (ageDays < 14) return 'juvenile';
  return 'adult';
}

function daysSince(isoStr: string | null) {
  if (!isoStr) return Infinity;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

// Uses the full 20-entry tail for a stable median, but short-circuits if no entries
// exist after lastRunAt (no recent spend → no spike to detect).
function checkCostSpike(costLogPath: string, lastRunAt: string | null) {
  try {
    const content = fs.readFileSync(costLogPath, 'utf-8').trim();
    if (!content) return false;

    const lines = content.split('\n').slice(-20);
    const entries = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    const cutoff = lastRunAt ? new Date(lastRunAt) : null;
    const hasRecentEntries = cutoff
      ? entries.some(e => e.timestamp && new Date(e.timestamp) > cutoff)
      : entries.length > 0;
    if (!hasRecentEntries) return false;

    const byDate: Record<string, number> = {};
    for (const e of entries) {
      const date = (e.timestamp || '').slice(0, 10);
      if (!date) continue;
      byDate[date] = (byDate[date] || 0) + (e.estimated_cost_usd || 0);
    }

    const values = Object.values(byDate);
    if (values.length < 2) return false;

    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const today = new Date().toISOString().slice(0, 10);
    const todayTotal = byDate[today] || 0;

    return median > 0 && todayTotal > 0 && todayTotal > 2 * median;
  } catch {
    return false;
  }
}

function hasAcceptedProposals(stateDir: string) {
  try {
    const proposalsDir = path.join(stateDir, 'proposals');
    const files = fs.readdirSync(proposalsDir).filter(f => /^PROP-\d+(?:-.+)?\.md$/.test(f));
    return files.some(f => {
      try {
        const head = fs.readFileSync(path.join(proposalsDir, f), 'utf-8').slice(0, 1000);
        return /^\s*status:\s*accepted\s*$/mi.test(head);
      } catch { return false; }
    });
  } catch {
    return false;
  }
}

// Short-circuits cheaply: in_progress or missing lastRunAt require no I/O.
function hasComputeActivity(stateDir: string, lastRunAt: string | null, sessionState: string) {
  if (sessionState === 'in_progress') return true;
  if (!lastRunAt) return true;

  const lastRun = new Date(lastRunAt);
  if (isNaN(lastRun.getTime())) return true;

  try {
    const sessionsDir = path.join(stateDir, 'sessions');
    // Exclude empty auto-archives: their auto-close mtime bump would trigger compute
    // on a report with no operator content. Daily-lull closes carry operator_turns > 0
    // and DO trigger compute. See isEmptyAutoArchive in lib/frontmatter.ts.
    const reports = fs.readdirSync(sessionsDir)
      .filter(f => /^S-\d+-REPORT\.md$/.test(f))
      .filter(f => !isEmptyAutoArchive(readFrontmatter(path.join(sessionsDir, f))));
    return reports.some(f => {
      try { return fs.statSync(path.join(sessionsDir, f)).mtime > lastRun; }
      catch { return false; }
    });
  } catch {
    return false;
  }
}

// Returns true when SHELL.md is large enough AND ≥24h has elapsed since the
// last snapshot. Null last_shell_snapshot_at fires on size alone.
function isShellSnapshotDue(stateDir: string, runtime: Json) {
  const SHELL_LINE_THRESHOLD = 400;
  try {
    const shellPath = path.join(stateDir, 'sessions', 'SHELL.md');
    const content = fs.readFileSync(shellPath, 'utf-8');
    const lines = content.split('\n').length;
    if (lines < SHELL_LINE_THRESHOLD) return false;
    const last = runtime.last_shell_snapshot_at;
    if (!last) return true;
    return daysSince(last) >= 1;
  } catch {
    return false;
  }
}

const reflectionStatePath = path.join(stateDir, 'state', 'reflection-state.json');
const reflectionState = readJSON(reflectionStatePath) ?? {};
const counters = reflectionState.counters ?? {};
const lastRunAt = counters.last_run_at ?? null;
const since = counters.since ?? null;
const phase = computePhase(since);

const runtime = readJSON(path.join(stateDir, 'state', 'runtime.json')) ?? {};
const sessionState = runtime.session_state ?? 'idle';

const config = readJSON(path.join(stateDir, 'config.json')) ?? {};
const timezone = config.timezone ?? 'UTC';

const phases: Record<string, boolean> = {};

// Cheaper checks first: compute (short-circuits on in_progress/null lastRunAt),
// then resolution_check (reads proposal files), then cost spike (reads cost log).
if (hasComputeActivity(stateDir, lastRunAt, sessionState)) phases.compute = true;

const lastResolutionCheck = reflectionState.last_resolution_check ?? null;
if (hasAcceptedProposals(stateDir) && daysSince(lastResolutionCheck) > 7) {
  phases.resolution_check = true;
}

const costLogPath = path.resolve(stateDir, '..', '.claude', 'cost-log.jsonl');
if (checkCostSpike(costLogPath, lastRunAt)) phases.cost_spike = true;

if (phase === 'juvenile' && daysSince(reflectionState.last_digest_at) > 7) {
  phases.digest = true;
}

if (phase === 'newborn') phases.newborn = true;

// Run archive synchronously so the LLM (when other phases fire) sees a
// bounded SHELL.md.
const archiveDue = isShellSnapshotDue(stateDir, runtime);
let archiveTaken = false;

if (archiveDue) {
  if (!pluginRoot) {
    console.error('[reflect-precheck] archive_due skipped: pluginRoot missing');
  } else {
    try {
      const stdout = execFileSync(process.execPath, [
        path.join(pluginRoot, 'scripts', 'archive-shell.ts'),
        '--source=routine',
        `--state-dir=${stateDir}`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        const result = JSON.parse(stdout.toString().trim());
        archiveTaken = result && result.archived === true;
      } catch { /* malformed output → treat as not-archived */ }
    } catch { /* fail-open */ }
  }
}

// Gate on archiveTaken: a failed subprocess shouldn't cost LLM tokens
// reasoning about a snapshot that never landed.
const onlyArchive = archiveDue && Object.keys(phases).length === 0;
if (archiveTaken && !onlyArchive) phases.archive_due = true;

// Run archive-raw.ts on a 7-day debounce so raw/.archive/ is bounded on every hermit
// regardless of whether weekly-review is configured.
if (pluginRoot && daysSince(runtime.last_raw_archive_at) >= 7) {
  try {
    execFileSync(process.execPath, [
      path.join(pluginRoot, 'scripts', 'archive-raw.ts'),
      stateDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Re-read before writing — archive-shell may have updated runtime.json concurrently.
    const runtimePath = path.join(stateDir, 'state', 'runtime.json');
    const freshRuntime = readJSON(runtimePath) ?? runtime;
    freshRuntime.last_raw_archive_at = new Date().toISOString();
    try {
      fs.writeFileSync(
        runtimePath,
        JSON.stringify(freshRuntime, null, 2) + '\n',
        'utf-8',
      );
    } catch { /* fail-open */ }
  } catch { /* fail-open */ }
}

const ledgerPath = path.join(stateDir, 'state', 'observations.jsonl');

// --- Drift capture: write storage/schema drift rows to observations ledger ---
// Drift is structural (a dir/type is present or absent), not a recurring behavior, so
// dedup by pattern alone: a standing unresolved drift writes exactly one row and then
// stays silent, instead of writing a fresh row every session (which would flip the
// freshness gate to RUN on every session forever). The row ages out of the ledger after
// prune-observations' 30-day window, so persistent drift re-surfaces ~monthly on the next
// reflect run rather than never. Mechanical drift is always own-work; writing happens
// before the freshness gate so a first-sighting row triggers RUN on the same invocation.
let wroteNewRows = false;
try {
  // runtime.session_id is commonly null (written at startup, cleared on shutdown) — treat null as 'unknown'
  const sessionId = (runtime.session_id ?? 'unknown') as string;

  // Load existing pattern labels to dedup-on-write. Drift slugs are namespaced
  // (storage-drift:/schema-drift:), so scanning all patterns can't collide with
  // reflect-noticed/cost-spike rows.
  const existingPatterns = new Set<string>();
  try {
    for (const line of fs.readFileSync(ledgerPath, 'utf-8').trim().split('\n').filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if (row.pattern) existingPatterns.add(row.pattern);
      } catch {}
    }
  } catch {}

  const newRows: string[] = [];
  const nowIso = new Date().toISOString();
  const capture = (slug: string) => {
    if (existingPatterns.has(slug)) return;
    existingPatterns.add(slug);
    newRows.push(JSON.stringify({ ts: nowIso, pattern: slug, session_id: sessionId, source: 'startup-drift', origin: 'own-work' }));
  };

  // Storage drift — capture the full subpath so raw/foo and raw/bar get distinct slugs
  for (const hit of findStorageDrift(stateDir)) {
    const m = hit.match(/\.claude-code-hermit\/(.+)\/ \(/);
    if (m) capture(`storage-drift:${m[1]}`);
  }

  // Schema drift
  for (const { type } of findSchemaDrift(stateDir)) {
    capture(`schema-drift:${type}`);
  }

  if (newRows.length > 0) {
    fs.appendFileSync(ledgerPath, newRows.join('\n') + '\n', 'utf-8');
    wroteNewRows = true;
  }
} catch { /* fail-open */ }

// --- Freshness gate: flip EMPTY→RUN when ledger has rows newer than last_run_at ---
// Only precheck-written (startup-drift) rows self-trigger because they are written above,
// before this gate runs. Rows written *during* a run (reflect-noticed, cost-spike) have
// ts ≤ last_run_at on the next tick and do NOT self-trigger — they surface opportunistically.
if (wroteNewRows) {
  // Rows just appended carry ts = now > last_run_at by construction — skip the re-read.
  phases.observations_fresh = true;
} else try {
  const content = fs.readFileSync(ledgerPath, 'utf-8').trim();
  if (content) {
    // null last_run_at (fresh hermit) → cutoff = 0 → any valid ts triggers
    const cutoff = lastRunAt ? new Date(lastRunAt).getTime() : 0;
    const hasFresh = content.split('\n').filter(Boolean).some(line => {
      try {
        const row = JSON.parse(line);
        const rowTime = new Date(row.ts).getTime();
        return !isNaN(rowTime) && rowTime > cutoff;
      } catch { return false; }
    });
    if (hasFresh) phases.observations_fresh = true;
  }
} catch { /* fail-open: scan error → skip trigger, don't force RUN */ }

if (Object.keys(phases).length > 0) emit('RUN|' + JSON.stringify(phases));

// EMPTY path: update reflection-state.json and append Progress Log line.
if (pluginRoot) {
  const updateScript = path.join(pluginRoot, 'scripts', 'update-reflection-state.ts');
  try {
    execFileSync(process.execPath, [
      updateScript,
      reflectionStatePath,
      JSON.stringify({ ran_with_candidates: false }),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch { /* fail-open */ }
}

const hhmm = currentHHMM(timezone);
const snapshotSuffix = archiveTaken ? ' (snapshot taken)' : '';
const logLine = `- [${hhmm}] reflect (${phase}) — 0 candidates; verdicts: accept=0 downgrade=0 suppress=0; outcomes: none${snapshotSuffix}`;
appendToProgressLog(path.join(stateDir, 'sessions', 'SHELL.md'), logLine);

emit('EMPTY');
