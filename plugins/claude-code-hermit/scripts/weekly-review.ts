#!/usr/bin/env bun
// weekly-review.ts — generates a weekly review report
// Zero npm dependencies. Node stdlib only.
// Usage: bun weekly-review.ts <hermit-state-dir>
//   hermit-state-dir: path to .claude-code-hermit/ in the target project (default: .claude-code-hermit)

import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter, readFileWithFrontmatter, parseFrontmatter, isEmptyAutoArchive, newestByType, globDir } from './lib/frontmatter';
import { costLogPath } from './lib/cc-compat';
import { formatTokens } from './lib/format';
import { lint as knowledgeLint } from './knowledge-lint';

type Json = any;

// --- Args ---
const hermitDir = process.argv[2] || '.claude-code-hermit';

// --- ISO week calculation ---

function getISOWeek(date: Date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

function isoWeekKey(date: Date) {
  const { year, week } = getISOWeek(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function weekDateRange(year: number, week: number) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const fmt = (d: Date) => `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `${fmt(monday)}–${fmt(sunday)}, ${year}`;
}

function isSelfDirected(s: Json) {
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

// --- Deliverables (## Artifacts bullets from this week's session reports) ---
// Reuses the session content already read above — no extra file reads. Mirrors
// the `- [[compiled/<type>-<slug>-<date>]] — annotation` format that
// scripts/session-archive.ts writes on session close.
const ARTIFACT_BULLET_RE = /^-\s*\[\[([^\]]+)\]\]\s*(?:—\s*(.*))?$/;
function extractArtifacts(content: string): string[] {
  const lines = (content || '').split('\n');
  const startIdx = lines.findIndex(l => l.trim() === '## Artifacts');
  if (startIdx === -1) return [];
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    const m = line.match(ARTIFACT_BULLET_RE);
    if (!m) continue;
    const annotation = (m[2] || '').trim();
    out.push(annotation || m[1].replace(/^compiled\//, ''));
  }
  return out;
}
const delivered = weekSessions.flatMap(s => extractArtifacts(s.content));

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
// lib/frontmatter.ts for the shared predicate (also used by reflect-precheck).
const contentfulSessions = weekSessions.filter(s => !isEmptyAutoArchive(s.fm));
const selfDirectedCount = contentfulSessions.filter(isSelfDirected).length;
const assistedSessions = contentfulSessions.filter(s => !isSelfDirected(s));
const autonomousRate = contentfulSessions.length > 0 ? selfDirectedCount / contentfulSessions.length : 0;

// --- Operator dependence ---
const assistedTags: Record<string, number> = {};
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
const tagCounts = new Map<string, number>();
for (const s of allSessions) {
  for (const tag of (s.fm.tags || [])) {
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }
}

function canShowTagImpact(tag: string) {
  if (totalSessionCount === 0) return false;
  return (tagCounts.get(tag) || 0) / totalSessionCount < IMPACT_THRESHOLD;
}

// --- Recently resolved: show numeric impact only when honesty rule passes ---
function countIncompleteSessions(propTags: string[], datePredicate: (d: Date) => boolean) {
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
  const showImpact = propTags.some((t: string) => canShowTagImpact(t));
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
// lines (runs, candidates, suppressions) and reflect-exclusive micro-proposal
// events in proposal-metrics.jsonl (surfaced, accepted). All reads fail open to zeros.
const REFLECT_LINE_RE = /reflect \((?:newborn|juvenile|adult|quick[^)]*)\) — (\d+) candidates?; verdicts: accept=\d+ downgrade=\d+ suppress=\d+/;
let reflectRuns = 0;
let reflectCandidates = 0;
const reflectSuppressed = new Set<string>();
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

// micro-queued / micro-resolved are reflect-exclusive event types: only the
// reflect loop queues micro-proposals, so approving one is approving reflect
// output regardless of which surface records the approval. `created`/`responded`
// are shared by capability-brainstorm, operator-request, and channel callers and
// carry no reflect-distinguishing field (the `source` enum value `auto-detected`
// is shared), so Tier-3 reflect proposals routing through them are deliberately
// excluded — undercount, never over-claim non-reflect activity as reflect's.
// Bridged asks (kind:"ask") ride the same micro-queued event for ID sequencing
// but are other skills' bounded asks, not reflect candidates — exclude them.
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
      if (e.type === 'micro-queued' && e.kind !== 'ask') reflectSurfaced++;
      if (e.type === 'micro-resolved' && e.action === 'approved') reflectAccepted++;
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

// observations.jsonl is the reflect ledger's kill signal: empty everywhere =
// graduation never fires.
let reflectObsTotal = 0;
let reflectObsWeek = 0;
try {
  const lines = fs.readFileSync(path.join(hermitDir, 'state', 'observations.jsonl'), 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    reflectObsTotal++;
    try {
      const e = JSON.parse(line);
      const d = new Date(e.ts);
      if (d >= weekStart && d < weekEnd) reflectObsWeek++;
    } catch {}
  }
} catch {}

// --- Usage (usage-metrics.jsonl → weekly-review suggestions) ---
// Suggest-only: never auto-archives. Coverage is inherently partial (startup
// injection, subagent reads, and skill invocations outside the tracked paths
// are invisible), so a young or missing ledger must never read as "unused".
const USAGE_STALE_DAYS = 60;
const usageStaleMs = USAGE_STALE_DAYS * 86400000;
const compiledDir = path.join(hermitDir, 'compiled');
const usageLedgerPath = path.join(hermitDir, 'state', 'usage-metrics.jsonl');

let ledgerStartMs: number | null = null;
const lastUsedMs = new Map<string, number>(); // key: `${kind}:${name}`
try {
  const usageLines = fs.readFileSync(usageLedgerPath, 'utf-8').split('\n');
  for (const line of usageLines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const tsMs = Date.parse(e.ts);
      if (!Number.isFinite(tsMs)) continue;
      if (ledgerStartMs === null || tsMs < ledgerStartMs) ledgerStartMs = tsMs;
      if ((e.kind === 'skill' || e.kind === 'compiled') && typeof e.name === 'string') {
        const key = `${e.kind}:${e.name}`;
        const prev = lastUsedMs.get(key);
        if (prev === undefined || tsMs > prev) lastUsedMs.set(key, tsMs);
      }
    } catch {}
  }
} catch {}

const untouchedDocs: { stem: string; lastRead: number | null; date: Date }[] = [];
const dormantSkills: { name: string; lastUsed: number }[] = [];

// Guard: a ledger younger than the staleness window (or missing entirely)
// would make every doc/skill look unused — say nothing rather than mislead.
if (ledgerStartMs !== null && (now.getTime() - ledgerStartMs) >= usageStaleMs) {
  const cutoffMs = now.getTime() - usageStaleMs;

  try {
    for (const docPath of globDir(compiledDir, /^[^.].*\.md$/)) {
      const fm = readFrontmatter(docPath);
      if (!fm || !fm.type) continue;
      // Same exemptions as archive-compiled.ts: foundational + topic pages are
      // living documents; also skip weekly-review's own generated output.
      if ((fm.tags || []).includes('foundational') || fm.type === 'topic' || fm.type === 'review' || fm.generated) continue;
      const dateStr = fm.updated || fm.created;
      if (!dateStr) continue;
      const date = new Date(dateStr);
      if (isNaN(date.getTime()) || (now.getTime() - date.getTime()) < usageStaleMs) continue;
      const stem = path.basename(docPath, '.md');
      const lastRead = lastUsedMs.get(`compiled:${stem}`) ?? null;
      if (lastRead !== null && lastRead >= cutoffMs) continue; // read recently — not stale
      untouchedDocs.push({ stem, lastRead, date });
    }
  } catch {}
  untouchedDocs.sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const [key, ts] of lastUsedMs) {
    if (!key.startsWith('skill:') || ts >= cutoffMs) continue;
    dormantSkills.push({ name: key.slice('skill:'.length), lastUsed: ts });
  }
  dormantSkills.sort((a, b) => a.lastUsed - b.lastUsed);
}

const usageUntouchedCount = untouchedDocs.length + dormantSkills.length;

let usageSection = '';
if (untouchedDocs.length > 0 || dormantSkills.length > 0) {
  const DOC_CAP = 10, SKILL_CAP = 10;
  usageSection = `### Usage (no tracked use ≥${USAGE_STALE_DAYS}d)\n`;
  for (const d of untouchedDocs.slice(0, DOC_CAP)) {
    const lastReadStr = d.lastRead !== null ? new Date(d.lastRead).toISOString().slice(0, 10) : 'never';
    usageSection += `- compiled/${d.stem}.md — last tracked read ${lastReadStr}, updated ${d.date.toISOString().slice(0, 10)}\n`;
  }
  if (untouchedDocs.length > DOC_CAP) usageSection += `- (+${untouchedDocs.length - DOC_CAP} more)\n`;
  for (const s of dormantSkills.slice(0, SKILL_CAP)) {
    usageSection += `- skill ${s.name} — last tracked use ${new Date(s.lastUsed).toISOString().slice(0, 10)}\n`;
  }
  if (dormantSkills.length > SKILL_CAP) usageSection += `- (+${dormantSkills.length - SKILL_CAP} more)\n`;
  usageSection += `Tracked sources only (skill-tool calls, operator slash commands, compiled/ Reads); startup injection and subagent reads are not tracked.\n\n`;
}

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
  // Commas neutralized — the shared frontmatter array parser (lib/frontmatter.ts)
  // naively splits on every comma with no quote-awareness, so a comma inside an
  // annotation would corrupt this into extra array entries. Quotes need no
  // escaping: the parser strips only the outer quote pair and never unescapes.
  `delivered_count: ${delivered.length}`,
  `delivered: [${delivered.map(d => `"${d.replace(/,/g, ';')}"`).join(', ')}]`,
  `proposals_created: ${weekCreated.length}`,
  `proposals_accepted: ${weekAccepted.length}`,
  `proposals_resolved: ${weekResolved.length}`,
  `open_loops_count: ${openLoops.length}`,
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
  `reflect_observations: ${reflectObsTotal}`,
  `usage_untouched_count: ${usageUntouchedCount}`,
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

// Delivered (durable compiled/ outputs produced this week, per session ## Artifacts)
if (delivered.length > 0) {
  body += `### Delivered\n`;
  for (const d of delivered) {
    body += `- ${d}\n`;
  }
  body += '\n';
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
if (reflectRuns > 0 || reflectObsTotal > 0) {
  body += `### Reflect\n`;
  let line = `reflect: ${reflectRuns} run${reflectRuns !== 1 ? 's' : ''}, ${reflectCandidates} candidates, ${reflectSurfaced} surfaced, ${reflectAccepted} accepted, ~$${reflectCost.toFixed(2)}`;
  line += `; obs: ${reflectObsTotal} ledger${reflectObsWeek > 0 ? ` (+${reflectObsWeek} this week)` : ''}`;
  if (reflectSuppressed.size > 0) {
    const list = [...reflectSuppressed];
    const more = list.length > 5 ? `, +${list.length - 5} more` : '';
    line += `; suppressed: ${list.slice(0, 5).join(', ')}${more}`;
  }
  body += `${line}.\n\n`;
}

// --- Knowledge Health (via shared knowledge-lint.ts) ---
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
if (usageSection) body += usageSection;

const report = `${frontmatter}\n${body}`;

// --- Write review file ---
fs.mkdirSync(compiledDir, { recursive: true });

const reviewPath = path.join(compiledDir, `review-weekly-${weekKey}.md`);
fs.writeFileSync(reviewPath, report, 'utf8');
console.log(`Weekly review written: ${reviewPath}`);

// --- Compact the usage ledger: keep events <180d, plus the single newest
// event per stale kind:name pair (preserves last-used forever), plus the
// ledger-start meta line. Same tmp+rename pattern as prune-observations.ts.
try {
  const USAGE_RETENTION_DAYS = 180;
  const cutoffMs = now.getTime() - USAGE_RETENTION_DAYS * 86400000;
  const rawLedger = fs.readFileSync(usageLedgerPath, 'utf-8');
  const ledgerLines = rawLedger.split('\n').filter(l => l.trim());

  let metaLine: string | null = null;
  const recent: string[] = [];
  const staleLatest = new Map<string, { ts: number; line: string }>();

  for (const line of ledgerLines) {
    let e: Json;
    try { e = JSON.parse(line); } catch { recent.push(line); continue; }
    if (e.kind === 'meta' && e.event === 'ledger-start') {
      if (!metaLine) metaLine = line;
      continue;
    }
    const tsMs = Date.parse(e.ts);
    if (!Number.isFinite(tsMs) || tsMs >= cutoffMs) { recent.push(line); continue; }
    const key = `${e.kind}:${e.name}`;
    const prev = staleLatest.get(key);
    if (!prev || tsMs > prev.ts) staleLatest.set(key, { ts: tsMs, line });
  }

  const kept = [
    ...(metaLine ? [metaLine] : []),
    ...[...staleLatest.values()].map(v => v.line),
    ...recent,
  ];

  if (kept.length < ledgerLines.length) {
    const tmp = usageLedgerPath + '.tmp';
    fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8');
    fs.renameSync(tmp, usageLedgerPath);
  }
} catch { /* fail-open — no ledger yet, or unreadable */ }
