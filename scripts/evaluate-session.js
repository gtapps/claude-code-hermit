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

function evaluateSession(content, tasks) {
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
  const statusMatch = content.match(/\*\*Status:\*\*\s*(\S+)/);
  const parsedStatus = statusMatch ? statusMatch[1] : null;
  const hasStatus = parsedStatus && /^(completed|partial|blocked|in_progress|waiting|idle)$/i.test(parsedStatus);
  results.criteria.push({
    name: 'Task status updated',
    status: hasStatus ? 'pass' : 'warn',
    detail: hasStatus ? 'Status field is populated' : 'Status field is missing or empty',
  });
  results.status = parsedStatus;

  // Criterion 2: Plan tracked (via native Claude Code Tasks)
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

// Core evaluation logic extracted for use by both run() and standalone main().
async function _evaluate() {
  // Profile gating — run on "standard" and "strict" only
  const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
  if (profile === 'minimal') {
    return null;
  }

  // Read SHELL.md once — used for hash check and passed to evaluateSession
  let content;
  try {
    content = fs.readFileSync(SHELL_SESSION, 'utf-8');
  } catch {
    content = null;
  }

  // Read tasks once — used for hash salt and passed to evaluateSession
  const tasks = readTasks();
  const hash = content !== null
    ? crypto.createHash('md5').update(content + '\0tasks:' + tasks.length).digest('hex')
    : null;

  // Short-circuit if SHELL.md hasn't changed since last eval
  if (hash !== null) {
    try {
      const cached = fs.readFileSync(HASH_FILE, 'utf-8').trim();
      if (cached === hash) {
        return null;
      }
    } catch {
      // No cache file — first run, continue to eval
    }
  }

  const results = evaluateSession(content, tasks);

  // Write hash after successful eval
  if (hash !== null) {
    try { fs.writeFileSync(HASH_FILE, hash + '\n'); } catch {}
  }

  // Active nudges — output to stderr so they surface as hook feedback
  if (content !== null) {
    const status = results.status || 'unknown';

    // Only nudge during in_progress — not waiting (intentionally paused) or idle
    if (status === 'in_progress') {
      // Find last progress log timestamp
      const progressSection = content.match(/## Progress Log\n([\s\S]*?)(?=\n## |$)/);
      const progressText = progressSection ? progressSection[1].trim() : '';
      const timeEntries = progressText.match(/\[(\d{1,2}:\d{2})\]/g);
      if (timeEntries && timeEntries.length > 0) {
        // Parse session start date from header
        const startMatch = content.match(/\*\*Started:\*\*\s*(\d{4}-\d{2}-\d{2})/);
        if (startMatch) {
          const lastTime = timeEntries[timeEntries.length - 1].replace(/[\[\]]/g, '');
          const lastDate = new Date(`${startMatch[1]}T${lastTime}:00`);
          const hoursAgo = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60);

          if (hoursAgo > 48) {
            console.error('Session may be complete. Consider /session-close or idle transition.');
          } else if (hoursAgo > 4) {
            console.error(`No progress logged in ${Math.round(hoursAgo)}h. Update Progress Log or Blockers.`);
          }
        }
      }
    }

    // Monitoring bloat check (any status)
    const monitoringSection = content.match(/## Monitoring\n([\s\S]*?)(?=\n## |$)/);
    if (monitoringSection) {
      const monitoringLines = (monitoringSection[1].match(/\n/g) || []).length;
      if (monitoringLines > 40) {
        console.error('Monitoring section too large. Alert dedup should prevent this — check if dedup is working.');
      }
    }
  }

  // Human-readable summary to stderr
  const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO' };
  console.error(`\n[session-eval] Overall: ${icon[results.overall]}`);
  for (const c of results.criteria) {
    console.error(`  [${icon[c.status]}] ${c.name}: ${c.detail}`);
  }

  return JSON.stringify(results, null, 2);
}

// Exported run() function for use by stop-pipeline.js.
// Returns the JSON results string, or null if skipped/cached.
// process.exit() calls become returns so the pipeline is not killed.
async function run(_payload) {
  try {
    return await _evaluate();
  } catch (err) {
    console.error(`[session-eval] Error: ${err.message}`);
    return null;
  }
}

module.exports = { run };

if (require.main === module) {
  (async () => {
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

      const result = await _evaluate();
      if (result) console.log(result);
    } catch (err) {
      console.error(`[session-eval] Error: ${err.message}`);
      process.exit(0);
    }
  })();
}
