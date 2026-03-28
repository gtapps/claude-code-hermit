// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/cost-tracker.js — MIT License
// Changes: Added SHELL.md cost injection for session tracking,
//          simplified pricing model, removed ECC-specific metric paths,
//          added cumulative cost tracking and budget enforcement.

'use strict';

const fs = require('fs');
const path = require('path');

// Per-1M-token pricing (USD)
const PRICING = {
  haiku: { input: 0.8, output: 4.0 },
  sonnet: { input: 3.0, output: 15.0 },
  opus: { input: 15.0, output: 75.0 },
};

const MAX_STDIN = 1024 * 1024; // 1MB safety limit
const COST_LOG = path.resolve('.claude/cost-log.jsonl');
const SHELL_SESSION = path.resolve('.claude/.claude-code-hermit/sessions/SHELL.md');
const STATUS_JSON = path.resolve('.claude/.claude-code-hermit/sessions/.status.json');

function detectModel(modelStr) {
  if (!modelStr) return 'sonnet';
  const lower = modelStr.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  return 'sonnet';
}

function calculateCost(model, inputTokens, outputTokens) {
  const pricing = PRICING[model] || PRICING.sonnet;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

function getCumulativeCost(newCost, newTokens) {
  // Read running totals from .status.json instead of re-scanning the entire JSONL
  try {
    const status = JSON.parse(fs.readFileSync(STATUS_JSON, 'utf-8'));
    return {
      cost: (status.cost_usd || 0) + newCost,
      tokens: (status.tokens || 0) + newTokens,
    };
  } catch {
    // First run or missing file — fall back to full scan
  }

  try {
    const logContent = fs.readFileSync(COST_LOG, 'utf-8').trim();
    if (!logContent) return { cost: newCost, tokens: newTokens };

    let totalCost = 0;
    let totalTokens = 0;

    for (const line of logContent.split('\n')) {
      try {
        const entry = JSON.parse(line);
        totalCost += entry.estimated_cost_usd || 0;
        totalTokens += entry.total_tokens || 0;
      } catch {
        // Skip malformed lines
      }
    }

    return { cost: totalCost, tokens: totalTokens };
  } catch {
    return { cost: newCost, tokens: newTokens };
  }
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

function writeStatusJson(shellContent, cumulativeCost, cumulativeTokens, budget) {
  const statusMatch = shellContent.match(/\*\*Status:\*\*\s*(\S+)/);
  const taskMatch = shellContent.match(/## Task\n([\s\S]*?)(?=\n## |$)/);
  const planMatch = shellContent.match(/## Plan\n([\s\S]*?)(?=\n## |$)/);
  const blockersMatch = shellContent.match(/## Blockers\n([\s\S]*?)(?=\n## |$)/);
  const idMatch = shellContent.match(/\*\*ID:\*\*\s*(\S+)/);
  const tasksMatch = shellContent.match(/\*\*Tasks Completed:\*\*\s*(\d+)/);

  const task = taskMatch ? taskMatch[1].trim().replace(/<!--.*?-->/g, '').trim() : '';

  let planDone = 0;
  let planTotal = 0;
  if (planMatch) {
    const tableRows = planMatch[1].match(/^\|[^|]+\|[^|]+\|[^|]+\|/gm);
    if (tableRows) {
      for (const row of tableRows) {
        if (/^[\s|:-]+$/.test(row) || /Plan Item|Status/i.test(row)) continue;
        planTotal++;
        if (/✅|done|completed|complete/i.test(row)) planDone++;
      }
    }
  }

  const blockersText = blockersMatch ? blockersMatch[1].trim().replace(/<!--.*?-->/g, '').trim() : '';
  const hasBlockers = blockersText.length > 0 && !/^none$/i.test(blockersText);

  const statusData = {
    updated: new Date().toISOString(),
    session_id: idMatch ? idMatch[1] : '',
    status: statusMatch ? statusMatch[1] : 'unknown',
    task: task.split('\n')[0].substring(0, MAX_SUMMARY_LEN),
    plan_done: planDone,
    plan_total: planTotal,
    tasks_completed: tasksMatch ? parseInt(tasksMatch[1], 10) : 0,
    cost_usd: Math.round(cumulativeCost * 10000) / 10000,
    budget_usd: budget,
    tokens: cumulativeTokens,
    blockers: hasBlockers ? blockersText.split('\n')[0].substring(0, MAX_SUMMARY_LEN) : null,
  };

  fs.writeFileSync(STATUS_JSON, JSON.stringify(statusData, null, 2) + '\n', 'utf-8');
}

function parseBudget(shellContent) {
  const match = shellContent.match(/\*\*Budget:\*\*\s*\$(\d+\.?\d*)/);
  return match ? parseFloat(match[1]) : null;
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

async function main() {
  try {
    // Read hook input from stdin
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

    // Extract token counts — handle various property names
    const inputTokens = data.input_tokens || data.inputTokens || data.usage?.input_tokens || 0;
    const outputTokens = data.output_tokens || data.outputTokens || data.usage?.output_tokens || 0;
    const model = detectModel(data.model || data.model_name || '');
    const sessionId = data.session_id || data.sessionId || 'unknown';

    const totalTokens = inputTokens + outputTokens;
    if (totalTokens === 0) {
      process.exit(0);
    }

    const cost = calculateCost(model, inputTokens, outputTokens);
    const roundedCost = Math.round(cost * 10000) / 10000;

    // Log to JSONL
    const logEntry = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      estimated_cost_usd: roundedCost,
    };

    fs.appendFileSync(COST_LOG, JSON.stringify(logEntry) + '\n', 'utf-8');

    // Running total from .status.json (O(1)), falls back to full JSONL scan on first run
    const cumulative = getCumulativeCost(roundedCost, totalTokens);
    const costStr = `$${cumulative.cost.toFixed(4)}`;
    const tokenStr = `${Math.round(cumulative.tokens / 1000)}K tokens`;

    // Read SHELL.md once, update cost section, then derive status + budget from it
    try {
      const shellContent = fs.readFileSync(SHELL_SESSION, 'utf-8');
      const updated = updateShellSession(shellContent, costStr, tokenStr);
      fs.writeFileSync(SHELL_SESSION, updated, 'utf-8');
      const budget = parseBudget(updated);
      writeStatusJson(updated, cumulative.cost, cumulative.tokens, budget);
      checkBudget(budget, cumulative.cost);
    } catch {
      // Non-fatal — session file may not exist yet
    }

    // Output brief summary
    console.log(`[cost-tracker] ${model}: ${Math.round(totalTokens / 1000)}K tokens, $${cost.toFixed(4)} (cumulative: ${costStr})`);
  } catch (err) {
    // Non-fatal — never block on cost tracking failure
    console.error(`[cost-tracker] Error: ${err.message}`);
    process.exit(0);
  }
}

main();
