// Updates reflection-state.json after a reflect run — increments diagnostic counters,
// sets last_reflection/last_run_at, preserves all other keys.
// Zero npm dependencies, Node stdlib only. Always exits 0 on I/O failure (fail-open).
// Usage: node update-reflection-state.js <state-file-path> '<json-payload>'

'use strict';

const fs = require('fs');

const stateFile = process.argv[2];
const payloadJson = process.argv[3];

if (!stateFile || !payloadJson) {
  console.error('Usage: node update-reflection-state.js <state-file-path> \'<json-payload>\'');
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(payloadJson);
} catch (err) {
  console.error(`update-reflection-state: invalid payload JSON: ${err.message}`);
  process.exit(1);
}

let state = {};
try {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
} catch {
  // first run before state file exists, or unreadable — counters start at zero
}

const now = new Date().toISOString();

const c = (state.counters && typeof state.counters === 'object') ? { ...state.counters } : {};
const intOf = (v) => Math.max(0, typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0);

// Normalize existing counter fields once so the increment lines below use plain +
c.total_runs = intOf(c.total_runs);
c.runs_with_candidates = intOf(c.runs_with_candidates);
c.empty_runs = intOf(c.empty_runs);
c.judge_accept = intOf(c.judge_accept);
c.judge_downgrade = intOf(c.judge_downgrade);
c.judge_suppress = intOf(c.judge_suppress);
c.proposals_created = intOf(c.proposals_created);
c.micro_proposals_queued = intOf(c.micro_proposals_queued);

const ranWithCandidates = !!payload.ran_with_candidates;
const proposalsCreated = intOf(payload.proposals_created);
const microQueued = intOf(payload.micro_proposals_queued);

c.total_runs += 1;
c.last_run_at = now;
c.runs_with_candidates += ranWithCandidates ? 1 : 0;
c.empty_runs += ranWithCandidates ? 0 : 1;
c.judge_accept += intOf(payload.judge_accept);
c.judge_downgrade += intOf(payload.judge_downgrade);
c.judge_suppress += intOf(payload.judge_suppress);
c.proposals_created += proposalsCreated;
c.micro_proposals_queued += microQueued;
c.last_output_at = (proposalsCreated + microQueued > 0) ? now : (c.last_output_at ?? null);

if (!('since' in c)) c.since = null;

const preserve = (key) => (key in payload) ? payload[key] : (state[key] ?? null);

const updated = {
  ...state,
  last_reflection: now,
  last_resolution_check: preserve('last_resolution_check'),
  last_digest_at: preserve('last_digest_at'),
  counters: c,
};

try {
  fs.writeFileSync(stateFile, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
} catch (err) {
  console.error(`update-reflection-state: write failed: ${err.message}`);
}

process.exit(0);
