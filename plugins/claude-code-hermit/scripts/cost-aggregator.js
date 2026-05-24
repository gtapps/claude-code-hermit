// Reads .claude/cost-log.jsonl and writes four derived cost-profile files:
//   state/skill-cost-profile.json     — per-skill, 30d rolling window
//   state/routine-cost-profile.json   — per-routine_id, 30d rolling window
//   state/proposal-cost-profile.json  — per-proposal, unbounded (proposals have their own lifecycle)
//   state/task-cost-profile.json      — per-task content hash, 30d rolling window
//
// Called from cost-tracker.js after each JSONL append.
// Fails open: any error exits 0 so the Stop hook is never blocked.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COST_LOG = path.resolve('.claude/cost-log.jsonl');
const STATE_DIR = path.resolve('.claude-code-hermit/state');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function readLogEntries() {
  try {
    const content = fs.readFileSync(COST_LOG, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').reduce((acc, line) => {
      try { acc.push(JSON.parse(line)); } catch {}
      return acc;
    }, []);
  } catch {
    return [];
  }
}

// Nearest-rank percentile on a pre-sorted array.
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function buildProfile(rows) {
  if (rows.length === 0) return null;

  const costs = rows.map(r => r.estimated_cost_usd || 0).sort((a, b) => a - b);
  const tokens = rows.map(r => r.total_tokens || 0).sort((a, b) => a - b);

  const cacheReads = rows.reduce((s, r) => s + (r.cache_read_tokens || 0), 0);
  const totalInputSide = rows.reduce(
    (s, r) => s + (r.input_tokens || 0) + (r.cache_write_tokens || 0) + (r.cache_read_tokens || 0),
    0
  );

  const byTriggeredBy = {};
  for (const r of rows) {
    const t = r.triggered_by || 'operator';
    byTriggeredBy[t] = (byTriggeredBy[t] || 0) + 1;
  }

  const timestamps = rows.map(r => r.timestamp || '').filter(Boolean).sort();

  const totalCost = costs.reduce((s, c) => s + c, 0);
  return {
    invocations: rows.length,
    total_cost_usd: round4(totalCost),
    mean_cost_usd: round4(totalCost / costs.length),
    median_cost_usd: round4(percentile(costs, 50)),
    p95_cost_usd: round4(percentile(costs, 95)),
    total_tokens: tokens.reduce((s, t) => s + t, 0),
    median_tokens: percentile(tokens, 50),
    cache_hit_rate: totalInputSide > 0 ? round4(cacheReads / totalInputSide) : 0,
    by_triggered_by: byTriggeredBy,
    first_seen: timestamps[0] || null,
    last_seen: timestamps[timestamps.length - 1] || null,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// Atomic write: tmp with PID+random suffix to survive concurrent Stop hooks.
function atomicWrite(filePath, data) {
  const suffix = `${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = `${filePath}.${suffix}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(`atomicWrite failed for ${filePath}`);
  }
}

function run() {
  const entries = readLogEntries();
  if (entries.length === 0) return;

  const cutoff30d = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

  // Ensure state dir exists
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}

  const skillMap = {};
  const routineMap = {};
  const proposalMap = {};
  const taskMap = {};

  for (const e of entries) {
    const inWindow = e.timestamp && e.timestamp >= cutoff30d;

    if (e.skill && inWindow) {
      if (!skillMap[e.skill]) skillMap[e.skill] = [];
      skillMap[e.skill].push(e);
    }
    if (e.routine_id && inWindow) {
      if (!routineMap[e.routine_id]) routineMap[e.routine_id] = [];
      routineMap[e.routine_id].push(e);
    }
    if (e.proposal) {
      if (!proposalMap[e.proposal]) proposalMap[e.proposal] = [];
      proposalMap[e.proposal].push(e);
    }
    if (e.task && inWindow) {
      const hash = crypto.createHash('sha256').update(e.task).digest('hex').slice(0, 16);
      if (!taskMap[hash]) taskMap[hash] = { rows: [], content: e.task };
      taskMap[hash].rows.push(e);
    }
  }

  const skillProfile = {};
  for (const [skill, rows] of Object.entries(skillMap)) {
    skillProfile[skill] = buildProfile(rows);
  }
  atomicWrite(path.join(STATE_DIR, 'skill-cost-profile.json'), skillProfile);

  const routineProfile = {};
  for (const [id, rows] of Object.entries(routineMap)) {
    routineProfile[id] = buildProfile(rows);
  }
  atomicWrite(path.join(STATE_DIR, 'routine-cost-profile.json'), routineProfile);

  const proposalProfile = {};
  for (const [id, rows] of Object.entries(proposalMap)) {
    const profile = buildProfile(rows);
    const sessions = new Set(rows.map(r => r.session_id).filter(Boolean));
    profile.session_count = sessions.size;
    profile.proposal_tag = rows[rows.length - 1]?.proposal_tag || null;
    proposalProfile[id] = profile;
  }
  atomicWrite(path.join(STATE_DIR, 'proposal-cost-profile.json'), proposalProfile);

  const taskProfile = {};
  for (const [hash, { rows, content }] of Object.entries(taskMap)) {
    const profile = buildProfile(rows);
    profile.last_seen_content = content;
    taskProfile[hash] = profile;
  }
  atomicWrite(path.join(STATE_DIR, 'task-cost-profile.json'), taskProfile);
}

module.exports = { run };

if (require.main === module) {
  try { run(); } catch (err) {
    // Non-fatal — hooks must not block
    console.error(`[cost-aggregator] Error: ${err.message}`);
    process.exit(0);
  }
}
