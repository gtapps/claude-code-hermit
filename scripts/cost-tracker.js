// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/cost-tracker.js — MIT License
// Changes: Added ACTIVE.md cost injection for session tracking,
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
const ACTIVE_SESSION = path.resolve('.claude/.claude-code-hermit/sessions/ACTIVE.md');

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

function getCumulativeCost() {
  try {
    const logContent = fs.readFileSync(COST_LOG, 'utf-8').trim();
    if (!logContent) return { cost: 0, tokens: 0 };

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
    return { cost: 0, tokens: 0 };
  }
}

function checkBudget(cumulativeCost) {
  try {
    const content = fs.readFileSync(ACTIVE_SESSION, 'utf-8');
    const match = content.match(/\*\*Budget:\*\*\s*\$(\d+\.?\d*)/);
    if (!match) return;

    const budget = parseFloat(match[1]);
    if (budget <= 0) return;

    const pct = (cumulativeCost / budget) * 100;

    if (pct >= 100) {
      console.error(`[cost-tracker] Budget exceeded: $${cumulativeCost.toFixed(2)} spent of $${budget.toFixed(2)} budget. Consider /claude-code-hermit:session-close.`);
    } else if (pct >= 80) {
      console.error(`[cost-tracker] Budget warning: ${Math.round(pct)}% of $${budget.toFixed(2)} budget spent ($${cumulativeCost.toFixed(2)}).`);
    }
  } catch {
    // Non-fatal
  }
}

function updateActiveSession(costStr, tokenStr) {
  try {
    let content = fs.readFileSync(ACTIVE_SESSION, 'utf-8');
    const costSection = `## Cost\n${costStr} (${tokenStr})`;

    if (content.includes('## Cost')) {
      content = content.replace(
        /## Cost[\s\S]*?(?=\n## |$)/,
        costSection + '\n'
      );
    } else {
      content = content.trimEnd() + '\n\n' + costSection + '\n';
    }

    fs.writeFileSync(ACTIVE_SESSION, content, 'utf-8');
  } catch (err) {
    // Non-fatal — don't block on session update failure
    console.error(`[cost-tracker] Failed to update ACTIVE.md: ${err.message}`);
  }
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

    const cost = calculateCost(model, inputTokens, outputTokens);
    const totalTokens = inputTokens + outputTokens;

    // Log to JSONL
    const logEntry = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      estimated_cost_usd: Math.round(cost * 10000) / 10000,
    };

    // Ensure directory exists (recursive is idempotent)
    const logDir = path.dirname(COST_LOG);
    fs.mkdirSync(logDir, { recursive: true });

    fs.appendFileSync(COST_LOG, JSON.stringify(logEntry) + '\n', 'utf-8');

    // Calculate cumulative cost from all log entries
    const cumulative = getCumulativeCost();
    const costStr = `$${cumulative.cost.toFixed(4)}`;
    const tokenStr = `${Math.round(cumulative.tokens / 1000)}K tokens`;

    // Update ACTIVE.md with cumulative cost data
    updateActiveSession(costStr, tokenStr);

    // Check budget and warn if approaching/exceeding
    checkBudget(cumulative.cost);

    // Output brief summary
    console.log(`[cost-tracker] ${model}: ${Math.round(totalTokens / 1000)}K tokens, $${cost.toFixed(4)} (cumulative: ${costStr})`);
  } catch (err) {
    // Non-fatal — never block on cost tracking failure
    console.error(`[cost-tracker] Error: ${err.message}`);
    process.exit(0);
  }
}

main();
