'use strict';

// stop-pipeline.js — unified Stop hook
// Reads stdin once, runs all stop stages in sequence, touches heartbeat.
// Only suggest-compact output goes to stdout (Claude Code parses it).
// All other stage output goes to stderr.

const { run: costTracker } = require('./cost-tracker');
const { run: suggestCompact } = require('./suggest-compact');
const { run: sessionDiff } = require('./session-diff');
const { run: evaluateSession } = require('./evaluate-session');
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
  // Stages that don't need the payload still run even on bad input.
  let payload = {};
  if (raw) {
    try { payload = JSON.parse(raw); } catch {
      console.error('[stop-pipeline] malformed stdin, falling back to empty payload');
    }
  }

  const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
  const isStandardPlus = profile !== 'minimal';

  // Suggest-compact output gets special treatment — Claude Code parses it for additionalContext
  let compactSuggestion = null;

  // Stage 1: cost-tracker (always)
  try {
    const out = await costTracker(payload);
    if (out) console.error(out);
  } catch (e) { console.error(`[stop-pipeline] cost-tracker: ${e.message}`); }

  // Stage 2: suggest-compact (standard+)
  if (isStandardPlus) {
    try {
      compactSuggestion = await suggestCompact(payload);
    } catch (e) { console.error(`[stop-pipeline] suggest-compact: ${e.message}`); }
  }

  // Stage 3: session-diff (standard+, state-aware debounce)
  if (isStandardPlus) {
    try { await sessionDiff(payload); }
    catch (e) { console.error(`[stop-pipeline] session-diff: ${e.message}`); }
  }

  // Stage 4: evaluate-session (standard+)
  if (isStandardPlus) {
    try {
      const out = await evaluateSession(payload);
      if (out) console.error(out);
    } catch (e) { console.error(`[stop-pipeline] evaluate-session: ${e.message}`); }
  }

  // Guaranteed heartbeat touch — runs even if all stages fail
  try { fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString() + '\n'); } catch {}

  // Emit suggest-compact as the ONLY stdout — Claude Code parses this for additionalContext
  if (compactSuggestion) {
    console.log(JSON.stringify(compactSuggestion));
  }
}

main().catch(e => { console.error(`[stop-pipeline] ${e.message}`); });
