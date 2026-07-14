// Updates alert-state.json after a heartbeat evaluation tick. Owns the full
// dedup/suppression/resolution/digest ladder (issue #594): the eval subagent
// returns only a firing set of {key,text} judgment items; this script derives
// the file-backed structured keys (micro-proposal-pending, proposal-pending)
// from their source-of-truth and runs the deterministic ladder over the union.
// Zero npm dependencies, Node stdlib only.
//
// Fail-safe contract: ANY validation failure or write failure exits 0 with NO
// stdout and NO persistent change. The caller (SKILL.md step 5) treats empty
// stdout identically to a malformed subagent return — skip all writes, emit
// HEARTBEAT_OK. Only a genuinely unparseable input payload exits 1 (unchanged
// from before this refactor).
//
// On success, prints one JSON line on stdout: the monitoring lines and
// operator notifications derived from this tick's transitions, plus the
// derived heartbeat_result — so side effects are gated on a durable write.
//
// The eval JSON is read from stdin (not argv) so free-text alert content can't
// break shell quoting.
// Usage: bun update-alert-state.ts <state-file-path>   # eval-json on stdin

import fs from 'node:fs';
import path from 'node:path';
import {
  readAlertState, defaultAlertState, quarantineAlertState, writeAlertState,
  classifyTick, deriveMicroPendingKeys, deriveProposalPendingKeys, FiringItem,
  MICRO_PREFIX, PROPOSAL_PREFIX, isStructuredKey,
} from './lib/alert-state';
import { currentHHMM, todayYMD, resolveHermitNowMs } from './lib/time';

type Json = any;

const stateFile = process.argv[2];

if (!stateFile) {
  console.error('Usage: bun update-alert-state.ts <state-file-path>   # eval-json on stdin');
  process.exit(1);
}

// stateFile = <stateDir>/state/alert-state.json
const stateDir = path.dirname(path.dirname(stateFile));

// Keys backed by a filesystem source-of-truth — the model may never author
// these directly (see deriveMicroPendingKeys/deriveProposalPendingKeys). A
// model-injected entry under either prefix is a phantom and is dropped.
// MICRO_PREFIX/PROPOSAL_PREFIX/isStructuredKey are owned by alert-state.ts
// (co-located with the derivers and the channel-safe scrub).

// Reject the whole tick (return null) rather than coerce a malformed shape to
// an empty set — an empty set would age every real alert toward resolution.
function validateFiring(raw: Json): FiringItem[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: FiringItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.key !== 'string' || !entry.key) return null;
    if (typeof entry.text !== 'string') return null;
    if (seen.has(entry.key)) continue; // duplicate key in the same tick — keep first occurrence
    seen.add(entry.key);
    out.push({ key: entry.key, text: entry.text });
  }
  return out;
}

function readConfig(): Json {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8')); }
  catch { return {}; }
}

function apply(payloadJson: string): void {
  let payload: Json;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err: any) {
    console.error(`update-alert-state: invalid payload JSON: ${err.message}`);
    process.exit(1);
  }

  const validated = validateFiring(payload.firing);
  if (validated === null) process.exit(0); // malformed firing shape — reject the tick, no write
  const modelFiring = validated.filter(f => !isStructuredKey(f.key));

  const selfEvalUpdates: Json =
    payload.self_eval_updates && typeof payload.self_eval_updates === 'object' && !Array.isArray(payload.self_eval_updates)
      ? payload.self_eval_updates
      : {};

  // Split read from parse: a transient read error (ioerror) must not clobber a healthy
  // file. ENOENT = first run → seed default. corrupt = bytes read but unparseable →
  // quarantine for forensics, then merge onto a default. ioerror = bail without writing.
  let state: Json;
  const r = readAlertState(stateFile);
  if (r.kind === 'ok') {
    state = r.value;
  } else if (r.kind === 'missing') {
    state = defaultAlertState();
  } else if (r.kind === 'corrupt') {
    quarantineAlertState(stateFile, Date.now());
    state = defaultAlertState();
  } else {
    console.error(`update-alert-state: read failed (${r.code ?? 'unknown'}); skipping write`);
    process.exit(0);
  }

  const prevAlerts: Json = state.alerts && typeof state.alerts === 'object' ? state.alerts : {};

  const config = readConfig();
  const timezone = config.timezone ?? 'UTC';
  const nowDate = new Date(resolveHermitNowMs());
  const nowIso = nowDate.toISOString();
  const today = todayYMD(timezone, nowDate);
  const hhmm = currentHHMM(timezone, nowDate) ?? nowIso.slice(11, 16);

  const micro = deriveMicroPendingKeys(stateDir);
  const proposal = deriveProposalPendingKeys(stateDir);

  // Fail-safe: an ambiguous source-of-truth read must never age or resolve
  // that prefix's existing entries this tick (the exact #594 harm this
  // refactor exists to prevent) — freeze them untouched instead.
  const frozen: Json = {};
  const classifiable: Json = { ...prevAlerts };
  const freezePrefix = (prefix: string) => {
    for (const k of Object.keys(classifiable)) {
      if (k.startsWith(prefix)) { frozen[k] = classifiable[k]; delete classifiable[k]; }
    }
  };
  if (!micro.ok) freezePrefix(MICRO_PREFIX);
  if (!proposal.ok) freezePrefix(PROPOSAL_PREFIX);

  // An ambiguous structured read means this tick's view is partial: never report
  // a verified-clean eval (would arm the precheck damper over an unverifiable
  // pending decision) and never emit/advance the digest on a partial view.
  const hasStructuredReadFailure = !micro.ok || !proposal.ok;

  const structuredItems = [...(micro.ok ? micro.items : []), ...(proposal.ok ? proposal.items : [])];
  const firing: FiringItem[] = [...modelFiring, ...structuredItems];

  // Structured keys' text bakes in a raw PROP-NNN/MP-… id, which must never
  // reach the operator channel (house channel-voice rule) — silence their
  // first-observation notification. SHELL.md monitoring lines are unaffected.
  const silentOnNewKeys = new Set(structuredItems.map(i => i.key));

  const result = classifyTick({
    prevAlerts: classifiable,
    firing,
    nowIso,
    today,
    hhmm,
    prevLastDigestDate: typeof state.last_digest_date === 'string' ? state.last_digest_date : null,
    silentOnNewKeys,
    structuredReadOk: !hasStructuredReadFailure,
  });

  const alerts: Json = { ...result.alerts, ...frozen };

  const self_eval: Json = {
    ...(state.self_eval && typeof state.self_eval === 'object' ? state.self_eval : {}),
    ...selfEvalUpdates,
  };

  // Spread state first so precheck-owned fields (total_ticks, last_stale_wake_at) are preserved.
  const updated = {
    ...state,
    alerts,
    self_eval,
    // null on an ambiguous read disables the precheck clean-recheck damper, so
    // the next tick re-derives the moment the source file is readable again.
    last_clean_eval_at: hasStructuredReadFailure ? null : result.lastCleanEvalAt,
    last_digest_date: result.lastDigestDate,
  };

  const wrote = writeAlertState(stateFile, updated);
  if (!wrote) process.exit(0); // fail-safe: no durable write → emit no side effects

  process.stdout.write(JSON.stringify({
    monitoring_lines: result.monitoringLines,
    notifications: result.notifications,
    // Never OK when a structured pending decision couldn't be verified this tick.
    heartbeat_result: hasStructuredReadFailure ? 'ALERT' : result.heartbeatResult,
  }) + '\n');

  process.exit(0);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buf += chunk; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => { apply(buf.trim()); });
