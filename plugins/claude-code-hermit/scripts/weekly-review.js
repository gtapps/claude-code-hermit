#!/usr/bin/env node
// weekly-review.js — generates a weekly review report
// Zero npm dependencies. Node stdlib only.
// Usage: node weekly-review.js <hermit-state-dir>
//   hermit-state-dir: path to .claude-code-hermit/ in the target project (default: .claude-code-hermit)

'use strict';

const fs = require('fs');
const path = require('path');
const { readFrontmatter, readFileWithFrontmatter, parseFrontmatter, isEmptyAutoArchive, newestByType, globDir } = require('./lib/frontmatter');
const { costLogPath } = require('./lib/cc-compat');
const { lint: knowledgeLint } = require('./knowledge-lint');

// --- Args ---
const hermitDir = process.argv[2] || '.claude-code-hermit';

// --- ISO week calculation ---

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

function isoWeekKey(date) {
  const { year, week } = getISOWeek(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function weekDateRange(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const fmt = d => `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `${fmt(monday)}–${fmt(sunday)}, ${year}`;
}

function isSelfDirected(s) {
  if (s.fm.operator_turns !== undefined && s.fm.operator_turns !== null) {
    return parseInt(s.fm.operator_turns, 10) === 0;
  }
  return s.fm.escalation === 'autonomous';
}

// --- Determine current week ---
const now = new Date();
const { year: currentYear, week: currentWeek } = getISOWeek(now);
const weekKey = isoWeekKey(now);

// Week boundaries (Mon 00:00 UTC → Sun 23:59 UTC)
const jan4 = new Date(Date.UTC(currentYear, 0, 4));
const jan4Day = jan4.getUTCDay() || 7;
const weekStart = new Date(jan4);
weekStart.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (currentWeek - 1) * 7);
const weekEnd = new Date(weekStart);
weekEnd.setUTCDate(weekStart.getUTCDate() + 7); // exclusive

// --- Load sessions (pre-compute parsed dates) ---
const sessionsDir = path.join(hermitDir, 'sessions');
const sessionFiles = globDir(sessionsDir, /^S-\d+-REPORT\.md$/);
const allSessions = sessionFiles
  .map(f => { const r = readFileWithFrontmatter(f); return { file: f, fm: r && r.fm, content: r ? r.content : '' }; })
  .filter(s => s.fm && s.fm.id && s.fm.date)
  .map(s => ({ ...s, parsedDate: new Date(s.fm.date) }));

const weekSessions = allSessions.filter(s => s.parsedDate >= weekStart && s.parsedDate < weekEnd);

// --- Load proposals ---
const proposalsDir = path.join(hermitDir, 'proposals');
const proposalFiles = globDir(proposalsDir, /^PROP-\d+(?:-.+)?\.md$/);
const allProposals = proposalFiles
  .map(f => ({ file: f, fm: readFrontmatter(f) }))
  .filter(p => p.fm && p.fm.id);

const weekCreated = allProposals.filter(p => {
  if (!p.fm.created) return false;
  const d = new Date(p.fm.created);
  return d >= weekStart && d < weekEnd;
});

const weekAccepted = allProposals.filter(p => {
  if (!p.fm.accepted_date) return false;
  const d = new Date(p.fm.accepted_date);
  return d >= weekStart && d < weekEnd;
});

const weekResolved = allProposals.filter(p => {
  if (p.fm.status !== 'resolved' || !p.fm.resolved_date) return false;
  const d = new Date(p.fm.resolved_date);
  return d >= weekStart && d < weekEnd;
});

// --- Metrics ---
const sessionsCount = weekSessions.length;
const totalCost = weekSessions.reduce((sum, s) => sum + parseFloat(s.fm.cost_usd || 0), 0);
const avgCost = sessionsCount > 0 ? totalCost / sessionsCount : 0;

const { formatTokens } = require('./lib/format');

// Token aggregation: prefer session frontmatter; fall back to cost-log.jsonl date-range scan
const allHaveTokens = sessionsCount > 0 &&
  weekSessions.every(s => Number.isFinite(s.fm.tokens) && s.fm.tokens >= 0);
let totalTokens = 0;
if (allHaveTokens) {
  totalTokens = weekSessions.reduce((sum, s) => sum + s.fm.tokens, 0);
} else {
  const costLogPath = path.resolve(process.cwd(), '.claude/cost-log.jsonl');
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);
  try {
    const lines = fs.readFileSync(costLogPath, 'utf-8').trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const d = (e.timestamp || '').slice(0, 10);
        if (d >= weekStartStr && d < weekEndStr) totalTokens += e.total_tokens || 0;
      } catch {}
    }
  } catch {}
}
const avgTokens = sessionsCount > 0 ? Math.round(totalTokens / sessionsCount) : 0;

// Exclude empty auto-archives from the autonomy calc: they have no content to
// attribute either way and would inflate the self-directed numerator via the
// operator_turns === 0 branch of isSelfDirected. See isEmptyAutoArchive in
// lib/frontmatter.js for the shared predicate (also used by reflect-precheck).
const contentfulSessions = weekSessions.filter(s => !isEmptyAutoArchive(s.fm));
const selfDirectedCount = contentfulSessions.filter(isSelfDirected).length;
const assistedSessions = contentfulSessions.filter(s => !isSelfDirected(s));
const autonomousRate = contentfulSessions.length > 0 ? selfDirectedCount / contentfulSessions.length : 0;

// --- Operator dependence ---
const assistedTags = {};
for (const s of assistedSessions) {
  for (const tag of (s.fm.tags || [])) {
    assistedTags[tag] = (assistedTags[tag] || 0) + 1;
  }
}
const topAssistedTags = Object.entries(assistedTags)
  .sort(([, a], [, b]) => b - a)
  .slice(0, 3)
  .map(([tag, count]) => `${tag} (${count})`);

// --- Honesty rule: pre-build tag counts for O(1) lookup ---
const totalSessionCount = allSessions.length;
const IMPACT_THRESHOLD = 0.3;
const tagCounts = new Map();
for (const s of allSessions) {
  for (const tag of (s.fm.tags || [])) {
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }
}

function canShowTagImpact(tag) {
  if (totalSessionCount === 0) return false;
  return (tagCounts.get(tag) || 0) / totalSessionCount < IMPACT_THRESHOLD;
}

// --- Recently resolved: show numeric impact only when honesty rule passes ---
function countIncompleteSessions(propTags, datePredicate) {
  return allSessions.filter(s =>
    datePredicate(s.parsedDate) &&
    (s.fm.status === 'blocked' || s.fm.status === 'partial') &&
    propTags.some(t => (s.fm.tags || []).includes(t))
  ).length;
}

const resolvedWithImpact = weekResolved.map(p => {
  const propTags = p.fm.tags || [];
  const resolvedDate = new Date(p.fm.resolved_date);
  const preCount = countIncompleteSessions(propTags, d => d < resolvedDate);
  const postCount = countIncompleteSessions(propTags, d => d >= resolvedDate);
  const showImpact = propTags.some(t => canShowTagImpact(t));
  return { p, preCount, postCount, showImpact };
});

// --- Open loops (proposals proposed for a long time without response) ---
const openLoops = allProposals
  .filter(p => p.fm.status === 'proposed' && p.fm.created)
  .map(p => {
    const created = new Date(p.fm.created);
    const sessionsSince = allSessions.filter(s => s.parsedDate > created).length;
    return { p, sessionsSince };
  })
  .filter(o => o.sessionsSince >= 5)
  .sort((a, b) => (a.p.fm.created || '').localeCompare(b.p.fm.created || ''));

// --- Reflect vital-signs ---
// Week-scoped on purpose: reflection-state.json counters are cumulative since
// hatch, so weekly numbers come from the week's session-report Progress Log
// lines (runs, candidates, suppressions) and proposal-metrics.jsonl events
// (surfaced, accepted). All reads fail open to zeros.
const REFLECT_LINE_RE = /reflect \((?:newborn|juvenile|adult|quick[^)]*)\) — (\d+) candidates?; verdicts: accept=\d+ downgrade=\d+ suppress=\d+/;
let reflectRuns = 0;
let reflectCandidates = 0;
const reflectSuppressed = new Set();
for (const s of weekSessions) {
  for (const line of (s.content || '').split('\n')) {
    const m = line.match(REFLECT_LINE_RE);
    if (!m) continue;
    reflectRuns++;
    reflectCandidates += parseInt(m[1], 10);
    const sup = line.match(/suppressed: \[([^\]]*)\]/);
    if (!sup) continue;
    for (const entry of sup[1].split(',')) {
      const t = entry.trim();
      if (t && !t.startsWith('+')) reflectSuppressed.add(t.replace(/:\s+/, ':'));
    }
  }
}

let reflectSurfaced = 0;
let reflectAccepted = 0;
try {
  const lines = fs.readFileSync(path.join(hermitDir, 'state', 'proposal-metrics.jsonl'), 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const d = new Date(e.ts);
      if (!(d >= weekStart && d < weekEnd)) continue;
      if (e.type === 'micro-queued' || e.type === 'created') reflectSurfaced++;
      if ((e.type === 'responded' && e.action === 'accept') ||
          (e.type === 'micro-resolved' && e.action === 'approved')) reflectAccepted++;
    } catch {}
  }
} catch {}

// Approximation: only reflect runs attributed as routine cost-log sources are
// counted; quick-mode reflect_after runs inside other sessions are not.
let reflectCost = 0;
try {
  const lines = fs.readFileSync(costLogPath(hermitDir), 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!(e.source || '').startsWith('routine:reflect')) continue;
      const d = new Date(e.timestamp);
      if (d >= weekStart && d < weekEnd) reflectCost += e.estimated_cost_usd || 0;
    } catch {}
  }
} catch {}

// --- Build report ---

const frontmatter = [
  '---',
  'type: review',
  `title: "Weekly Review: ${weekKey}"`,
  `created: ${now.toISOString()}`,
  'tags: [weekly, review]',
  'generated: true',
  `week: ${weekKey}`,
  `sessions_count: ${sessionsCount}`,
  `proposals_created: ${weekCreated.length}`,
  `proposals_accepted: ${weekAccepted.length}`,
  `proposals_resolved: ${weekResolved.length}`,
  `total_cost_usd: ${totalCost.toFixed(2)}`,
  `total_tokens: ${totalTokens}`,
  `avg_session_cost_usd: ${avgCost.toFixed(2)}`,
  `avg_session_tokens: ${avgTokens}`,
  `self_directed_rate: ${autonomousRate.toFixed(2)}`,
  `reflect_runs: ${reflectRuns}`,
  `reflect_candidates: ${reflectCandidates}`,
  `reflect_surfaced: ${reflectSurfaced}`,
  `reflect_accepted: ${reflectAccepted}`,
  `reflect_cost_usd: ${reflectCost.toFixed(2)}`,
  '---',
].join('\n');

const dateRange = weekDateRange(currentYear, currentWeek);

let body = `## Week of ${dateRange}\n\n`;

// Sessions
if (sessionsCount > 0) {
  body += `### Sessions\n`;
  body += `${sessionsCount} session${sessionsCount !== 1 ? 's' : ''}, $${totalCost.toFixed(2)} (${formatTokens(totalTokens)}) total ($${avgCost.toFixed(2)} avg).\n`;
  body += `${selfDirectedCount} self-directed (operator_turns = 0), ${assistedSessions.length} operator-assisted.\n\n`;
} else {
  body += `### Sessions\nNo sessions this week.\n\n`;
}

// Proposals
if (weekCreated.length > 0 || weekAccepted.length > 0 || weekResolved.length > 0) {
  body += `### Proposals\n`;
  if (weekCreated.length > 0) {
    body += `${weekCreated.length} created: ${weekCreated.map(p => p.fm.id).join(', ')}.\n`;
  }
  if (weekAccepted.length > 0) {
    body += `${weekAccepted.length} accepted: ${weekAccepted.map(p => p.fm.id).join(', ')}.\n`;
  }
  if (weekResolved.length > 0) {
    body += `${weekResolved.length} resolved: ${weekResolved.map(p => p.fm.id).join(', ')}.\n`;
  }
  body += '\n';
}

// Recently resolved with impact
if (resolvedWithImpact.length > 0) {
  body += `### Recently Resolved\n`;
  for (const { p, preCount, postCount, showImpact } of resolvedWithImpact) {
    const title = p.fm.title || p.fm.id;
    if (showImpact && preCount > 0) {
      body += `- ${p.fm.id}: ${title} — ${preCount} incomplete session${preCount !== 1 ? 's' : ''} pre-resolution, ${postCount} post.\n`;
    } else {
      body += `- ${p.fm.id}: ${title} — observed trend.\n`;
    }
  }
  body += '\n';
}

// Operator dependence
if (assistedSessions.length > 0) {
  body += `### Operator Dependence\n`;
  body += `operator_turns > 0: ${assistedSessions.length} of ${sessionsCount} sessions (${Math.round((1 - autonomousRate) * 100)}%).\n`;
  if (topAssistedTags.length > 0) {
    body += `Tags on assisted sessions: ${topAssistedTags.join(', ')}.\n`;
  }
  body += '\n';
}

// Open loops
if (openLoops.length > 0) {
  body += `### Open Loops\n`;
  for (const { p, sessionsSince } of openLoops) {
    body += `- ${p.fm.id}: ${p.fm.title || 'untitled'} — proposed ${sessionsSince} sessions ago, no action taken.\n`;
  }
  body += '\n';
}

// Reflect vital-signs — makes healthy-quiet distinguishable from dead: a week
// of runs with zero surfaced/accepted while cost accumulates is the loop
// telling the operator to prune it.
if (reflectRuns > 0) {
  body += `### Reflect\n`;
  let line = `reflect: ${reflectRuns} run${reflectRuns !== 1 ? 's' : ''}, ${reflectCandidates} candidates, ${reflectSurfaced} surfaced, ${reflectAccepted} accepted, ~$${reflectCost.toFixed(2)}`;
  if (reflectSuppressed.size > 0) {
    const list = [...reflectSuppressed];
    const more = list.length > 5 ? `, +${list.length - 5} more` : '';
    line += `; suppressed: ${list.slice(0, 5).join(', ')}${more}`;
  }
  body += `${line}.\n\n`;
}

// --- Knowledge Health (via shared knowledge-lint.js) ---
let knowledgeSection = '';
try {
  const { findings } = knowledgeLint(hermitDir);
  if (findings.length > 0) {
    knowledgeSection = `### Knowledge Health\n`;
    for (const f of findings) {
      knowledgeSection += `- ${f.file} [${f.age}] — ${f.reason}\n`;
    }
    knowledgeSection += '\n';
  }
} catch {}

if (knowledgeSection) body += knowledgeSection;

const report = `${frontmatter}\n${body}`;

// --- Write review file ---
const compiledDir = path.join(hermitDir, 'compiled');
fs.mkdirSync(compiledDir, { recursive: true });

const reviewPath = path.join(compiledDir, `review-weekly-${weekKey}.md`);
fs.writeFileSync(reviewPath, report, 'utf8');
console.log(`Weekly review written: ${reviewPath}`);
