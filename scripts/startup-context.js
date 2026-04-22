'use strict';

// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// startup-context.js — SessionStart hook
// Replaces the inline bash blob with a capped, priority-ordered context injection.
// Emits only startup-relevant SHELL.md sections with per-section budgets.
// Hard cap: 9000 chars total (~2250 tokens).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readFileWithFrontmatter, newestByType, globDir } = require('./lib/frontmatter');

const AGENT_DIR = process.env.AGENT_DIR || '.claude-code-hermit';
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const HARD_CAP = 9000;

// Section budgets (chars). Higher priority sections emit first.
// If a section exceeds its budget, it is truncated with [...truncated].
// Lower-priority sections are dropped entirely once HARD_CAP is reached.
const BUDGETS = {
  operator:      2000,
  session:       3000,
  knowledge:     1000, // compiled/ artifacts — read from config, 1000 default
  storageDrift:   500, // only emitted when misplaced files are found
  cost:           500,
  report:        1500,
  upgrade:        500,
};

// Emit artifact entries for a list, tracking chars used against a budget.
// headerFn(artifact) → string used as the section header per entry.
// Pinned and recent budgets are intentionally isolated — unused pinned budget
// does not roll over to recent, and vice versa.
function emitArtifacts(artifacts, budget, headerFn, parts) {
  let used = 0;
  for (const a of artifacts) {
    const header = headerFn(a);
    const body = a.body || '';
    const available = budget - used - header.length;
    if (available <= 0) break;
    const snippet = body.slice(0, available);
    const entry = header + snippet + (snippet.length < body.length ? '\n[...]\n' : '');
    parts.push(entry);
    used += entry.length;
  }
}

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

// Scan hermitDir for artifacts written outside raw/ and compiled/ (flat).
// Returns an array of human-readable hit strings, empty when clean.
function findStorageDrift(hermitDir) {
  const KNOWN_DIRS = new Set(['raw', 'compiled', 'sessions', 'proposals', 'state', 'templates',
    'memory', 'reviews', 'obsidian', 'bin', 'docker']);
  const hits = [];

  function countEntries(dir) {
    try { return fs.readdirSync(dir).filter(f => !f.startsWith('.')).length; } catch { return 0; }
  }

  // Unknown top-level dirs inside .claude-code-hermit/
  try {
    for (const entry of fs.readdirSync(hermitDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!KNOWN_DIRS.has(entry.name)) {
        const n = countEntries(path.join(hermitDir, entry.name));
        hits.push(`.claude-code-hermit/${entry.name}/ (${n} file${n !== 1 ? 's' : ''})`);
      }
    }
  } catch {}

  // Subdirs under raw/ and compiled/ (except .archive)
  for (const side of ['raw', 'compiled']) {
    try {
      for (const entry of fs.readdirSync(path.join(hermitDir, side), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '.archive') continue;
        const n = countEntries(path.join(hermitDir, side, entry.name));
        hits.push(`.claude-code-hermit/${side}/${entry.name}/ (${n} file${n !== 1 ? 's' : ''})`);
      }
    } catch {}
  }

  return hits;
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
  // 4. Compiled knowledge (priority 2.5, budget from config — default 1000)
  // -------------------------------------------------------
  if (totalChars < HARD_CAP) {
    try {
      let knowledgeBudget = BUDGETS.knowledge;
      try {
        const config = JSON.parse(fs.readFileSync(path.resolve(AGENT_DIR, 'config.json'), 'utf-8'));
        if (config.knowledge && typeof config.knowledge.compiled_budget_chars === 'number') {
          knowledgeBudget = config.knowledge.compiled_budget_chars;
        }
      } catch {}

      const compiledDir = path.resolve(AGENT_DIR, 'compiled');
      const compiledFiles = globDir(compiledDir, /^[^.].*\.md$/);

      if (compiledFiles.length > 0) {
        // Single read per file: frontmatter + body in one pass
        const artifacts = compiledFiles
          .map(f => {
            const r = readFileWithFrontmatter(f);
            return r && r.fm && r.fm.created
              ? { file: f, fm: r.fm, body: r.body, basename: path.basename(f, '.md') }
              : null;
          })
          .filter(Boolean);

        if (artifacts.length > 0) {
          const candidates = Array.from(newestByType(artifacts).values());

          const pinned = candidates.filter(a => (a.fm.tags || []).includes('foundational'));
          const recent = candidates
            .filter(a => !(a.fm.tags || []).includes('foundational'))
            .sort((a, b) => (b.fm.created || '').localeCompare(a.fm.created || ''));

          const pinnedBudget = Math.floor(knowledgeBudget * 0.4);
          const recentBudget = knowledgeBudget - pinnedBudget;

          const parts = [];
          emitArtifacts(pinned, pinnedBudget,
            a => `[${a.fm.type || 'artifact'}] ${a.fm.title || a.basename}\n`,
            parts);
          emitArtifacts(recent, recentBudget,
            a => {
              const date = a.fm.created ? ` (${a.fm.created.slice(0, 10)})` : '';
              return `[${a.fm.type || 'artifact'}] ${a.fm.title || a.basename}${date}\n`;
            },
            parts);

          if (parts.length > 0) {
            emit('Compiled Knowledge', parts.join('\n'));
          }
        }
      }
    } catch {
      // skip on unexpected errors
    }
  }

  // -------------------------------------------------------
  // 5. Storage drift (priority 2.8, budget 500 — silent when clean)
  // -------------------------------------------------------
  if (totalChars < HARD_CAP) {
    try {
      const hits = findStorageDrift(AGENT_DIR);
      if (hits.length > 0) {
        const lines = hits.slice(0, 5).map(h => `- ${h}`).join('\n');
        const suffix = hits.length > 5 ? `\n(${hits.length - 5} more)` : '';
        const body = `${hits.length} path${hits.length !== 1 ? 's' : ''} invisible to session injection and archival:\n${lines}${suffix}\nMove files into .claude-code-hermit/raw/ or compiled/ (flat). See docs/plugin-hermit-storage.md.`;
        emit('Storage Drift', body.slice(0, BUDGETS.storageDrift));
      }
    } catch {}
  }

  // -------------------------------------------------------
  // 6. Session cost (priority 3, budget 500) — was 5
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
  // 7. Last report (priority 4, budget 1500)
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
  // 8. Upgrade check (priority 5, budget 500)
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
