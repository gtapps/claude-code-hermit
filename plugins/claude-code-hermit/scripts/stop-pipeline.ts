// stop-pipeline.ts — unified Stop hook
// Reads stdin once, runs all stop stages in sequence, touches heartbeat.
// All stage output goes to stderr; nothing is emitted on stdout.

import { run as costTracker } from './cost-tracker';
import { run as sessionDiff } from './session-diff';
import { run as evaluateSession } from './evaluate-session';
import { sessionCrons, backgroundTasks, ccVersion, hermitDir } from './lib/cc-compat';
import fs from 'node:fs';
import path from 'node:path';

type Json = any;

const HERMIT_DIR = hermitDir();
const HEARTBEAT_FILE = path.join(HERMIT_DIR, 'state', '.heartbeat');
const SNAPSHOT_FILE = path.join(HERMIT_DIR, 'state', 'cc-stop-snapshot.json');

async function main(): Promise<void> {
  // Read stdin once
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of process.stdin) {
    totalSize += chunk.length;
    if (totalSize > 1024 * 1024) break;
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();

  // Defensive: fall back to {} on malformed/truncated input.
  // Stages that don't need the payload still run even on bad input.
  let payload: Json = {};
  if (raw) {
    try { payload = JSON.parse(raw); } catch {
      console.error('[stop-pipeline] malformed stdin, falling back to empty payload');
    }
  }

  const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
  const isStandardPlus = profile !== 'minimal';

  // Stage 1: cost-tracker (always)
  try {
    const out = await costTracker(payload);
    if (out) console.error(out);
  } catch (e: any) { console.error(`[stop-pipeline] cost-tracker: ${e.message}`); }

  // Stage 2: session-diff (standard+, state-aware debounce)
  if (isStandardPlus) {
    try { await sessionDiff(payload); }
    catch (e: any) { console.error(`[stop-pipeline] session-diff: ${e.message}`); }
  }

  // Stage 3: evaluate-session (standard+)
  if (isStandardPlus) {
    try {
      const out = await evaluateSession(payload);
      if (out) console.error(out);
    } catch (e: any) { console.error(`[stop-pipeline] evaluate-session: ${e.message}`); }
  }

  // Guaranteed heartbeat touch — runs even if all stages fail
  try { fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString() + '\n'); } catch {}

  // Write CC-stop-payload snapshot (tri-state, labeled with captured_at).
  // sole writer for state/cc-stop-snapshot.json. Fail-open.
  try {
    const crons = sessionCrons(payload);
    const tasks = backgroundTasks(payload);
    const snapshot = {
      captured_at: new Date().toISOString(),
      cc_version: ccVersion(payload),
      session_crons:    { state: crons.state, count: crons.count },
      background_tasks: { state: tasks.state, count: tasks.count },
    };
    const tmp = SNAPSHOT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch {}
}

main().catch(e => { console.error(`[stop-pipeline] ${e.message}`); });
