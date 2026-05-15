'use strict';

// stop-pipeline.js — unified Stop hook
// Reads stdin once, runs all stop stages in sequence, touches heartbeat.

const { run: costTracker } = require('./cost-tracker');
const { run: cortexRefresh } = require('./cortex-refresh-stage');
const fs = require('fs');
const path = require('path');

const HEARTBEAT_FILE = path.resolve('.claude-code-hermit/state/.heartbeat');

async function main() {
  // Read stdin once
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of process.stdin) {
    totalSize += chunk.length;
    if (totalSize > 1024 * 1024) break;
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();

  // Defensive: fall back to {} on malformed/truncated input.
  let payload = {};
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
  } catch (e) { console.error(`[stop-pipeline] cost-tracker: ${e.message}`); }

  // Stage 2: cortex-refresh (standard+, mtime-gated)
  if (isStandardPlus) {
    try { await cortexRefresh(); }
    catch (e) { console.error(`[stop-pipeline] cortex-refresh: ${e.message}`); }
  }

  // Guaranteed heartbeat touch — runs even if all stages fail
  try { fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString() + '\n'); } catch {}
}

main().catch(e => { console.error(`[stop-pipeline] ${e.message}`); });
