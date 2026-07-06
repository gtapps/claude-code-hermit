// Updates reflection-state.json after a reflect run — increments diagnostic counters,
// sets last_reflection/last_run_at, preserves all other keys.
// Zero npm dependencies, Node stdlib only. Always exits 0 on I/O failure (fail-open).
// Usage: bun update-reflection-state.ts <state-file-path> '<json-payload>'
//    or: bun update-reflection-state.ts <state-file-path> --quick-hash <hash>
//
// --quick-hash is a distinct write path for the reflect --quick cursor: it writes ONLY
// the top-level last_quick_hash key and does not touch last_run_at/last_reflection/counters
// below — mutating those would suppress the next scheduled reflect (see reflect/SKILL.md's
// quick-mode note on why it never calls the counter-incrementing path below).

import fs from 'node:fs';

type Json = any;

const stateFile = process.argv[2];
const arg3 = process.argv[3];

if (arg3 === '--quick-hash') {
  const hash = process.argv[4];
  if (!stateFile || !hash) {
    console.error('Usage: bun update-reflection-state.ts <state-file-path> --quick-hash <hash>');
    process.exit(1);
  }
  let state: Json = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { /* first run before state file exists */ }
  state.last_quick_hash = hash;
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (err: any) {
    console.error(`update-reflection-state: write failed: ${err.message}`);
  }
  process.exit(0);
}

const payloadJson = arg3;

if (!stateFile || !payloadJson) {
  console.error('Usage: bun update-reflection-state.ts <state-file-path> \'<json-payload>\'');
  process.exit(1);
}

let payload: Json;
try {
  payload = JSON.parse(payloadJson);
} catch (err: any) {
  console.error(`update-reflection-state: invalid payload JSON: ${err.message}`);
  process.exit(1);
}

let state: Json = {};
try {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
} catch {
  // first run before state file exists, or unreadable — counters start at zero
}

const now = new Date().toISOString();

const c: Json = (state.counters && typeof state.counters === 'object') ? { ...state.counters } : {};
const intOf = (v: any) => Math.max(0, typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0);

// Normalize existing counter fields once so the increment lines below use plain +
c.total_runs = intOf(c.total_runs);
c.runs_with_candidates = intOf(c.runs_with_candidates);
c.empty_runs = intOf(c.empty_runs);
c.judge_accept = intOf(c.judge_accept);
c.judge_downgrade = intOf(c.judge_downgrade);
c.judge_suppress = intOf(c.judge_suppress);
if (!c.judge_suppress_by_code || typeof c.judge_suppress_by_code !== 'object') c.judge_suppress_by_code = {};
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
if (payload.judge_suppress_by_code && typeof payload.judge_suppress_by_code === 'object') {
  for (const [code, n] of Object.entries(payload.judge_suppress_by_code)) {
    c.judge_suppress_by_code[code] = intOf(c.judge_suppress_by_code[code]) + intOf(n);
  }
}
c.proposals_created += proposalsCreated;
c.micro_proposals_queued += microQueued;
c.last_output_at = (proposalsCreated + microQueued > 0) ? now : (c.last_output_at ?? null);

if (!('since' in c)) c.since = null;

const preserve = (key: string) => (key in payload) ? payload[key] : (state[key] ?? null);

// Merge last_sparse_nudge map: payload may carry new PROP-NNN → ISO entries.
const existingNudge = (state.last_sparse_nudge && typeof state.last_sparse_nudge === 'object') ? state.last_sparse_nudge : {};
const payloadNudge = (payload.last_sparse_nudge && typeof payload.last_sparse_nudge === 'object') ? payload.last_sparse_nudge : {};
const mergedNudge = { ...existingNudge, ...payloadNudge };

const updated = {
  ...state,
  last_reflection: now,
  last_resolution_check: preserve('last_resolution_check'),
  last_digest_at: preserve('last_digest_at'),
  last_sparse_nudge: Object.keys(mergedNudge).length > 0 ? mergedNudge : null,
  counters: c,
};

try {
  fs.writeFileSync(stateFile, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
} catch (err: any) {
  console.error(`update-reflection-state: write failed: ${err.message}`);
}

process.exit(0);
