// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/cost-tracker.js — MIT License
// Changes: Added SHELL.md cost injection for session tracking,
//          simplified pricing model, removed ECC-specific metric paths,
//          added cumulative cost tracking,
//          plan progress sourced from native Claude Code Tasks (via lib/tasks.ts).

import fs from 'node:fs';
import path from 'node:path';

import { calculateCost } from './lib/pricing';
import { readTasks, taskProgress } from './lib/tasks';
import { kStr, formatTokens } from './lib/format';
import { sessionId as ccSessionId, transcriptPath as ccTranscriptPath, entryText, isToolResult, extractUsage, costLogPath, hermitDir } from './lib/cc-compat';
import { costIndexPath, updateCostIndex, readCostIndex, scanAutomatedOpus } from './lib/cost-log';

type Json = any;

const MAX_STDIN = 1024 * 1024; // 1MB safety limit
const HERMIT_DIR = hermitDir();
const COST_LOG = costLogPath(HERMIT_DIR);
const COST_INDEX = costIndexPath(HERMIT_DIR);
const SHELL_SESSION = path.join(HERMIT_DIR, 'sessions', 'SHELL.md');
const STATUS_JSON = path.join(HERMIT_DIR, 'sessions', '.status.json');
const STATUS_JSON_TMP = path.join(HERMIT_DIR, 'sessions', '.status.json.tmp');
const RUNTIME_JSON = path.join(HERMIT_DIR, 'state', 'runtime.json');
const HEARTBEAT_FILE = path.join(HERMIT_DIR, 'state', '.heartbeat');
const COST_SUMMARY = path.join(HERMIT_DIR, 'cost-summary.md');
const TASK_SNAPSHOT = path.join(HERMIT_DIR, 'tasks-snapshot.md');

let _runtimeCache: Json;
function readRuntimeJsonCached(): Json {
  if (_runtimeCache !== undefined) return _runtimeCache;
  try {
    _runtimeCache = JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf-8'));
  } catch {
    _runtimeCache = {};
  }
  return _runtimeCache;
}

function readRuntimeSessionId(): string {
  return readRuntimeJsonCached().session_id || '';
}

function touchHeartbeat(): void {
  try {
    const now = new Date();
    fs.utimesSync(HEARTBEAT_FILE, now, now);
  } catch {
    try { fs.writeFileSync(HEARTBEAT_FILE, '', 'utf-8'); } catch {}
  }
}

function detectModel(modelStr: string | undefined): string {
  if (!modelStr) return 'sonnet';
  const lower = modelStr.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  return 'sonnet';
}

// Scan backward from billedIndex through the current turn and return concatenated
// entry text. The turn boundary is the triggering user prompt (the first non-tool_result
// user entry) — we include it and stop. This passes over intermediate tool-calling
// assistant steps (which each carry their own usage) so a multi-step heartbeat/routine
// turn still reaches its marker, while stopping before the prior turn's prompt so an
// earlier routine's marker can't bleed into a later turn's source.
function scanTriggerMarkers(lines: string[], billedIndex: number): string {
  const parts: string[] = [];
  for (let j = billedIndex - 1; j >= 0; j--) {
    try {
      const prev = JSON.parse(lines[j]);
      parts.push(entryText(prev));
      // Reached this turn's triggering prompt — include it, then stop.
      if (prev.type === 'user' && !isToolResult(prev)) break;
    } catch {}
  }
  return parts.join(' ');
}

// Classify a turn's trigger source from the scanned text of its entries.
// Only the two marker-driven sources are claimed; everything else is 'other'
// (the non-scheduled bucket, typically the largest row in practice).
// Routine ids are validated only for presence/uniqueness in config — the
// strict charset here ([A-Za-z0-9._-]+) is the classifier's own gate, and
// it is confirmed to reject skill-template noise ([hermit-routine:*], <id> placeholders)
// that appears in tool_result entries when routines register.
// Limitation: scanning covers the whole turn (prompt + tool_results), so a turn that
// merely surfaces a marker string in tool output (e.g. grepping these very sources)
// can be misclassified. Accepted — the markers are stable and this is rare in practice.
function classifySource(triggerText: string): string {
  if (!triggerText) return 'other';
  if (triggerText.includes('HEARTBEAT_EVALUATE') ||
      triggerText.includes('/claude-code-hermit:heartbeat run')) {
    return 'heartbeat';
  }
  // Strict charset — must match a real routine id, never a placeholder or glob
  const routineMatch = triggerText.match(/\[hermit-routine:([A-Za-z0-9._-]+)\]/);
  // Length-cap to 64 chars so ids can't overflow markdown table cells
  if (routineMatch) return `routine:${routineMatch[1].slice(0, 64)}`;
  // log-routine-event.sh fallback: present in tool_result when the skill fires the marker
  const logMatch = triggerText.match(/log-routine-event\.sh\s+([A-Za-z0-9._-]+)/);
  if (logMatch) return `routine:${logMatch[1].slice(0, 64)}`;
  return 'other';
}

// Limitation: a turn spanning more than TAIL_BYTES is summed from buffer start, not the real boundary — same bleed as scanTriggerMarkers.
function sumTurnUsage(lines: string[], billedIndex: number): {
  inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number;
  outputTokens: number; model: string; apiCalls: number;
} {
  let inputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0, outputTokens = 0;
  let model = 'sonnet';
  let apiCalls = 0;

  for (let j = billedIndex; j >= 0; j--) {
    try {
      const entry = JSON.parse(lines[j]);
      const usage = extractUsage(entry);
      if (usage) {
        inputTokens += usage.inputTokens;
        cacheWriteTokens += usage.cacheWriteTokens;
        cacheReadTokens += usage.cacheReadTokens;
        outputTokens += usage.outputTokens;
        apiCalls++;
        // Model is constant within a turn; capture it once from the outermost call.
        if (apiCalls === 1) model = usage.model;
      }
      // Turn boundary: the first non-tool_result user entry (same rule as scanTriggerMarkers).
      if (entry.type === 'user' && !isToolResult(entry)) break;
    } catch {}
  }

  return { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, model, apiCalls };
}

function readLastTurnUsage(transcriptPath: string): Json {
  const TAIL_BYTES = 524288; // 512KB — covers most multi-step agentic turns
  try {
    const stat = fs.statSync(transcriptPath);
    const readFrom = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);

    const lines = buf.toString('utf-8').split('\n');
    // Drop the first line when mid-file (it's a partial line)
    if (readFrom > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (!extractUsage(entry)) continue;

        // Found the last billed entry — sum the whole turn.
        const summed = sumTurnUsage(lines, i);

        // Detect operator interaction for operator_turns tracking.
        // Note: real transcripts use type:'user', not type:'human', so this is
        // effectively always false in production — left intact for future correctness.
        let hadHumanTurn = false;
        for (let j = i - 1; j >= 0; j--) {
          try {
            const prev = JSON.parse(lines[j]);
            hadHumanTurn = prev.type === 'human';
            break;
          } catch {}
        }

        const triggerText = scanTriggerMarkers(lines, i);
        const source = classifySource(triggerText);
        return { ...summed, hadHumanTurn, source };
      } catch {}
    }
  } catch {}
  return null;
}

function parseLogEntries(): Json[] {
  try {
    const content = fs.readFileSync(COST_LOG, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').reduce((acc: Json[], line) => {
      try { acc.push(JSON.parse(line)); } catch {}
      return acc;
    }, []);
  } catch {
    return [];
  }
}

function getCumulativeCost(newCost: number, newTokens: number, hadHumanTurn: boolean, currentSessionId: string, index: Json): { cost: number; tokens: number; operatorTurns: number } {
  // O(1) path: read running totals from .status.json
  try {
    const status = JSON.parse(fs.readFileSync(STATUS_JSON, 'utf-8'));
    // Reset when the hermit session changes — prevents cumulative carryover across sessions.
    if (currentSessionId && status.session_id && status.session_id !== currentSessionId) {
      return { cost: newCost, tokens: newTokens, operatorTurns: hadHumanTurn ? 1 : 0 };
    }
    return {
      cost: (status.cost_usd || 0) + newCost,
      tokens: (status.tokens || 0) + newTokens,
      operatorTurns: (status.operator_turns || 0) + (hadHumanTurn ? 1 : 0),
    };
  } catch {
    // First run or missing .status.json — fall back to index (O(1); index already updated)
  }

  if (index) {
    return {
      cost: index.total_cost_usd,
      tokens: index.total_tokens,
      operatorTurns: hadHumanTurn ? 1 : 0,
    };
  }

  const idx = readCostIndex(COST_INDEX);
  if (idx) {
    return { cost: idx.total_cost_usd, tokens: idx.total_tokens, operatorTurns: hadHumanTurn ? 1 : 0 };
  }
  return { cost: newCost, tokens: newTokens, operatorTurns: hadHumanTurn ? 1 : 0 };
}

const MAX_SUMMARY_LEN = 120;

function readRuntimeSessionState(): string {
  return readRuntimeJsonCached().session_state || 'unknown';
}

function writeStatusJson(shellContent: string, cumulative: { cost: number; tokens: number; operatorTurns: number }, sessionId: string): void {
  const { cost: cumulativeCost, tokens: cumulativeTokens, operatorTurns: cumulativeOperatorTurns } = cumulative;
  const taskMatch = shellContent.match(/## Task\n([\s\S]*?)(?=\n## |$)/);
  const blockersMatch = shellContent.match(/## Blockers\n([\s\S]*?)(?=\n## |$)/);
  const tasksMatch = shellContent.match(/\*\*Tasks Completed:\*\*\s*(\d+)/);

  const task = taskMatch ? taskMatch[1].trim().replace(/<!--.*?-->/g, '').trim() : '';

  // Plan progress from native Claude Code Tasks
  const tasks = readTasks();
  const progress = taskProgress(tasks);

  // Write tasks-snapshot.md
  writeTaskSnapshot(tasks, progress);

  const blockersText = blockersMatch ? blockersMatch[1].trim().replace(/<!--.*?-->/g, '').trim() : '';
  const hasBlockers = blockersText.length > 0 && !/^none$/i.test(blockersText);

  const statusData = {
    updated: new Date().toISOString(),
    session_id: sessionId,
    status: readRuntimeSessionState(),
    task: task.split('\n')[0].substring(0, MAX_SUMMARY_LEN),
    plan_done: progress.done,
    plan_total: progress.total,
    tasks_completed: tasksMatch ? parseInt(tasksMatch[1], 10) : 0,
    cost_usd: Math.round(cumulativeCost * 10000) / 10000,
    tokens: cumulativeTokens,
    operator_turns: cumulativeOperatorTurns,
    blockers: hasBlockers ? blockersText.split('\n')[0].substring(0, MAX_SUMMARY_LEN) : null,
  };

  // Atomic write: write to tmp, then rename
  fs.writeFileSync(STATUS_JSON_TMP, JSON.stringify(statusData, null, 2) + '\n', 'utf-8');
  fs.renameSync(STATUS_JSON_TMP, STATUS_JSON);
}

function writeTaskSnapshot(tasks: Json[], progress: { done: number; total: number }): void {
  const { done, total } = progress;

  let content = `---\nupdated: ${new Date().toISOString()}\nprogress: ${done}/${total}\n---\n# Active Tasks\n\n`;
  if (tasks.length === 0) {
    content += 'No active tasks.\n';
  } else {
    content += '| # | Task | Status |\n|---|------|--------|\n';
    for (const t of tasks) {
      let status = t.status;
      if (t.blockedBy && t.blockedBy.length > 0) {
        status += ` (blocked by ${t.blockedBy.join(', ')})`;
      }
      const subject = (t.subject || '').replace(/\|/g, '\\|');
      status = status.replace(/\|/g, '\\|');
      content += `| ${t.id} | ${subject} | ${status} |\n`;
    }
  }

  // Skip write if content unchanged
  try {
    const existing = fs.readFileSync(TASK_SNAPSHOT, 'utf-8');
    // Compare everything after the frontmatter (updated timestamp always differs)
    const body = content.indexOf('\n---\n');
    const existingBody = existing.indexOf('\n---\n');
    if (body >= 0 && existingBody >= 0 && content.slice(body) === existing.slice(existingBody)) return;
  } catch {}
  try { fs.writeFileSync(TASK_SNAPSHOT, content, 'utf-8'); } catch {}
}

function writeCostSummary(index: Json): void {
  if (!index) return;

  const today = new Date().toISOString().slice(0, 10);
  try {
    const stat = fs.statSync(COST_SUMMARY);
    if (stat.mtime.toISOString().slice(0, 10) === today) {
      const existing = fs.readFileSync(COST_SUMMARY, 'utf-8');
      if (/^total_tokens:/m.test(existing)) return;
    }
  } catch {
    // File missing — regenerate
  }

  if (index.total_tokens === 0 && index.total_cost_usd === 0) return;

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const byDate: Record<string, Json> = index.by_date || {};

  const totalCost = index.total_cost_usd || 0;
  const totalTokens = index.total_tokens || 0;
  const totalSessions = index.total_sessions || 0;
  const avgCost = totalSessions > 0 ? totalCost / totalSessions : 0;
  const avgSessionTokens = totalSessions > 0 ? totalTokens / totalSessions : 0;

  const todayEntry = byDate[today] || { cost: 0, tokens: 0, session_ids: [] };
  const todayCost = todayEntry.cost;
  const todayTokens = todayEntry.tokens;
  const todaySessions = (todayEntry.session_ids || []).length;

  let weekCost = 0;
  let weekTokens = 0;
  const weekSessionIds = new Set();
  for (const [date, entry] of Object.entries(byDate)) {
    if (date >= weekAgo) {
      weekCost += entry.cost || 0;
      weekTokens += entry.tokens || 0;
      for (const s of (entry.session_ids || [])) weekSessionIds.add(s);
    }
  }
  const weekSessionCount = weekSessionIds.size;
  const weekAvg = weekSessionCount > 0 ? weekCost / weekSessionCount : 0;

  const opusWake = scanAutomatedOpus(COST_LOG, weekAgo);
  const opusWakeLine = opusWake.count > 0
    ? `\n- ⚠ ${opusWake.count} automated wake(s) on Opus this week ($${opusWake.cost.toFixed(2)}) — consider a lower session model`
    : '';

  let trendTable = '| Date | Sessions | Cost | Tokens |\n|------|----------|------|--------|\n';
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const entry = byDate[d] || { cost: 0, tokens: 0, session_ids: [] };
    const dCost = entry.cost || 0;
    const dTok = entry.tokens || 0;
    const dSessions = (entry.session_ids || []).length;
    if (dCost > 0 || dSessions > 0) {
      trendTable += `| ${d} | ${dSessions} | $${dCost.toFixed(2)} | ${formatTokens(dTok)} |\n`;
    }
  }

  const content = `---
updated: ${new Date().toISOString()}
total_cost_usd: ${Math.round(totalCost * 10000) / 10000}
total_tokens: ${totalTokens}
total_sessions: ${totalSessions}
avg_session_cost_usd: ${Math.round(avgCost * 10000) / 10000}
avg_session_tokens: ${Math.round(avgSessionTokens)}
---
# Cost Summary

## Today
- Sessions: ${todaySessions}
- Cost: $${todayCost.toFixed(2)}
- Tokens: ${kStr(todayTokens)}K

## This Week
- Sessions: ${weekSessionCount}
- Cost: $${weekCost.toFixed(2)}
- Tokens: ${kStr(weekTokens)}K
- Avg per session: $${weekAvg.toFixed(2)}${opusWakeLine}

## All Time
- Sessions: ${totalSessions}
- Cost: $${totalCost.toFixed(2)}
- Tokens: ${kStr(totalTokens)}K
- Avg per session: $${avgCost.toFixed(2)}

## Cost Trend (Last 7 Days)
${trendTable}`;

  try {
    fs.writeFileSync(COST_SUMMARY, content, 'utf-8');
  } catch {
    // Non-fatal
  }
}

function updateShellSession(content: string, costStr: string, tokenStr: string): string {
  const costSection = `## Cost\n${costStr} (${tokenStr})`;

  if (content.includes('## Cost')) {
    content = content.replace(
      /## Cost[\s\S]*?(?=\n## |$)/,
      costSection + '\n'
    );
  } else {
    content = content.trimEnd() + '\n\n' + costSection + '\n';
  }

  return content;
}

// Exported run() function for use by stop-pipeline.ts.
// Returns the summary string, or null if there is nothing to report.
// process.exit() calls become returns so the pipeline is not killed.
async function run(data: Json): Promise<string | null> {
  try {
    const sessionId = ccSessionId(data) || 'unknown';
    const transcriptPath = ccTranscriptPath(data);

    if (!transcriptPath) {
      return null;
    }

    const turn = readLastTurnUsage(transcriptPath);
    if (!turn) {
      return null;
    }

    const { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, model: rawModel, hadHumanTurn, source, apiCalls } = turn;
    const model = detectModel(rawModel);

    const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
    if (totalTokens === 0) {
      return null;
    }

    const cost = calculateCost(model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens);
    const roundedCost = Math.round(cost * 10000) / 10000;

    // Read session_id from runtime.json once per turn (used for log entry + writeStatusJson)
    const runtimeSessionId = readRuntimeSessionId();

    // Log to JSONL
    const logEntry = {
      timestamp: new Date().toISOString(),
      session_id: runtimeSessionId || sessionId,
      source,
      model,
      input_tokens: inputTokens,
      cache_write_tokens: cacheWriteTokens,
      cache_read_tokens: cacheReadTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      api_calls: apiCalls,
      context_usage: data.context_usage ?? data.contextUsage ?? null,
      estimated_cost_usd: roundedCost,
    };

    fs.appendFileSync(COST_LOG, JSON.stringify(logEntry) + '\n', 'utf-8');

    // Update incremental index — O(1) in the common case; O(n) only on first run or log truncation.
    // Must happen before getCumulativeCost so the index fallback sees this turn's line.
    const costIdx = updateCostIndex(COST_LOG, COST_INDEX);

    // Running total from .status.json (O(1)), falls back to index (O(1)) on first run
    const cumulative = getCumulativeCost(roundedCost, totalTokens, hadHumanTurn, runtimeSessionId || sessionId, costIdx);
    const costStr = `$${cumulative.cost.toFixed(4)}`;

    // Read SHELL.md for task/blockers — do NOT write back (avoids race condition with Claude's edits)
    try {
      const shellContent = fs.readFileSync(SHELL_SESSION, 'utf-8');
      writeStatusJson(shellContent, cumulative, runtimeSessionId || sessionId);
    } catch {
      // Non-fatal — session file may not exist yet
    }

    writeCostSummary(costIdx);

    // Return brief summary (pipeline writes this to stderr)
    return `[cost-tracker] ${model}: ${kStr(totalTokens)}K tokens (${kStr(cacheReadTokens)}K cached), $${cost.toFixed(4)} (cumulative: ${costStr})`;
  } catch (err: any) {
    // Non-fatal — never block on cost tracking failure
    console.error(`[cost-tracker] Error: ${err.message}`);
    return null;
  }
}

export { run, getCumulativeCost, classifySource, scanTriggerMarkers, sumTurnUsage };

if (import.meta.main) {
  (async () => {
    try {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      for await (const chunk of process.stdin) {
        totalSize += chunk.length;
        if (totalSize > MAX_STDIN) {
          console.error('[cost-tracker] Stdin exceeds 1MB limit');
          process.exit(0);
        }
        chunks.push(chunk);
      }

      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        process.exit(0);
      }

      const data = JSON.parse(raw);
      const summary = await run(data);
      if (summary) console.log(summary);
      touchHeartbeat();
    } catch (err: any) {
      console.error(`[cost-tracker] Error: ${err.message}`);
      process.exit(0);
    }
  })();
}
