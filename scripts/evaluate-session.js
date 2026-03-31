// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/evaluate-session.js — MIT License
// Changes: Replaced ECC quality criteria with session-specific criteria
//          (task status, SHELL.md current, blockers documented, next-start-point clear).
//          Outputs structured quality score for session reports.
//          Plan tracking criterion reads native Claude Code Tasks (via lib/tasks.js).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readTasks } = require('./lib/tasks');

const SHELL_SESSION = path.resolve('.claude-code-hermit/sessions/SHELL.md');
const HASH_FILE = path.resolve('.claude-code-hermit/sessions/.eval-hash');

function evaluateSession(content) {
  const results = {
    criteria: [],
    overall: 'pass',
  };

  if (content === null) {
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

  // Criterion 2: Plan tracked (via native Claude Code Tasks)
  const tasks = readTasks();
  const hasSteps = tasks.length > 0;
  results.criteria.push({
    name: 'Plan tracked',
    status: hasSteps ? 'pass' : 'warn',
    detail: hasSteps ? `${tasks.length} task(s) in native Tasks` : 'No tasks found (OK for quick single-step work)',
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

    // Read SHELL.md once — used for hash check and passed to evaluateSession
    let content;
    try {
      content = fs.readFileSync(SHELL_SESSION, 'utf-8');
    } catch {
      content = null;
    }

    // Hash content + task count — used for cache check and write-back
    // Task state is external to SHELL.md, so include it in the hash
    const taskCount = readTasks().length;
    const hash = content !== null
      ? crypto.createHash('md5').update(content + '\0tasks:' + taskCount).digest('hex')
      : null;

    // Short-circuit if SHELL.md hasn't changed since last eval
    if (hash !== null) {
      try {
        const cached = fs.readFileSync(HASH_FILE, 'utf-8').trim();
        if (cached === hash) {
          process.exit(0);
        }
      } catch {
        // No cache file — first run, continue to eval
      }
    }

    const results = evaluateSession(content);

    // Write hash after successful eval
    if (hash !== null) {
      try { fs.writeFileSync(HASH_FILE, hash + '\n'); } catch {}
    }

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
