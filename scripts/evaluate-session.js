// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/evaluate-session.js — MIT License
// Changes: Replaced ECC quality criteria with session-specific criteria
//          (task status, SHELL.md current, blockers documented, next-start-point clear).
//          Outputs structured quality score for session reports.

'use strict';

const fs = require('fs');
const path = require('path');

const SHELL_SESSION = path.resolve('.claude/.claude-code-hermit/sessions/SHELL.md');

function evaluateSession() {
  const results = {
    criteria: [],
    overall: 'pass',
  };

  let content;
  try {
    content = fs.readFileSync(SHELL_SESSION, 'utf-8');
  } catch {
    results.criteria.push({
      name: 'SHELL.md exists',
      status: 'fail',
      detail: 'No sessions/SHELL.md found',
    });
    results.overall = 'fail';
    return results;
  }

  // Criterion 1: Task status is set
  const hasStatus = /\*\*Status:\*\*\s*(completed|partial|blocked|in_progress)/i.test(content);
  results.criteria.push({
    name: 'Task status updated',
    status: hasStatus ? 'pass' : 'warn',
    detail: hasStatus ? 'Status field is populated' : 'Status field is missing or empty',
  });

  // Criterion 2: Plan table has entries
  const hasSteps = /\|\s*\d+\s*\|.*\|\s*(done|in_progress|blocked|planned)\s*\|/i.test(content);
  results.criteria.push({
    name: 'Plan tracked',
    status: hasSteps ? 'pass' : 'warn',
    detail: hasSteps ? 'Plan table has entries with statuses' : 'No plan entries found in table',
  });

  // Helper: check if a markdown section exists and has non-comment content
  function checkSection(sectionName) {
    const section = content.match(new RegExp(`## ${sectionName}\n([\\s\\S]*?)(?=\n## |$)`));
    const text = section ? section[1].trim() : '';
    return { exists: !!section, hasContent: text && !text.startsWith('<!--') };
  }

  // Criterion 3: Blockers section
  const blockers = checkSection('Blockers');
  results.criteria.push({
    name: 'Blockers documented',
    status: blockers.exists ? 'pass' : 'warn',
    detail: blockers.exists
      ? blockers.hasContent
        ? 'Blockers section has content'
        : 'Blockers section exists (no blockers reported)'
      : 'No Blockers section found',
  });

  // Criterion 4: Progress log has entries
  const progress = checkSection('Progress Log');
  results.criteria.push({
    name: 'Progress logged',
    status: progress.hasContent ? 'pass' : 'warn',
    detail: progress.hasContent ? 'Progress log has entries' : 'Progress log is empty',
  });

  // Criterion 5: Changed files listed (for closed sessions)
  const changed = checkSection('Changed');
  results.criteria.push({
    name: 'Changed files listed',
    status: changed.hasContent ? 'pass' : 'info',
    detail: changed.hasContent ? 'Changed files are documented' : 'No changed files listed (may be in progress)',
  });

  // Determine overall score
  const failCount = results.criteria.filter(c => c.status === 'fail').length;
  const warnCount = results.criteria.filter(c => c.status === 'warn').length;

  if (failCount > 0) {
    results.overall = 'fail';
  } else if (warnCount >= 3) {
    results.overall = 'warn';
  } else {
    results.overall = 'pass';
  }

  return results;
}

async function main() {
  try {
    // Profile gating — run on "standard" and "strict" only
    const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
    if (profile === 'minimal') {
      process.exit(0);
    }

    // Consume stdin to avoid broken pipe (content not used for evaluation)
    let totalSize = 0;
    for await (const chunk of process.stdin) {
      totalSize += chunk.length;
      if (totalSize > 1024 * 1024) break;
    }

    const results = evaluateSession();

    // Output as structured JSON
    console.log(JSON.stringify(results, null, 2));

    // Also output human-readable summary to stderr
    const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO' };
    console.error(`\n[session-eval] Overall: ${icon[results.overall]}`);
    for (const c of results.criteria) {
      console.error(`  [${icon[c.status]}] ${c.name}: ${c.detail}`);
    }
  } catch (err) {
    console.error(`[session-eval] Error: ${err.message}`);
    process.exit(0);
  }
}

main();
