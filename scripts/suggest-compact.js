// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/suggest-compact.js — MIT License
// Changes: Threshold set to 60%, simplified to use tool-call counter with
//          session-specific counter files, removed ECC-specific config.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_STDIN = 1024 * 1024; // 1MB safety limit
const COMPACT_THRESHOLD = parseInt(process.env.COMPACT_THRESHOLD || '50', 10) || 50;
const SUBSEQUENT_INTERVAL = 25;
const MAX_COUNTER = 1_000_000;
const CONTEXT_USAGE_THRESHOLD = 0.6; // 60%

const COUNTER_DIR = path.join(os.tmpdir(), `claude-agent-compact-${process.getuid?.() ?? 'win'}`);
let counterDirCreated = false;

function getCounterPath(sessionId) {
  if (!counterDirCreated) {
    fs.mkdirSync(COUNTER_DIR, { recursive: true, mode: 0o700 });
    counterDirCreated = true;
  }
  const safe = (sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(COUNTER_DIR, `counter-${safe}.txt`);
}

function readCounter(counterPath) {
  try {
    const val = parseInt(fs.readFileSync(counterPath, 'utf-8').trim(), 10);
    if (isNaN(val) || val < 0 || val > MAX_COUNTER) return 0;
    return val;
  } catch {
    return 0;
  }
}

function writeCounter(counterPath, value) {
  try {
    fs.writeFileSync(counterPath, String(Math.min(value, MAX_COUNTER)), 'utf-8');
  } catch {
    // Non-fatal
  }
}

async function main() {
  try {
    const chunks = [];
    let totalSize = 0;

    for await (const chunk of process.stdin) {
      totalSize += chunk.length;
      if (totalSize > MAX_STDIN) {
        process.exit(0);
      }
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) {
      process.exit(0);
    }

    const data = JSON.parse(raw);
    const sessionId = data.session_id || data.sessionId || 'default';

    // Check context usage if provided
    const contextUsage = data.context_usage || data.contextUsage || 0;
    if (contextUsage > CONTEXT_USAGE_THRESHOLD) {
      const pct = Math.round(contextUsage * 100);
      const result = {
        additionalContext: `Context window is at ${pct}%. Consider running /compact to maintain response quality.`,
      };
      console.log(JSON.stringify(result));
      process.exit(0);
    }

    // Tool-call counter approach
    const counterPath = getCounterPath(sessionId);
    const count = readCounter(counterPath) + 1;
    writeCounter(counterPath, count);

    // Suggest at initial threshold, then every SUBSEQUENT_INTERVAL calls
    const shouldSuggest =
      count === COMPACT_THRESHOLD ||
      (count > COMPACT_THRESHOLD && (count - COMPACT_THRESHOLD) % SUBSEQUENT_INTERVAL === 0);

    if (shouldSuggest) {
      const result = {
        additionalContext: `You've made ${count} tool calls this session. Consider running /compact at the next logical breakpoint to maintain response quality.`,
      };
      console.log(JSON.stringify(result));
    }
  } catch (err) {
    // Non-fatal — never block on compact suggestion failure
    console.error(`[suggest-compact] Error: ${err.message}`);
    process.exit(0);
  }
}

main();
