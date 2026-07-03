#!/usr/bin/env bun
// Zero-token heartbeat/routine precheck for the error watch loop.
//
// Prints exactly one verdict line and exits 0. The routine's error-triage skill
// runs this as step 1 and stops on SKIP — so a quiet tracker costs no LLM tokens.
//
//   SKIP|no new error groups          nothing since the cursor — stop
//   EVALUATE|<n> new groups           n groups appeared — run triage
//   EVALUATE|no cursor — bootstrap    first run, no cursor yet — run triage
//   ERROR|<scrubbed reason>           config/network/HTTP failure — triage DMs
//                                     the operator after 3 consecutive ERRORs
//
// CURSOR RULE: this script only READS state/error-cursor.json. The error-triage
// skill is the sole writer — a broken precheck must never advance the cursor and
// silently skip real errors forever.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiRequest,
  buildIssuesUrl,
  projectRoot,
  resolveConfig,
} from './error-api-lib';

function emit(line: string): never {
  process.stdout.write(`${line}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  const root = projectRoot();
  const { config, missing } = resolveConfig(root);
  if (!config) emit(`ERROR|config incomplete: ${missing.join(', ')}`);

  let cursor: string | undefined;
  try {
    const raw = readFileSync(join(root, '.claude-code-hermit', 'state', 'error-cursor.json'), 'utf8');
    const parsed = JSON.parse(raw) as { last_seen_first_seen?: string };
    cursor = parsed.last_seen_first_seen;
  } catch {
    cursor = undefined;
  }

  if (!cursor) emit('EVALUATE|no cursor — bootstrap');

  const url = buildIssuesUrl(config, { since: cursor });
  const res = await apiRequest<unknown[]>(url, config.token);
  if (!res.ok) emit(`ERROR|HTTP ${res.status}${res.error ? ' — ' + res.error : ''}`);

  const n = Array.isArray(res.data) ? res.data.length : 0;
  if (n === 0) emit('SKIP|no new error groups');
  emit(`EVALUATE|${n} new groups`);
}

if (import.meta.main) {
  main();
}
