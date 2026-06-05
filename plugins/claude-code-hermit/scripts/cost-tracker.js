// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/cost-tracker.js — MIT License
// Changes: Added SHELL.md cost injection for session tracking,
//          simplified pricing model, removed ECC-specific metric paths,
//          added cumulative cost tracking and budget enforcement,
//          plan progress sourced from native Claude Code Tasks (via lib/tasks.js).

'use strict';

const fs = require('fs');
const path = require('path');

const { calculateCost } = require('./lib/pricing');
const { readTasks, taskProgress } = require('./lib/tasks');
const { kStr, formatTokens } = require('./lib/format');

const MAX_STDIN = 1024 * 1024; // 1MB safety limit
const COST_LOG = path.resolve('.claude/cost-log.jsonl');
const SHELL_SESSION = path.resolve('.claude-code-hermit/sessions/SHELL.md');
const STATUS_JSON = path.resolve('.claude-code-hermit/sessions/.status.json');
const STATUS_JSON_TMP = path.resolve('.claude-code-hermit/sessions/.status.json.tmp');
const RUNTIME_JSON = path.resolve('.claude-code-hermit/state/runtime.json');
const HEARTBEAT_FILE = path.resolve('.claude-code-hermit/state/.heartbeat');
const COST_SUMMARY = path.resolve('.claude-code-hermit/cost-summary.md');
const TASK_SNAPSHOT = path.resolve('.claude-code-hermit/tasks-snapshot.md');

function readRuntimeSessionId() {
  try {
    const data = JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf-8'));
    return data.session_id || '';
  } catch {
    return '';
  }
}

function touchHeartbeat() {
  try {
    const now = new Date();
    fs.utimesSync(HEARTBEAT_FILE, now, now);
  } catch {
    try { fs.writeFileSync(HEARTBEAT_FILE, '', 'utf-8'); } catch {}
  }
}

function detectModel(modelStr) {
  if (!modelStr) return 'sonnet';
  const lower = modelStr.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  return 'sonnet';
}

// Stringify an entry's message.content regardless of whether it's a string or a content-block array.
// Real transcripts use both shapes (confirmed in live ops-hermit data).
function entryText(entry) {
  const c = entry.message?.content;
  if (!c) return '';
  return typeof c === 'string' ? c : JSON.stringify(c);
}

// A user entry is a tool_result carrier (not a turn boundary) when its content
// is an array containing any tool_result block. The triggering prompt that opens
// a turn is a "real" user entry: string content, or an array with no tool_result.
function isToolResult(entry) {
  if (entry.type !== 'user') return false;
  const c = entry.message?.content;
  return Array.isArray(c) && c.some(b => b && b.type === 'tool_result');
}

// Scan backward from billedIndex through the current turn and return concatenated
// entry text. The turn boundary is the triggering user prompt (the first non-tool_result
// user entry) — we include it and stop. This passes over intermediate tool-calling
// assistant steps (which each carry their own usage) so a multi-step heartbeat/routine
// turn still reaches its marker, while stopping before the prior turn's prompt so an
// earlier routine's marker can't bleed into a later turn's source.
function scanTriggerMarkers(lines, billedIndex) {
  const parts = [];
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
function classifySource(triggerText) {
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

function readLastTurnUsage(transcriptPath) {
  const TAIL_BYTES = 131072; // 128KB — read from end, avoid loading full transcript
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
        if (entry.type === 'assistant' && entry.message?.usage) {
          const u = entry.message.usage;
          // Detect operator interaction for operator_turns tracking.
          // Note: real transcripts use type:'user', not type:'human', so this is
          // effectively always false in production — left intact for future correctness.
          let hadHumanTurn = false;
          for (let j = i - 1; j >= 0; j--) {
            try {
              const prev = JSON.parse(lines[j]);
              hadHumanTurn = prev.type === 'human';
              break; // stop at first valid entry before this assistant turn
            } catch {}
          }
          const triggerText = scanTriggerMarkers(lines, i);
          const source = classifySource(triggerText);
          return {
            inputTokens:      u.input_tokens || 0,
            cacheWriteTokens: u.cache_creation_input_tokens || 0,
            cacheReadTokens:  u.cache_read_input_tokens || 0,
            outputTokens:     u.output_tokens || 0,
            model:            entry.message.model || '',
            hadHumanTurn,
            source,
          };
        }
      } catch {}
    }
  } catch {}
  return null;
}

function parseLogEntries() {
  try {
    const content = fs.readFileSync(COST_LOG, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').reduce((acc, line) => {
      try { acc.push(JSON.parse(line)); } catch {}
      return acc;
    }, []);
  } catch {
    return [];
  }
}

function getCumulativeCost(newCost, newTokens, hadHumanTurn, currentSessionId) {
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
    // First run or missing file — fall back to full scan
  }

  const entries = parseLogEntries();
  let totalCost = 0;
  let totalTokens = 0;
  for (const entry of entries) {
    totalCost += entry.estimated_cost_usd || 0;
    totalTokens += entry.total_tokens || 0;
  }
  return {
    cost: totalCost > 0 ? totalCost : newCost,
    tokens: totalTokens > 0 ? totalTokens : newTokens,
    operatorTurns: hadHumanTurn ? 1 : 0,
  };
}

function checkBudget(budget, cumulativeCost) {
  if (!budget || budget <= 0) return;

  const pct = (cumulativeCost / budget) * 100;

  if (pct >= 100) {
    console.error(`[cost-tracker] Budget exceeded: $${cumulativeCost.toFixed(2)} spent of $${budget.toFixed(2)} budget. Consider /claude-code-hermit:session-close.`);
  } else if (pct >= 80) {
    console.error(`[cost-tracker] Budget warning: ${Math.round(pct)}% of $${budget.toFixed(2)} budget spent ($${cumulativeCost.toFixed(2)}).`);
  }
}

const MAX_SUMMARY_LEN = 120;

function writeStatusJson(shellContent, cumulative, budget, sessionId) {
  const { cost: cumulativeCost, tokens: cumulativeTokens, operatorTurns: cumulativeOperatorTurns } = cumulative;
  const statusMatch = shellContent.match(/\*\*Status:\*\*\s*(\S+)/);
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
    status: statusMatch ? statusMatch[1] : 'unknown',
    task: task.split('\n')[0].substring(0, MAX_SUMMARY_LEN),
    plan_done: progress.done,
    plan_total: progress.total,
    tasks_completed: tasksMatch ? parseInt(tasksMatch[1], 10) : 0,
    cost_usd: Math.round(cumulativeCost * 10000) / 10000,
    budget_usd: budget,
    tokens: cumulativeTokens,
    operator_turns: cumulativeOperatorTurns,
    blockers: hasBlockers ? blockersText.split('\n')[0].substring(0, MAX_SUMMARY_LEN) : null,
  };

  // Atomic write: write to tmp, then rename
  fs.writeFileSync(STATUS_JSON_TMP, JSON.stringify(statusData, null, 2) + '\n', 'utf-8');
  fs.renameSync(STATUS_JSON_TMP, STATUS_JSON);
}

function parseBudget(shellContent) {
  const match = shellContent.match(/\*\*Budget:\*\*\s*\$(\d+\.?\d*)/);
  return match ? parseFloat(match[1]) : null;
}

function writeTaskSnapshot(tasks, progress) {
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

function writeCostSummary() {
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

  const entries = parseLogEntries();
  if (entries.length === 0) return;

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const byDate = {};
  const tokensByDate = {};
  const sessionsByDate = {};
  let totalCost = 0;
  let totalTokens = 0;
  const allSessions = new Set();

  for (const e of entries) {
    const date = (e.timestamp || '').slice(0, 10);
    if (!date) continue;

    const cost = e.estimated_cost_usd || 0;
    const tok = e.total_tokens || 0;
    totalCost += cost;
    totalTokens += tok;
    byDate[date] = (byDate[date] || 0) + cost;
    tokensByDate[date] = (tokensByDate[date] || 0) + tok;

    if (e.session_id) {
      allSessions.add(e.session_id);
      if (!sessionsByDate[date]) sessionsByDate[date] = new Set();
      sessionsByDate[date].add(e.session_id);
    }
  }

  const totalSessions = allSessions.size;
  const avgCost = totalSessions > 0 ? totalCost / totalSessions : 0;
  const avgSessionTokens = totalSessions > 0 ? totalTokens / totalSessions : 0;
  const todayCost = byDate[today] || 0;
  const todayTokens = tokensByDate[today] || 0;
  const todaySessions = sessionsByDate[today] ? sessionsByDate[today].size : 0;

  let weekCost = 0;
  let weekTokens = 0;
  const weekSessions = new Set();
  for (const [date, cost] of Object.entries(byDate)) {
    if (date >= weekAgo) {
      weekCost += cost;
      weekTokens += tokensByDate[date] || 0;
      if (sessionsByDate[date]) {
        for (const s of sessionsByDate[date]) weekSessions.add(s);
      }
    }
  }
  const weekSessionCount = weekSessions.size;
  const weekAvg = weekSessionCount > 0 ? weekCost / weekSessionCount : 0;

  let trendTable = '| Date | Sessions | Cost | Tokens |\n|------|----------|------|--------|\n';
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const dCost = byDate[d] || 0;
    const dTok = tokensByDate[d] || 0;
    const dSessions = sessionsByDate[d] ? sessionsByDate[d].size : 0;
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
- Avg per session: $${weekAvg.toFixed(2)}

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

function updateShellSession(content, costStr, tokenStr) {
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

// Exported run() function for use by stop-pipeline.js.
// Returns the summary string, or null if there is nothing to report.
// process.exit() calls become returns so the pipeline is not killed.
async function run(data) {
  try {
    const sessionId = data.session_id || 'unknown';
    const transcriptPath = data.transcript_path;

    if (!transcriptPath) {
      return null;
    }

    const turn = readLastTurnUsage(transcriptPath);
    if (!turn) {
      return null;
    }

    const { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, model: rawModel, hadHumanTurn, source } = turn;
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
      estimated_cost_usd: roundedCost,
    };

    fs.appendFileSync(COST_LOG, JSON.stringify(logEntry) + '\n', 'utf-8');

    // Running total from .status.json (O(1)), falls back to full JSONL scan on first run
    const cumulative = getCumulativeCost(roundedCost, totalTokens, hadHumanTurn, runtimeSessionId || sessionId);
    const costStr = `$${cumulative.cost.toFixed(4)}`;

    // Read SHELL.md for status/budget — do NOT write back (avoids race condition with Claude's edits)
    try {
      const shellContent = fs.readFileSync(SHELL_SESSION, 'utf-8');
      const budget = parseBudget(shellContent);
      writeStatusJson(shellContent, cumulative, budget, runtimeSessionId || sessionId);
      checkBudget(budget, cumulative.cost);
    } catch {
      // Non-fatal — session file may not exist yet
    }

    // Regenerate cost summary (once per day)
    writeCostSummary();

    // Return brief summary (pipeline writes this to stderr)
    return `[cost-tracker] ${model}: ${kStr(totalTokens)}K tokens (${kStr(cacheReadTokens)}K cached), $${cost.toFixed(4)} (cumulative: ${costStr})`;
  } catch (err) {
    // Non-fatal — never block on cost tracking failure
    console.error(`[cost-tracker] Error: ${err.message}`);
    return null;
  }
}

module.exports = { run, getCumulativeCost, classifySource, scanTriggerMarkers };

if (require.main === module) {
  (async () => {
    try {
      const chunks = [];
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
    } catch (err) {
      console.error(`[cost-tracker] Error: ${err.message}`);
      process.exit(0);
    }
  })();
}
