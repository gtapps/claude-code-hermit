// Updates alert-state.json after a heartbeat evaluation tick — merges new/updated alert entries,
// deletes resolved keys, sets last_clean_eval_at, and overlays self_eval updates.
// Zero npm dependencies, Node stdlib only. Always exits 0 on I/O failure (fail-open).
// The eval JSON is read from stdin (not argv) so free-text alert content can't break shell quoting.
// Usage: bun update-alert-state.ts <state-file-path>   # eval-json on stdin

import fs from 'node:fs';

type Json = any;

const stateFile = process.argv[2];

if (!stateFile) {
  console.error('Usage: bun update-alert-state.ts <state-file-path>   # eval-json on stdin');
  process.exit(1);
}

function apply(payloadJson: string): void {
  let payload: Json;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err: any) {
    console.error(`update-alert-state: invalid payload JSON: ${err.message}`);
    process.exit(1);
  }

  let state: Json = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    // first run or unreadable — seed with the precheck's default shape
    state = { alerts: {}, last_digest_date: null, self_eval: {}, total_ticks: 0 };
  }

  const alerts: Json = {
    ...(state.alerts && typeof state.alerts === 'object' ? state.alerts : {}),
    ...(payload.new_entries && typeof payload.new_entries === 'object' ? payload.new_entries : {}),
    ...(payload.updated_entries && typeof payload.updated_entries === 'object' ? payload.updated_entries : {}),
  };
  if (Array.isArray(payload.resolved_keys)) {
    for (const key of payload.resolved_keys) {
      delete alerts[key];
    }
  }

  const self_eval: Json = {
    ...(state.self_eval && typeof state.self_eval === 'object' ? state.self_eval : {}),
    ...(payload.self_eval_updates && typeof payload.self_eval_updates === 'object' ? payload.self_eval_updates : {}),
  };

  // last_clean_eval_at: take payload value if the key is present (null is valid), else preserve.
  const last_clean_eval_at = 'last_clean_eval_at' in payload
    ? payload.last_clean_eval_at
    : (state.last_clean_eval_at ?? null);

  // Spread state first so precheck-owned fields (total_ticks, last_stale_wake_at) are preserved.
  const updated = {
    ...state,
    alerts,
    self_eval,
    last_clean_eval_at,
  };

  try {
    fs.writeFileSync(stateFile, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  } catch (err: any) {
    console.error(`update-alert-state: write failed: ${err.message}`);
  }

  process.exit(0);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buf += chunk; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => { apply(buf.trim()); });
