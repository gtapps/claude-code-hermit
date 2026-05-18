'use strict';

// reflect-precheck.js — determines which reflect phases are due before invoking LLM.
// Usage: node reflect-precheck.js <hermit-state-dir> <plugin-root>
// Output (stdout, one line): EMPTY  |  RUN|<phases-json>
//
// On EMPTY: this script owns the audit trail — it calls update-reflection-state.js
// and appends the mandatory Progress Log line to SHELL.md before exiting.
//
// Exit 0 always.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { currentHHMM } = require('./lib/time');
const { readFrontmatter } = require('./lib/frontmatter');

function emit(verdict) {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

const stateDir = process.argv[2];
const pluginRoot = process.argv[3];

if (!stateDir) emit('RUN|{}');

const readJSON = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
};

function computePhase(since) {
  if (!since) return 'adult';
  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) return 'adult';
  const ageDays = Math.floor((Date.now() - sinceDate.getTime()) / (1000 * 60 * 60 * 24));
  if (ageDays < 3) return 'newborn';
  if (ageDays < 14) return 'juvenile';
  return 'adult';
}

function daysSince(isoStr) {
  if (!isoStr) return Infinity;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

// Uses the full 20-entry tail for a stable median, but short-circuits if no entries
// exist after lastRunAt (no recent spend → no spike to detect).
function checkCostSpike(costLogPath, lastRunAt) {
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

    const byDate = {};
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

function hasAcceptedProposals(stateDir) {
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
function hasComputeActivity(stateDir, lastRunAt, sessionState) {
  if (sessionState === 'in_progress') return true;
  if (!lastRunAt) return true;

  const lastRun = new Date(lastRunAt);
  if (isNaN(lastRun.getTime())) return true;

  try {
    const sessionsDir = path.join(stateDir, 'sessions');
    const reports = fs.readdirSync(sessionsDir)
      .filter(f => /^S-\d+-REPORT\.md$/.test(f))
      .filter(f => {
        // Exclude auto-closed reports — they have no operator-curated content and their
        // mtime bump (from auto-close writing them) would falsely trigger compute phase.
        // Fail-open: if frontmatter can't be parsed, include the report.
        try { return readFrontmatter(path.join(sessionsDir, f)).closed_via !== 'auto'; }
        catch { return true; }
      });
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
function isShellSnapshotDue(stateDir, runtime) {
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

function appendToProgressLog(shellPath, line) {
  try {
    let content = fs.readFileSync(shellPath, 'utf-8');
    const marker = '## Progress Log';
    const idx = content.indexOf(marker);
    if (idx === -1) {
      content = content.trimEnd() + '\n\n' + line + '\n';
    } else {
      const nextSection = content.indexOf('\n## ', idx + marker.length);
      if (nextSection === -1) {
        content = content.trimEnd() + '\n' + line + '\n';
      } else {
        content = content.slice(0, nextSection) + '\n' + line + content.slice(nextSection);
      }
    }
    fs.writeFileSync(shellPath, content, 'utf-8');
  } catch { /* fail-open */ }
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

const phases = {};

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
        path.join(pluginRoot, 'scripts', 'archive-shell.js'),
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

if (Object.keys(phases).length > 0) emit('RUN|' + JSON.stringify(phases));

// EMPTY path: update reflection-state.json and append Progress Log line.
if (pluginRoot) {
  const updateScript = path.join(pluginRoot, 'scripts', 'update-reflection-state.js');
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
