// Regenerates state-summary.md from state files. Zero npm dependencies, Node stdlib only.
// CLI mode:  node generate-summary.js <state-dir-path>
// Hook mode: PostToolUse on Edit|Write — fires automatically when a state/ file is edited

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_STDIN = 64 * 1024;
const STATE_SUBDIR = '.claude-code-hermit/state';

function run(stateDir) {

const ALERT_STATE = path.join(stateDir, 'alert-state.json');
const REFLECTION_STATE = path.join(stateDir, 'reflection-state.json');
const METRICS_FILE = path.join(stateDir, 'proposal-metrics.jsonl');
const MICRO_FILE = path.join(stateDir, 'micro-proposals.json');
const OUTPUT = path.join(stateDir, 'state-summary.md');

// Skip entirely if alert-state.json does not exist (not initialized)
if (!fs.existsSync(ALERT_STATE)) return;

// mtime fast path — skip if output is newer than all source files
try {
  const outMtime = fs.statSync(OUTPUT).mtimeMs;
  const sourceMtimes = [ALERT_STATE, REFLECTION_STATE, METRICS_FILE, MICRO_FILE].map(f => {
    try { return fs.statSync(f).mtimeMs; } catch { return 0; }
  });
  if (outMtime > Math.max(...sourceMtimes)) return;
} catch {
  // Output doesn't exist yet — continue to generate
}

// Read alert state
let alertState = { alerts: {}, last_digest_date: null, self_eval: {} };
try {
  alertState = JSON.parse(fs.readFileSync(ALERT_STATE, 'utf-8'));
} catch {}

const alerts = alertState.alerts || {};
let activeAlerts = 0;
let suppressedAlerts = 0;
for (const key of Object.keys(alerts)) {
  if (alerts[key].suppressed) {
    suppressedAlerts++;
  } else {
    activeAlerts++;
  }
}

// Read reflection state
let lastReflection = null;
try {
  const rs = JSON.parse(fs.readFileSync(REFLECTION_STATE, 'utf-8'));
  lastReflection = rs.last_reflection || null;
} catch {}

// Read proposal metrics
let proposalsCreated = 0;
let proposalsResponded = 0;
let microQueued = 0;
let microApproved = 0;
try {
  const lines = fs.readFileSync(METRICS_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'created') proposalsCreated++;
      if (event.type === 'responded') proposalsResponded++;
      if (event.type === 'micro-queued') microQueued++;
      if (event.type === 'micro-resolved' && event.action === 'approved') microApproved++;
    } catch {}
  }
} catch (err) {
  if (err.code !== 'ENOENT') process.stderr.write(`generate-summary: failed to read metrics: ${err.message}\n`);
}

// Read micro-proposals state
let microPending = false;
let microQuestion = null;
try {
  const mp = JSON.parse(fs.readFileSync(MICRO_FILE, 'utf-8'));
  if (mp.active && mp.active.status === 'pending') {
    microPending = true;
    microQuestion = mp.active.question || null;
  }
} catch {}

const responseRate = proposalsCreated > 0
  ? Math.round((proposalsResponded / proposalsCreated) * 100)
  : null;

const lastReflectionStr = lastReflection
  ? new Date(lastReflection).toISOString().replace('T', ' ').slice(0, 16)
  : 'never';

const responseRateStr = responseRate !== null ? `${responseRate}%` : 'no data';

const microApprovalRate = microQueued > 0
  ? Math.round((microApproved / microQueued) * 100)
  : null;
const microApprovalRateStr = microApprovalRate !== null ? `${microApprovalRate}%` : 'no data';

const content = `---
updated: ${new Date().toISOString()}
active_alerts: ${activeAlerts}
suppressed_alerts: ${suppressedAlerts}
proposals_created: ${proposalsCreated}
proposals_responded: ${proposalsResponded}
response_rate: ${responseRate !== null ? (responseRate / 100).toFixed(2) : 'null'}
micro_pending: ${microPending}
micro_approval_rate: ${microApprovalRate !== null ? (microApprovalRate / 100).toFixed(2) : 'null'}
last_reflection: ${lastReflection || 'null'}
---
# Agent State

## Alerts
Active: ${activeAlerts}
Suppressed: ${suppressedAlerts}

## Proposals
Created: ${proposalsCreated}
Responded: ${proposalsResponded}
Response rate: ${responseRateStr}

## Micro-Proposals
Pending: ${microPending ? 'yes' : 'no'}
Question: ${microQuestion || 'none'}
Approval rate: ${microApprovalRateStr}

## Reflection
Last: ${lastReflectionStr}
`;

// Change detection — skip write if content unchanged (ignoring updated timestamp)
try {
  const existing = fs.readFileSync(OUTPUT, 'utf-8');
  // Skip the first line (updated: ...) and compare the rest
  const skipFirst = (s) => s.slice(s.indexOf('\n') + 1);
  if (skipFirst(content) === skipFirst(existing)) return;
} catch {}

fs.writeFileSync(OUTPUT, content, 'utf-8');
}

// CLI mode: node generate-summary.js <state-dir-path>
if (process.argv[2]) {
  run(process.argv[2]);
  process.exit(0);
}

// Hook mode: PostToolUse on Edit|Write — fire only when a state/ file was edited
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  raw += chunk;
  if (raw.length > MAX_STDIN) process.exit(0);
});
process.stdin.on('end', () => {
  try {
    if (!raw.includes(STATE_SUBDIR)) process.exit(0);
    const event = JSON.parse(raw);
    const filePath = (event.tool_input || {}).file_path || (event.tool_input || {}).path || '';
    if (!filePath.includes(STATE_SUBDIR)) process.exit(0);
    run(STATE_SUBDIR);
  } catch {
    // Never block the agent
  }
});
