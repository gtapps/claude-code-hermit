// SubagentStop hook — captures async-dispatched subagent token cost.
//
// Problem: async Agent dispatches complete via XML <task-notification> with no usage
// field in the main transcript. cost-tracker.ts (Stop hook) is structurally blind to them.
// This hook fires on SubagentStop (CC >= v2.1.143), reads the subagent transcript directly
// (payload.agent_transcript_path), and appends a subagent:true row to cost-log.jsonl —
// matching the shape cost-tracker.ts emits for sync subagent completions.
//
// Payload field semantics (verified live on CC 2.1.183):
//   payload.transcript_path        → PARENT (main session) transcript
//   payload.agent_transcript_path  → the SUBAGENT transcript (summed here)
//   payload.agent_id               → matches toolUseResult.agentId in the parent
//
// Only ASYNC dispatches are logged here; sync ones are already logged by cost-tracker.ts.
// We detect async POSITIVELY: the parent transcript carries a launch entry with
// toolUseResult.isAsync===true / status:"async_launched" for this agent_id, written at
// launch time and reliably present at SubagentStop. Sync dispatches never carry that
// marker (their completed+usage result is written AFTER SubagentStop fires), so they are
// skipped — no double-count. This is robust to parent-transcript write ordering.
process.stdout.on('error', () => {});

import fs from 'node:fs';
import path from 'node:path';

import {
  hermitDir, costLogPath, extractUsage,
  transcriptPath as parentTranscriptPath, agentTranscriptPath, agentId as payloadAgentId,
  sessionId as payloadSessionId,
} from './lib/cc-compat';
import { calculateCost } from './lib/pricing';
import { classifySource, scanTriggerMarkers, detectModel } from './cost-tracker';

const HERMIT_DIR = hermitDir();
const COST_LOG = costLogPath(HERMIT_DIR);
const RUNTIME_JSON = path.join(HERMIT_DIR, 'state', 'runtime.json');

function readRuntimeSessionId(): string {
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf-8')).session_id || '';
  } catch { return ''; }
}

function sumSubagentTranscript(transcriptPath: string): {
  model: string; inputTokens: number; cacheWriteTokens: number;
  cacheReadTokens: number; outputTokens: number;
} | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
  let inputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0, outputTokens = 0;
  let model = '';
  let found = false;
  for (const line of content.split('\n')) {
    try {
      const usage = extractUsage(JSON.parse(line));
      if (!usage) continue;
      inputTokens += usage.inputTokens;
      cacheWriteTokens += usage.cacheWriteTokens;
      cacheReadTokens += usage.cacheReadTokens;
      outputTokens += usage.outputTokens;
      if (!model) model = usage.model;
      found = true;
    } catch {}
  }
  return found ? { model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens } : null;
}

// Locate this agent's ASYNC launch entry in the parent transcript. Returns the scanned
// lines + the launch index (for scanTriggerMarkers source attribution), or null when no
// async-launch marker is present for this agentId → sync dispatch or untracked → don't log.
//
// Reads the whole parent (not a tail window): an async parent keeps working while the
// subagent runs in the background, so by SubagentStop the launch entry can be far back —
// a tail window would silently drop legitimate async rows. SubagentStop is infrequent, so
// the full read is cheap. The reverse scan early-exits, so the common recent-launch case
// is still fast.
function findAsyncLaunch(parentPath: string, agentId: string): { lines: string[]; index: number } | null {
  let lines: string[];
  try { lines = fs.readFileSync(parentPath, 'utf-8').split('\n'); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]).toolUseResult;
      if (!r || typeof r !== 'object' || r.agentId !== agentId) continue;
      // Positive async signal — written at launch, present at SubagentStop. Other entries
      // for this agentId (e.g. a later completion notification) are not disqualifying.
      if (r.isAsync === true || r.status === 'async_launched') return { lines, index: i };
    } catch {}
  }
  return null;
}

process.stdin.on('error', () => {});
const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    const payload = raw ? JSON.parse(raw) : {};

    if (payload.stop_hook_active) { process.exit(0); return; }

    const subPath = agentTranscriptPath(payload);
    const parentPath = parentTranscriptPath(payload);
    const aid = payloadAgentId(payload);
    if (!subPath || !aid) { process.exit(0); return; }

    // Only async dispatches are ours; sync ones are logged by cost-tracker.ts. The launch
    // entry also yields source attribution for the row.
    const launch = parentPath ? findAsyncLaunch(parentPath, aid) : null;
    if (!launch) { process.exit(0); return; }

    const usage = sumSubagentTranscript(subPath);
    if (!usage) { process.exit(0); return; }

    const { model: rawModel, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens } = usage;
    const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
    if (totalTokens === 0) { process.exit(0); return; }

    // Source attribution from the launch entry's turn (best-effort, falls back to 'other').
    // findAsyncLaunch reads the whole parent transcript (no tail window), so a missed
    // boundary here just means the launch is in the genuine first turn — no truncation
    // guard needed like cost-tracker.ts's tail-windowed scan.
    let source = 'other';
    try { source = classifySource(scanTriggerMarkers(launch.lines, launch.index).text); } catch {}

    const model = detectModel(rawModel);
    const estimatedCost = Math.round(
      calculateCost(model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens) * 10000
    ) / 10000;

    const entry = {
      timestamp: new Date().toISOString(),
      session_id: payloadSessionId(payload) || readRuntimeSessionId() || 'unknown',
      source,
      model,
      input_tokens:       inputTokens,
      cache_write_tokens: cacheWriteTokens,
      cache_read_tokens:  cacheReadTokens,
      output_tokens:      outputTokens,
      total_tokens:       totalTokens,
      api_calls:          0,
      subagent:           true,
      agent_type:         payload.agent_type || '',
      model_resolved:     !!rawModel,   // subagent transcript always carries a model → effectively always true
      context_usage:      null,
      estimated_cost_usd: estimatedCost,
    };

    try { fs.appendFileSync(COST_LOG, JSON.stringify(entry) + '\n', 'utf-8'); } catch {}
  } catch {}
  process.exit(0);
});
