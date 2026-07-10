// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// startup-context.ts — SessionStart hook
// Replaces the inline bash blob with a capped, priority-ordered context injection.
// Emits only startup-relevant SHELL.md sections with per-section budgets.
// Hard cap: 9000 chars total (~2250 tokens).

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readFrontmatter, readFileWithFrontmatter, globDir } from './lib/frontmatter';
import { hermitDir } from './lib/cc-compat';
import { findStorageDrift, findSchemaDrift } from './lib/drift';
import { safe, safeForLLMMultiline, scanInjected } from './lib/sanitize';
import { resolve as resolveOutboundChannel } from './resolve-outbound-channel';
import { formatTokens } from './lib/format';

type Json = any;

const AGENT_DIR = hermitDir();
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
const HARD_CAP = 9000;

// Section budgets (chars). Higher priority sections emit first.
// If a section exceeds its budget, it is truncated with [...truncated].
// Lower-priority sections are dropped entirely once HARD_CAP is reached.
const BUDGETS = {
  operator:      2000,
  session:       3000,
  pointers:       800, // compaction pointers — only emitted when source === "compact"
  knowledge:     2500, // compiled/ artifacts — read from config, 2500 default
  schemaDrift:    400, // only emitted when compiled/ types are undeclared in knowledge-schema.md
  storageDrift:   500, // only emitted when misplaced files are found
  cost:           500,
  report:        1500,
  upgrade:        500,
};

// Injection-time content guard: defuse context-marker tags in everything we
// emit; replace an entry outright when a threat marker matches. The file on
// disk is never touched — hits are recorded for the doctor context-scan check.
const scanHits: { source: string; reason: string }[] = [];

// Scans `text`, records a hit against `source` when a marker fires, and
// returns the reason (or null when clean).
function checkThreat(source: string, text: string): string | null {
  const reason = scanInjected(text);
  if (reason) scanHits.push({ source, reason });
  return reason;
}

function guarded(source: string, text: string): string {
  const reason = checkThreat(source, text);
  return reason ? `[BLOCKED: ${reason}]` : safeForLLMMultiline(text);
}

// Emit artifact entries for a list, tracking chars used against a budget.
// headerFn(artifact) → string used as the section header per entry.
// Pinned and recent budgets are intentionally isolated — unused pinned budget
// does not roll over to recent, and vice versa.
function emitArtifacts(artifacts: Json[], budget: number, headerFn: (a: Json) => string, parts: string[]): void {
  let used = 0;
  for (const a of artifacts) {
    const header = headerFn(a);
    const available = budget - used - header.length;
    if (available <= 0) break;
    const stubRaw = typeof a.fm.injection_stub === 'string' ? a.fm.injection_stub : '';
    const stub = stubRaw.trim();
    let entry: string;
    if (stub) {
      if (stubRaw.length > available) continue; // too long for remaining budget — skip rather than garble
      entry = header + guarded(`compiled/${a.basename}.md`, stubRaw);
    } else {
      const body = a.body || '';
      const snippet = body.slice(0, available);
      const blockReason = checkThreat(`compiled/${a.basename}.md`, snippet);
      const content = blockReason ? `[BLOCKED: ${blockReason}]` : safeForLLMMultiline(snippet);
      entry = header + content
        + (blockReason ? '' : (snippet.length < body.length ? '\n[...]\n' : ''));
    }
    parts.push(entry);
    used += entry.length;
  }
}

// Extract a named ## Section from markdown content.
// Returns the section body (without the header line), or null if not found.
function extractSection(md: string, name: string): string | null {
  const idx = md.indexOf(`## ${name}`);
  if (idx === -1) return null;
  const bodyStart = md.indexOf('\n', idx) + 1;
  const nextSection = md.indexOf('\n## ', bodyStart);
  return nextSection !== -1 ? md.slice(bodyStart, nextSection) : md.slice(bodyStart);
}

// Return last N non-empty lines from a string.
function lastLines(text: string, n: number): string {
  const lines = text.split('\n').filter(l => l.trim());
  return lines.slice(-n).join('\n');
}

// Build the post-compaction pointer block: the state that native/driver-sent
// compaction drops and startup-context's other sections don't already cover
// (Active Session re-injects SHELL.md's Task/Progress/Blockers, but not
// runtime.json's session_state/waiting_reason, pending micro-approvals, or
// outbound channel routing). Fail-open per-field — one missing/malformed
// state file must not blank the rest. Returns "" if nothing is available.
function buildCompactionPointers(agentDir: string): string {
  const parts: string[] = [];

  try {
    const runtime = JSON.parse(fs.readFileSync(path.resolve(agentDir, 'state', 'runtime.json'), 'utf-8'));
    const sessionState = typeof runtime.session_state === 'string' ? runtime.session_state : null;
    const waitingReason = typeof runtime.waiting_reason === 'string' ? runtime.waiting_reason : null;
    if (sessionState) {
      parts.push(`session_state: ${safe(sessionState)}` + (waitingReason ? ` (waiting_reason: ${safe(waitingReason)})` : ''));
    }
  } catch {}

  try {
    const shellContent = fs.readFileSync(path.resolve(agentDir, 'sessions', 'SHELL.md'), 'utf-8');
    const task = extractSection(shellContent, 'Task');
    const firstLine = task
      ? task.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('<!--'))
      : null;
    if (firstLine) parts.push(`task: ${safe(firstLine).slice(0, 300)}`);
  } catch {}

  try {
    const mp = JSON.parse(fs.readFileSync(path.resolve(agentDir, 'state', 'micro-proposals.json'), 'utf-8'));
    const pending = (Array.isArray(mp.pending) ? mp.pending : []).filter((p: Json) => p && p.status === 'pending');
    if (pending.length > 0) {
      const ids = pending.slice(0, 10).map((p: Json) => safe(p.id ?? '?'));
      const overflow = pending.length > ids.length ? ` (+${pending.length - ids.length} more)` : '';
      parts.push(`pending micro-proposals: ${ids.join(', ')}${overflow}`);
    }
  } catch {}

  try {
    const config = JSON.parse(fs.readFileSync(path.resolve(agentDir, 'config.json'), 'utf-8'));
    const route = resolveOutboundChannel(config.channels);
    if (route) parts.push(`outbound channel: ${safe(route.id)} (chat_id: ${safe(route.chat_id)})`);
  } catch {}

  if (parts.length === 0) return '';

  parts.push('Full state: SHELL.md + runtime.json. Task list: native Tasks. Don\'t re-read large files to reconstruct context.');
  return parts.join('\n');
}

function main(source: string | null) {
  let totalChars = 0;

  function emit(label: string, content: string): void {
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
      emit('Session Context', guarded('OPERATOR.md', lines.slice(0, BUDGETS.operator)));
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
  let shellContent: string | null = null;
  try {
    shellContent = fs.readFileSync(shellPath, 'utf-8');
  } catch {}

  if (shellContent === null) {
    emit('Active Session', 'No active session');
  } else {
    const parts: string[] = [];

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
      emit('Active Session', guarded('sessions/SHELL.md', sessionOutput.slice(0, BUDGETS.session)));
    } else {
      emit('Active Session', 'Session file exists but has no actionable content');
    }
  }

  // -------------------------------------------------------
  // 3b. Compaction pointers (priority 2.2, budget 800) — only on source === "compact"
  // -------------------------------------------------------
  if (source === 'compact' && totalChars < HARD_CAP) {
    try {
      const pointers = buildCompactionPointers(AGENT_DIR);
      if (pointers) emit('Compaction Pointers', pointers.slice(0, BUDGETS.pointers));
    } catch {
      // Non-fatal — never let pointer injection block ordinary startup context
    }
  }

  // -------------------------------------------------------
  // 4. Compiled knowledge (priority 2.5, budget from config — default 2500)
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

      // Clamp to remaining headroom so a maxed compiled budget doesn't crowd lower-priority
      // sections (cost, report, upgrade). Operator and session emit first and are already safe.
      knowledgeBudget = Math.min(knowledgeBudget, HARD_CAP - totalChars);

      const compiledDir = path.resolve(AGENT_DIR, 'compiled');
      const compiledFiles = globDir(compiledDir, /^[^.].*\.md$/);

      if (compiledFiles.length > 0) {
        // Single read per file: frontmatter + body in one pass
        const artifacts: Json[] = compiledFiles
          .map(f => {
            const r = readFileWithFrontmatter(f);
            return r && r.fm && r.fm.created
              ? { file: f, fm: r.fm, body: r.body, basename: path.basename(f, '.md') }
              : null;
          })
          .filter(Boolean);

        if (artifacts.length > 0) {
          const dateOf = (a: Json) =>
            (typeof a.fm.updated === 'string' && a.fm.updated) || a.fm.created || '';

          // All foundational artifacts pin full bodies (no per-type collapse — multiple
          // foundational topic pages must co-pin). Everything else gets a catalog line.
          // procedure-briefs are transient audit records, declared not-session-injected
          // in the schema — excluded from the catalog.
          const pinned = artifacts
            .filter(a => (a.fm.tags || []).includes('foundational'))
            .sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
          const rest = artifacts
            .filter(a => !(a.fm.tags || []).includes('foundational')
              && a.fm.type !== 'procedure-brief')
            .sort((a, b) => dateOf(b).localeCompare(dateOf(a)));

          const pinnedBudget = Math.floor(knowledgeBudget * 0.4);

          const parts: string[] = [];
          emitArtifacts(pinned, pinnedBudget,
            a => `[${a.fm.type || 'artifact'}] ${a.fm.title || a.basename}\n`,
            parts);

          // Unused pinned budget rolls into the catalog — with few or no foundational
          // pages, the 40% reservation would otherwise be dead weight.
          const pinnedUsed = parts.reduce((s, p) => s + p.length, 0);
          const catalogBudget = knowledgeBudget - Math.min(pinnedBudget, pinnedUsed);

          // Catalog: pointers, not bodies — depth on demand via /recall or Read.
          if (rest.length > 0) {
            const intro = 'Catalog — Read compiled/<file>.md for full content:';
            const catLines: string[] = [];
            let used = intro.length + 1;
            for (const a of rest) {
              const date = dateOf(a).slice(0, 10);
              const tags = (Array.isArray(a.fm.tags) ? a.fm.tags : [])
                .map((t: string) => `#${t}`).join(' ');
              const summary = typeof a.fm.summary === 'string' && a.fm.summary.trim()
                ? a.fm.summary.trim()
                : (typeof a.fm.title === 'string' ? a.fm.title : '');
              let entry = `- ${a.basename} [${a.fm.type || 'artifact'}]`
                + (date ? ` (${date})` : '') + (tags ? ` ${tags}` : '');
              if (summary) entry += `\n  ${summary.slice(0, 100)}`;
              const blockReason = checkThreat(`compiled/${a.basename}.md`, entry);
              entry = blockReason
                ? `- ${a.basename} [BLOCKED: ${blockReason}]`
                : safeForLLMMultiline(entry);
              if (used + entry.length + 1 > catalogBudget) break;
              catLines.push(entry);
              used += entry.length + 1;
            }
            if (catLines.length > 0) {
              if (catLines.length < rest.length) catLines.push(`(+${rest.length - catLines.length} more)`);
              parts.push([intro, ...catLines].join('\n'));
            }
          }

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
        const body = `${hits.length} path${hits.length !== 1 ? 's' : ''} invisible to session injection and archival:\n${lines}${suffix}\nMove files into .claude-code-hermit/raw/ or compiled/ (flat).`;
        emit('Storage Drift', body.slice(0, BUDGETS.storageDrift));
      }
    } catch {}
  }

  // -------------------------------------------------------
  // 5b. Schema drift (priority 2.9, budget 400 — silent when clean or no schema)
  // -------------------------------------------------------
  if (totalChars < HARD_CAP) {
    try {
      const drifts = findSchemaDrift(AGENT_DIR);
      if (drifts.length > 0) {
        const lines = drifts.map(({ type, example }) => `- \`${type}\` (e.g. compiled/${example})`).join('\n');
        const body = `${drifts.length} undeclared type${drifts.length !== 1 ? 's' : ''} in compiled/ — add to knowledge-schema.md ## Work Products:\n${lines}`;
        emit('Schema Drift', body.slice(0, BUDGETS.schemaDrift));
      }
    } catch {}
  }

  // -------------------------------------------------------
  // 6. Session cost (priority 3, budget 500) — was 5
  // -------------------------------------------------------
  try {
    const statusPath = path.resolve(AGENT_DIR, 'sessions', '.status.json');
    let out = 'No cost data';
    try {
      const d = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      out = `$${d.cost_usd.toFixed(4)} (${formatTokens(d.tokens)})`;
    } catch {
      // missing/malformed status — keep the placeholder, same as read-cost.py did
    }
    emit('Session Cost', out.slice(0, BUDGETS.cost));
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

        emit('Last Report', guarded(`sessions/${reports[0]}`, reportExcerpt.slice(0, BUDGETS.report)));
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

  // -------------------------------------------------------
  // 9. Persist scan record (always — empty hits clear a prior warning)
  // -------------------------------------------------------
  try {
    const stateDir = path.resolve(AGENT_DIR, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const scanPath = path.join(stateDir, 'context-scan.json');
    const tmp = scanPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ts: new Date().toISOString(), hits: scanHits }, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, scanPath);
  } catch {}
}

if (import.meta.main) {
  // main() must run exactly once. It runs when stdin reaches EOF (the normal hook
  // path, carrying the `source` field) — but if stdin never closes (TTY, unpiped
  // invocation, a held-open pipe), a short fallback still emits the source-less
  // startup context rather than silently injecting nothing at all.
  let ran = false;
  const runOnce = (source: string | null): void => {
    if (ran) return;
    ran = true;
    try { main(source); } catch { /* fail-open */ }
  };
  try {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('error', () => {});
    const fallback = setTimeout(() => runOnce(null), 2000);
    process.stdin.on('end', () => {
      clearTimeout(fallback); // normal path — no need to wait out the fallback
      let source: string | null = null;
      try {
        const payload = JSON.parse(buf);
        if (payload && typeof payload.source === 'string') source = payload.source;
      } catch { /* empty/non-JSON stdin — treat as unknown source */ }
      runOnce(source);
    });
  } catch {
    runOnce(null);
  }
}
