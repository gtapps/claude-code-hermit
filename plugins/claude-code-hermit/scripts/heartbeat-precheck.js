'use strict';

// heartbeat-precheck.js — fast-path verdict before the LLM evaluates HEARTBEAT.md.
// Usage: node heartbeat-precheck.js <hermit-state-dir>
// Output (stdout, one line): SKIP|<reason>  |  OK  |  AUTO_CLOSE  |  EVALUATE
// Exit 0 always. Writes updated alert-state.json (increments total_ticks only).
//
// Owner contract (write-field split with SKILL.md):
//   This script owns: alert-state.json total_ticks
//   SKILL.md owns:    alert-state.json alerts{}, self_eval{}, last_digest_date

const fs = require('fs');
const path = require('path');
const { currentHHMM, todayYMD } = require('./lib/time');

function emit(verdict) {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

const stateDir = process.argv[2];
if (!stateDir) emit('EVALUATE');

const readJSON = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
};

const writeJSON = (p, obj) => {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8'); }
  catch { /* fail-open */ }
};

// Normalises a HEARTBEAT.md checklist item to its dedup key.
// Key format mirrors SKILL.md: 'checklist:<first-8-chars-normalized>'.
function normalizeItemKey(itemText) {
  const text = itemText
    .replace(/^[-*+]\s*(\[.\]\s*)?/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  return text ? `checklist:${text}` : null;
}

let heartbeatContent;
try { heartbeatContent = fs.readFileSync(path.join(stateDir, 'HEARTBEAT.md'), 'utf-8'); }
catch { emit('SKIP|HEARTBEAT.md missing'); }

const checklistItems = heartbeatContent
  .split('\n')
  .map(l => l.trim())
  .filter(l => /^[-*+]\s/.test(l));

if (checklistItems.length === 0) emit('SKIP|HEARTBEAT.md has no checklist items');

const config = readJSON(path.join(stateDir, 'config.json')) ?? {};
const hbConfig = config.heartbeat ?? {};
const timezone = config.timezone ?? 'UTC';
const activeHours = hbConfig.active_hours;

if (activeHours?.start && activeHours?.end) {
  const hhmm = currentHHMM(timezone);
  if (hhmm !== null && (hhmm < activeHours.start || hhmm >= activeHours.end)) {
    emit('SKIP|outside active hours');
  }
}

const alertStatePath = path.join(stateDir, 'state', 'alert-state.json');
const alertState = readJSON(alertStatePath) ?? { alerts: {}, last_digest_date: null, self_eval: {}, total_ticks: 0 };
if (typeof alertState.total_ticks !== 'number' || !Number.isFinite(alertState.total_ticks)) {
  alertState.total_ticks = 0;
}
alertState.total_ticks += 1;
writeJSON(alertStatePath, alertState);

if (alertState.total_ticks % 20 === 0) emit('EVALUATE');

const microProposals = readJSON(path.join(stateDir, 'state', 'micro-proposals.json')) ?? { pending: [] };
const hasPendingMicro = Array.isArray(microProposals.pending) &&
  microProposals.pending.some(p => p.status === 'pending' && p.tier === 1);
if (hasPendingMicro) emit('EVALUATE');

const runtime = readJSON(path.join(stateDir, 'state', 'runtime.json')) ?? {};
const sessionState = runtime.session_state ?? 'idle';

if (sessionState === 'in_progress') {
  // SHELL.md mtime is a reliable cross-day signal; Progress Log [HH:MM] entries are not.
  // Fail-open: any stat error → fall through to EVALUATE (LLM does the stale check).
  try {
    const shellPath = path.join(stateDir, 'sessions', 'SHELL.md');
    const mtime = fs.statSync(shellPath).mtime.getTime();
    let now = Date.now();
    if (process.env.HERMIT_NOW) {
      const d = new Date(process.env.HERMIT_NOW).getTime();
      if (!isNaN(d)) now = d;
    }
    if ((now - mtime) / (1000 * 60 * 60) > 12) emit('AUTO_CLOSE');
  } catch { /* fail-open */ }
  // stale-session check needs SHELL.md parsing — delegate to LLM
  emit('EVALUATE');
}

// waiting-timeout check requires elapsed computation — delegate to LLM
if (sessionState === 'waiting' && hbConfig.waiting_timeout) emit('EVALUATE');

const alerts = alertState.alerts ?? {};
const hasSuppressed = Object.values(alerts).some(e => e?.suppressed === true);
const today = todayYMD(timezone);
if (hasSuppressed && alertState.last_digest_date !== today) emit('EVALUATE');

// OK fires only when every item in HEARTBEAT.md has a matching entry in alerts{}
// that is suppressed (count > 5) and not approaching resolution (consecutive_clean === 0).
// The default template ships a freeform item that will rarely appear suppressed,
// so OK fires primarily for operators who curate structural-only checklist items.
for (const item of checklistItems) {
  const key = normalizeItemKey(item);
  if (!key) emit('EVALUATE');
  const entry = alerts[key];
  if (!entry || !entry.suppressed || (entry.consecutive_clean ?? 0) > 0) emit('EVALUATE');
}

emit('OK');
