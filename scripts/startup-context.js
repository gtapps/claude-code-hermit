'use strict';

// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// startup-context.js — SessionStart hook
// Replaces the inline bash blob with a capped, priority-ordered context injection.
// Emits only startup-relevant SHELL.md sections with per-section budgets.
// Hard cap: 8000 chars total (~2000 tokens).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const AGENT_DIR = process.env.AGENT_DIR || '.claude-code-hermit';
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const HARD_CAP = 8000;

// Section budgets (chars). Higher priority sections emit first.
// If a section exceeds its budget, it is truncated with [...truncated].
// Lower-priority sections are dropped entirely once HARD_CAP is reached.
const BUDGETS = {
  operator:  2000,
  session:   3000,
  cost:       500,
  report:    1500,
  upgrade:    500,
};

// Extract a named ## Section from markdown content.
// Returns the section body (without the header line), or null if not found.
function extractSection(md, name) {
  const idx = md.indexOf(`## ${name}`);
  if (idx === -1) return null;
  const bodyStart = md.indexOf('\n', idx) + 1;
  const nextSection = md.indexOf('\n## ', bodyStart);
  return nextSection !== -1 ? md.slice(bodyStart, nextSection) : md.slice(bodyStart);
}

// Return last N non-empty lines from a string.
function lastLines(text, n) {
  const lines = text.split('\n').filter(l => l.trim());
  return lines.slice(-n).join('\n');
}

function main() {
  let totalChars = 0;

  function emit(label, content) {
    if (totalChars >= HARD_CAP) return;
    const header = `---${label}---\n`;
    // Subtract 1 for the trailing newline written after body
    const available = HARD_CAP - totalChars - header.length - 1;
    if (available <= 0) return;
    let body = content;
    if (body.length > available) {
      body = body.slice(0, available - 15) + '\n[...truncated]';
    }
    process.stdout.write(header + body + '\n');
    totalChars += header.length + body.length + 1;
  }

  // -------------------------------------------------------
  // 1. Operator context (priority 1, budget 2000)
  // -------------------------------------------------------
  const operatorPath = path.resolve(AGENT_DIR, 'OPERATOR.md');
  try {
    const lines = fs.readFileSync(operatorPath, 'utf-8').split('\n').slice(0, 50).join('\n');
    if (lines.trim()) {
      emit('Session Context', lines.slice(0, BUDGETS.operator));
    }
  } catch {
    // No OPERATOR.md — skip silently
  }

  // -------------------------------------------------------
  // 2. Remove stale eval hash (was done inline in the bash hook)
  // -------------------------------------------------------
  try { fs.unlinkSync(path.resolve(AGENT_DIR, 'sessions', '.eval-hash')); } catch {}

  // -------------------------------------------------------
  // 3. Active session (priority 2, budget 3000)
  // -------------------------------------------------------
  const shellPath = path.resolve(AGENT_DIR, 'sessions', 'SHELL.md');
  let shellContent = null;
  try {
    shellContent = fs.readFileSync(shellPath, 'utf-8');
  } catch {}

  if (shellContent === null) {
    emit('Active Session', 'No active session');
  } else {
    const parts = [];

    const task = extractSection(shellContent, 'Task');
    if (task && task.trim() && !task.trim().startsWith('<!--')) {
      parts.push(`## Task\n${task.trimEnd()}`);
    }

    const progressRaw = extractSection(shellContent, 'Progress Log');
    if (progressRaw && progressRaw.trim() && !progressRaw.trim().startsWith('<!--')) {
      const recent = lastLines(progressRaw, 10);
      parts.push(`## Progress Log (last 10)\n${recent}`);
    }

    const blockers = extractSection(shellContent, 'Blockers');
    if (blockers && blockers.trim() && !blockers.trim().startsWith('<!--')) {
      parts.push(`## Blockers\n${blockers.trimEnd()}`);
    }

    const monitoringRaw = extractSection(shellContent, 'Monitoring');
    if (monitoringRaw && monitoringRaw.trim() && !monitoringRaw.trim().startsWith('<!--')) {
      const monLines = monitoringRaw.split('\n').filter(l => l.trim() && (l.startsWith('- ') || l.startsWith('[')));
      if (monLines.length > 0) {
        parts.push(`## Monitoring (last 5)\n${monLines.slice(-5).join('\n')}`);
      }
    }

    const sessionOutput = parts.join('\n\n');
    if (sessionOutput.trim()) {
      emit('Active Session', sessionOutput.slice(0, BUDGETS.session));
    } else {
      emit('Active Session', 'Session file exists but has no actionable content');
    }
  }

  // -------------------------------------------------------
  // 4. Session cost (priority 3, budget 500)
  // -------------------------------------------------------
  try {
    const statusPath = path.resolve(AGENT_DIR, 'sessions', '.status.json');
    const out = execSync(
      `python3 "${path.join(PLUGIN_ROOT, 'scripts', 'read-cost.py')}" "${statusPath}"`,
      { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (out) emit('Session Cost', out.slice(0, BUDGETS.cost));
  } catch {
    // Non-fatal
  }

  // -------------------------------------------------------
  // 5. Last report (priority 4, budget 1500)
  // -------------------------------------------------------
  if (totalChars < HARD_CAP) {
    try {
      const sessionsDir = path.resolve(AGENT_DIR, 'sessions');
      const reports = fs.readdirSync(sessionsDir)
        .filter(f => /^S-\d+-REPORT\.md$/.test(f))
        .sort()
        .reverse();

      if (reports.length > 0) {
        const reportPath = path.join(sessionsDir, reports[0]);
        const reportContent = fs.readFileSync(reportPath, 'utf-8');

        let reportExcerpt = `[${reports[0]}]\n`;
        const overview = extractSection(reportContent, 'Overview');
        if (overview && overview.trim()) {
          reportExcerpt += `## Overview\n${overview.trimEnd()}`;
        } else {
          // No Overview header — emit first 20 lines
          reportExcerpt += reportContent.split('\n').slice(0, 20).join('\n');
        }

        emit('Last Report', reportExcerpt.slice(0, BUDGETS.report));
      } else {
        emit('Last Report', 'No previous sessions');
      }
    } catch {
      emit('Last Report', 'No previous sessions');
    }
  }

  // -------------------------------------------------------
  // 6. Upgrade check (priority 5, budget 500)
  // -------------------------------------------------------
  if (totalChars < HARD_CAP) {
    try {
      const out = execSync(
        `bash "${path.join(PLUGIN_ROOT, 'scripts', 'check-upgrade.sh')}" "${PLUGIN_ROOT}"`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (out) emit('Upgrade Check', out.slice(0, BUDGETS.upgrade));
    } catch {
      // Non-fatal
    }
  }
}

if (require.main === module) {
  main();
}
