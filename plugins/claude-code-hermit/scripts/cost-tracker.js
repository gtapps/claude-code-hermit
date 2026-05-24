// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/cost-tracker.js — MIT License
// Changes: Added SHELL.md cost injection for session tracking,
//          simplified pricing model, removed ECC-specific metric paths,
//          added cumulative cost tracking and budget enforcement,
//          plan progress sourced from native Claude Code Tasks (via lib/tasks.js).
//          PR-1 (PROP-047): cost now derived from full JSONL sum (no rounding drift),
//          operator_turns derived from had_human_turn log field + one-time baseline,
//          9 new attribution fields per JSONL row (skill, task, triggered_by, etc.),
//          four cost-profile files updated by cost-aggregator after each append.
//
// skill_args redaction policy:
//   - --<name>=<value> patterns for sensitive keys → ***
//   - Any single arg over 200 chars → <arg:N-chars>
//   - Total args over 500 chars → <args:N-chars-redacted>
//   - .claude/cost-log.jsonl is under .claude/ which .gitignore already excludes.

'use strict';

const fs = require('fs');
const path = require('path');

// Per-1M-token pricing (USD)
const PRICING = {
  haiku:  { input: 0.80, cacheWrite: 1.00,  cacheRead: 0.08, output: 4.0  },
  sonnet: { input: 3.00, cacheWrite: 3.75,  cacheRead: 0.30, output: 15.0 },
  opus:   { input: 15.0, cacheWrite: 18.75, cacheRead: 1.50, output: 75.0 },
};

const { readTasks, taskProgress } = require('./lib/tasks');
const { kStr, formatTokens } = require('./lib/format');
const { run: runAggregator } = require('./cost-aggregator');

const MAX_STDIN = 1024 * 1024; // 1MB safety limit
const COST_LOG       = path.resolve('.claude/cost-log.jsonl');
const SHELL_SESSION  = path.resolve('.claude-code-hermit/sessions/SHELL.md');
const STATUS_JSON    = path.resolve('.claude-code-hermit/sessions/.status.json');
const STATUS_JSON_TMP = path.resolve('.claude-code-hermit/sessions/.status.json.tmp');
const RUNTIME_JSON   = path.resolve('.claude-code-hermit/state/runtime.json');
const HEARTBEAT_FILE = path.resolve('.claude-code-hermit/state/.heartbeat');
const COST_SUMMARY   = path.resolve('.claude-code-hermit/cost-summary.md');
const TASK_SNAPSHOT  = path.resolve('.claude-code-hermit/tasks-snapshot.md');
const COST_BASELINE  = path.resolve('.claude-code-hermit/state/cost-baseline.json');
const INVOCATION_LOG = path.resolve('.claude-code-hermit/state/invocation-log.jsonl');
const PROPOSALS_DIR  = path.resolve('.claude-code-hermit/proposals');

// Sensitive flag patterns — redact the value portion.
const SENSITIVE_PATTERNS = /--(?:token|password|key|secret|api-key|auth)=/i;

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

function calculateCost(model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens) {
  const pricing = PRICING[model] || PRICING.sonnet;
  return (inputTokens      / 1_000_000) * pricing.input
       + (cacheWriteTokens / 1_000_000) * pricing.cacheWrite
       + (cacheReadTokens  / 1_000_000) * pricing.cacheRead
       + (outputTokens     / 1_000_000) * pricing.output;
}

// Apply the skill_args redaction policy before writing to the JSONL log.
function redactSkillArgs(args) {
  if (!args) return null;

  if (args.length > 500) return `<args:${args.length}-chars-redacted>`;

  const parts = args.split(/\s+/);
  const redacted = parts.map(arg => {
    if (SENSITIVE_PATTERNS.test(arg)) {
      return arg.replace(SENSITIVE_PATTERNS, (m) => m + '***').replace(/=\*\*\*(.+)/, '=***');
    }
    if (arg.length > 200) return `<arg:${arg.length}-chars>`;
    return arg;
  });

  return redacted.join(' ') || null;
}

// Extended transcript tail walk. Returns usage + skill/skillArgs + task (all may be null).
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
    // Drop first line when mid-file (it's a partial line)
    if (readFrom > 0) lines.shift();

    let usage = null;
    let hadHumanTurn = false;
    let skill = null;
    let skillArgs = null;
    let task = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }

      // ── Usage: most-recent assistant turn with message.usage ──────────────
      if (usage === null && entry.type === 'assistant' && entry.message?.usage) {
        const u = entry.message.usage;
        usage = {
          inputTokens:      u.input_tokens || 0,
          cacheWriteTokens: u.cache_creation_input_tokens || 0,
          cacheReadTokens:  u.cache_read_input_tokens || 0,
          outputTokens:     u.output_tokens || 0,
          model:            entry.message.model || '',
        };
        // hadHumanTurn: was the immediately preceding entry from a human operator?
        for (let j = i - 1; j >= 0; j--) {
          try {
            const prev = JSON.parse(lines[j]);
            hadHumanTurn = prev.type === 'human';
            break;
          } catch {}
        }
      }

      // ── Skill: most-recent SlashCommand tool_use in any turn ──────────────
      if (skill === null) {
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'tool_use' && item.name === 'SlashCommand') {
              const cmd = (item.input?.command || '').trim();
              if (cmd) {
                const spaceIdx = cmd.indexOf(' ');
                if (spaceIdx > 0) {
                  skill = cmd.slice(0, spaceIdx);
                  skillArgs = cmd.slice(spaceIdx + 1).trim() || null;
                } else {
                  skill = cmd;
                  skillArgs = null;
                }
              }
              break;
            }
          }
        }
      }

      // ── Task: most-recent in_progress TaskCreate or TaskUpdate ───────────
      if (task === null) {
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type !== 'tool_use') continue;
            if (item.name === 'TaskUpdate' && item.input?.status === 'in_progress') {
              task = item.input?.subject || item.input?.content || null;
              break;
            }
            if (item.name === 'TaskCreate') {
              task = item.input?.subject || item.input?.content || null;
              break;
            }
          }
        }
      }

      // Stop early when all three signals captured
      if (usage !== null && skill !== null && task !== null) break;
    }

    if (!usage) return null;
    return { ...usage, hadHumanTurn, skill, skillArgs, task };
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

// Write the operator_turns baseline from the current .status.json value.
// Called exactly once on first run after the PR-1 upgrade.
function writeOperatorTurnsBaseline() {
  try {
    const status = JSON.parse(fs.readFileSync(STATUS_JSON, 'utf-8'));
    const baseline = status.operator_turns || 0;
    fs.writeFileSync(
      COST_BASELINE,
      JSON.stringify({ operator_turns_baseline: baseline }) + '\n',
      'utf-8'
    );
    return baseline;
  } catch {
    // status.json missing or unreadable — start from zero
    try {
      fs.writeFileSync(COST_BASELINE, JSON.stringify({ operator_turns_baseline: 0 }) + '\n', 'utf-8');
    } catch {}
    return 0;
  }
}

function readOperatorTurnsBaseline() {
  try {
    const data = JSON.parse(fs.readFileSync(COST_BASELINE, 'utf-8'));
    return data.operator_turns_baseline || 0;
  } catch {
    // First run after upgrade — snapshot the current .status.json count
    return writeOperatorTurnsBaseline();
  }
}

// Derive cumulative stats by summing the full JSONL (eliminates rounding drift).
// operator_turns = baseline (pre-upgrade historical count) + count of had_human_turn rows.
// The current turn's row was already appended before this is called.
function getCumulativeCost(entries) {
  const logEntries = entries || parseLogEntries();
  let totalCost = 0;
  let totalTokens = 0;
  let newHumanTurns = 0;

  for (const e of logEntries) {
    totalCost += e.estimated_cost_usd || 0;
    totalTokens += e.total_tokens || 0;
    if (e.had_human_turn === true) newHumanTurns++;
  }

  const baseline = readOperatorTurnsBaseline();

  return {
    cost: totalCost,
    tokens: totalTokens,
    operatorTurns: baseline + newHumanTurns,
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
    const body = content.indexOf('\n---\n');
    const existingBody = existing.indexOf('\n---\n');
    if (body >= 0 && existingBody >= 0 && content.slice(body) === existing.slice(existingBody)) return;
  } catch {}
  try { fs.writeFileSync(TASK_SNAPSHOT, content, 'utf-8'); } catch {}
}

function writeCostSummary(entries) {
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

  const logEntries = entries || parseLogEntries();
  if (logEntries.length === 0) return;

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const byDate = {};
  const tokensByDate = {};
  const sessionsByDate = {};
  let totalCost = 0;
  let totalTokens = 0;
  const allSessions = new Set();

  for (const e of logEntries) {
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

// Read the frontmatter title tag from a proposal file.
// Returns the leading [tag-name] bracket prefix, e.g. "[tech-debt]".
function readProposalTag(proposalId) {
  try {
    const files = fs.readdirSync(PROPOSALS_DIR);
    const prefix = proposalId + '-';
    const match = files.find(f => f === `${proposalId}.md` || f.startsWith(prefix));
    if (!match) return null;
    const content = fs.readFileSync(path.join(PROPOSALS_DIR, match), 'utf-8');
    const titleMatch = content.match(/^title:\s*(.+)$/m);
    if (!titleMatch) return null;
    const tagMatch = titleMatch[1].match(/^(\[[^\]]+\])/);
    return tagMatch ? tagMatch[1] : null;
  } catch {
    return null;
  }
}

// Attempt to resolve a PROP-NNN from the current git branch name.
function readBranchProposal() {
  try {
    const { execSync } = require('child_process');
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = branch.match(/(?:feat(?:ure)?|fix|chore)\/PROP-(\d+)/i);
    if (m) return `PROP-${m[1].padStart(3, '0')}`;
  } catch {}
  return null;
}

// Read the last 200 lines of the invocation log for the current session and
// resolve triggered_by / routine_id for the given captured skill.
//
// Dedup: if the most-recent cost-log row for session+skill has a timestamp T,
// we skip any invocation-log entry with ts <= T (it was already attributed to
// that row). This prevents one routine invocation from attributing to multiple
// subsequent Stop events.
function readSkillAttribution(capturedSkill, sessionId, invLines) {
  if (!capturedSkill) return { triggeredBy: 'operator', routineId: null };

  try {
    // Find the attribution boundary: timestamp of the last cost row for this skill+session
    let boundaryTs = null;
    try {
      const costLines = fs.readFileSync(COST_LOG, 'utf-8').trim().split('\n').filter(Boolean);
      for (let i = costLines.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(costLines[i]);
          if (e.session_id === sessionId && e.skill === capturedSkill) {
            boundaryTs = e.timestamp;
            break;
          }
        } catch {}
      }
    } catch {}  // cost-log may not exist yet on first run

    const lines = invLines || [];
    const sessionEntries = lines
      .slice(-200)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.session_id === sessionId && e.event === 'skill-invoke' && e.skill === capturedSkill);

    // Most-recent unattributed skill-invoke entry
    for (let i = sessionEntries.length - 1; i >= 0; i--) {
      const e = sessionEntries[i];
      if (!boundaryTs || e.ts > boundaryTs) {
        return {
          triggeredBy: e.triggered_by || 'operator',
          routineId: e.routine_id || null,
        };
      }
    }
  } catch {}

  return { triggeredBy: 'operator', routineId: null };
}

// Resolve the active proposal for this session via three fallback paths.
function readProposalAttribution(capturedSkill, capturedSkillArgs, sessionId, invLines) {
  // Path 1: skill is proposal-act with accept/resolve args
  if (capturedSkill === '/claude-code-hermit:proposal-act' && capturedSkillArgs) {
    if (/\baccept\b|\bresolve\b/i.test(capturedSkillArgs)) {
      const m = capturedSkillArgs.match(/PROP-(\d+)/i);
      if (m) {
        const propId = `PROP-${m[1].padStart(3, '0')}`;
        return { proposal: propId, proposalTag: readProposalTag(propId) };
      }
    }
  }

  // Path 2: walk invocation-log for open proposals in this session
  try {
    const lines = invLines || [];
    const entries = lines
      .slice(-200)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.session_id === sessionId &&
                   (e.event === 'proposal-accept' || e.event === 'proposal-resolve'));

    const openProposals = [];
    for (const e of entries) {
      if (e.event === 'proposal-accept') {
        openProposals.push(e.proposal_id);
      } else if (e.event === 'proposal-resolve') {
        const idx = openProposals.lastIndexOf(e.proposal_id);
        if (idx >= 0) openProposals.splice(idx, 1);
      }
    }

    if (openProposals.length > 0) {
      const propId = openProposals[openProposals.length - 1];
      return { proposal: propId, proposalTag: readProposalTag(propId) };
    }
  } catch {}

  // Path 3: branch name regex
  const branchProp = readBranchProposal();
  if (branchProp) {
    return { proposal: branchProp, proposalTag: readProposalTag(branchProp) };
  }

  return { proposal: null, proposalTag: null };
}

// Exported run() function for use by stop-pipeline.js.
// Returns the summary string, or null if there is nothing to report.
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

    const {
      inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens,
      model: rawModel, hadHumanTurn,
      skill: capturedSkill, skillArgs: capturedSkillArgs, task: capturedTask,
    } = turn;
    const model = detectModel(rawModel);

    const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
    if (totalTokens === 0) {
      return null;
    }

    const cost = calculateCost(model, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens);
    const roundedCost = Math.round(cost * 10000) / 10000;

    const runtimeSessionId = readRuntimeSessionId();
    const effectiveSessionId = runtimeSessionId || sessionId;

    // 1. Read invocation context BEFORE appending (dedup boundary is based on existing rows)
    const invLines = (() => {
      try {
        return fs.readFileSync(INVOCATION_LOG, 'utf-8').trim().split('\n').filter(Boolean);
      } catch { return []; }
    })();
    const { triggeredBy, routineId } = readSkillAttribution(capturedSkill, effectiveSessionId, invLines);
    const { proposal, proposalTag } = readProposalAttribution(
      capturedSkill, capturedSkillArgs, effectiveSessionId, invLines
    );

    // 2. Append to JSONL with all 9 new attribution fields
    const logEntry = {
      timestamp: new Date().toISOString(),
      session_id: effectiveSessionId,
      model,
      model_full: rawModel || null,
      input_tokens: inputTokens,
      cache_write_tokens: cacheWriteTokens,
      cache_read_tokens: cacheReadTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      estimated_cost_usd: roundedCost,
      had_human_turn: hadHumanTurn,
      skill: capturedSkill || null,
      skill_args: redactSkillArgs(capturedSkillArgs),
      task: capturedTask || null,
      triggered_by: triggeredBy,
      routine_id: routineId || null,
      proposal: proposal || null,
      proposal_tag: proposalTag || null,
    };

    fs.appendFileSync(COST_LOG, JSON.stringify(logEntry) + '\n', 'utf-8');

    // 3. Derive cumulative stats from full JSONL sum (no rounding drift)
    const allEntries = parseLogEntries();
    const cumulative = getCumulativeCost(allEntries);
    const costStr = `$${cumulative.cost.toFixed(4)}`;

    // 4. Read SHELL.md for status/budget — do NOT write back (avoids race condition)
    try {
      const shellContent = fs.readFileSync(SHELL_SESSION, 'utf-8');
      const budget = parseBudget(shellContent);
      writeStatusJson(shellContent, cumulative, budget, effectiveSessionId);
      checkBudget(budget, cumulative.cost);
    } catch {
      // Non-fatal — session file may not exist yet
    }

    // 5. Regenerate cost summary (once per day)
    writeCostSummary(allEntries);

    // 6. Update cost profiles
    try { runAggregator(); } catch {}

    return `[cost-tracker] ${model}: ${kStr(totalTokens)}K tokens (${kStr(cacheReadTokens)}K cached), $${cost.toFixed(4)} (cumulative: ${costStr})`;
  } catch (err) {
    // Non-fatal — never block on cost tracking failure
    console.error(`[cost-tracker] Error: ${err.message}`);
    return null;
  }
}

module.exports = { run };

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
