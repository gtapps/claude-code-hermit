// Deterministic renderer for the Hermit Dashboard artifact — the render itself is
// script-authored, not model-authored, so a publish costs a render (pennies) instead
// of a generation (dollars). Reads only state already on disk (runtime.json,
// cost-index.json, alert-state.json, proposals-index.json + proposal bodies, latest
// compiled/review-weekly-*.md, state/last-brief.json, compiled/*.md) and produces one
// self-contained HTML fragment. Note last-brief.json's `text` field is itself
// model-composed (written by the brief skill) — the render step is deterministic given
// that state, but the state is not exclusively machine-generated. The Artifact tool
// wraps the fragment in the page shell — this file must not include
// <!DOCTYPE>/<html>/<head>/<body> (see https://code.claude.com/docs/en/artifacts,
// Page constraints).

import fs from 'node:fs';
import path from 'node:path';
import { readFileWithFrontmatter, globDir } from './frontmatter';
import { formatTokens } from './format';
import { sha256 } from './hash';
import { readMergedAlerts } from './alert-state';
import { todayYMD } from './time';
import { costIndexPath, readCostIndex } from './cost-log';
import { rebuildIndex, type ProposalsIndex } from '../proposals-index';
import { loadStrings, fmt, type ArtifactStrings } from './artifact-strings';

type Json = any;

const OPEN_STATUSES = new Set(['proposed', 'accepted']);
const OTHER_CAP = 20;
const UPDATED_TOKEN = '__DASHBOARD_UPDATED__';

export interface AlertRow {
  key: string;
  message: string;
  timestamp: string | null;
}

export interface ProposalRow {
  id: string;
  title: string;
  status: string;
  created: string | null;
  ageDays: number | null;
}

export interface OpenProposalRow extends ProposalRow {
  body: string;
}

export interface OldestAccepted {
  id: string;
  title: string;
  ageDays: number | null;
}

export interface WeeklyState {
  week: string;
  costUsd: number | null;
  autonomyPct: number | null;
  createdCount: number | null;
  resolvedCount: number | null;
  priorCostUsd: number | null;
  priorAutonomyPct: number | null;
  hasPrior: boolean;
  bodyHtml: string;
}

export interface LastBriefState {
  kind: string;
  text: string;
  generatedAt: string | null;
}

export interface CompiledDocRow {
  name: string;
  title: string;
}

export interface DashboardState {
  agentName: string;
  sessionState: string | null;
  todayCostUsd: number;
  todayTokens: number;
  alerts: AlertRow[];
  proposals: {
    open: OpenProposalRow[];
    other: ProposalRow[];
    otherOmitted: number;
    oldestOpenAccepted: OldestAccepted | null;
  };
  weekly: WeeklyState | null;
  lastBrief: LastBriefState | null;
  compiledIndex: { docs: CompiledDocRow[]; omitted: number };
  strings: ArtifactStrings;
}

// ---------- loading ----------

function readJsonSafe(p: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// "Today" = the timezone-aware daily bucket in cost-index.json (sums every session
// that ran today), not .status.json's current-session running total.
function loadTodayCost(hermitDir: string, timezone: string): { costUsd: number; tokens: number } {
  const index = readCostIndex(costIndexPath(hermitDir));
  const entry = index?.by_date?.[todayYMD(timezone)];
  return {
    costUsd: typeof entry?.cost === 'number' ? entry.cost : 0,
    tokens: typeof entry?.tokens === 'number' ? entry.tokens : 0,
  };
}

function ageDaysFrom(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

export function loadProposals(hermitDir: string): DashboardState['proposals'] {
  // Always rebuild: rebuildIndex() is a cheap frontmatter read (no LLM/token cost) and
  // this self-heals any out-of-band drift (e.g. a Bash `mv` rename) that the
  // write-event-gated generate-summary hook never sees. It already reads each open
  // proposal's full body while parsing frontmatter — capture it via bodyOut instead of
  // re-reading every open proposal's file a second time below.
  const bodies = new Map<string, string>();
  const index: ProposalsIndex | null = rebuildIndex(hermitDir, bodies);
  if (!index || !Array.isArray(index.proposals)) {
    return { open: [], other: [], otherOmitted: 0, oldestOpenAccepted: null };
  }

  const open: OpenProposalRow[] = [];
  const other: ProposalRow[] = [];
  let oldestOpenAccepted: OldestAccepted | null = null;

  for (const row of index.proposals) {
    const status = row.status ?? 'unknown';
    const base: ProposalRow = {
      id: row.id,
      title: row.title ?? 'untitled',
      status,
      created: row.created,
      ageDays: ageDaysFrom(row.created),
    };

    if (status === 'accepted') {
      // Age since acceptance (the "since accepted" label), not since creation.
      const acceptedAge = ageDaysFrom(row.accepted_date ?? row.created);
      if (!oldestOpenAccepted || (acceptedAge ?? -1) > (oldestOpenAccepted.ageDays ?? -1)) {
        oldestOpenAccepted = { id: base.id, title: base.title, ageDays: acceptedAge };
      }
    }

    if (OPEN_STATUSES.has(status)) {
      // Body already captured during the rebuild pass above (same read, no re-open).
      // A missing entry means rebuildIndex itself couldn't read the file (a TOCTOU race
      // between its readdir and per-file read) — surface that loudly instead of
      // rendering an empty card that reads as "proposal exists but has no content."
      const cached = row.file ? bodies.get(row.file) : undefined;
      const body = cached !== undefined ? cached : (row.file ? `_(file missing: ${row.file})_` : '');
      open.push({ ...base, body });
    } else {
      other.push(base);
    }
  }

  // Oldest-waiting first: proposed/accepted proposals are the action items.
  open.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  // Most recent activity first for the resolved/dismissed history.
  other.sort((a, b) => (a.ageDays ?? Infinity) - (b.ageDays ?? Infinity));

  const otherOmitted = Math.max(0, other.length - OTHER_CAP);
  return {
    open,
    other: other.slice(0, OTHER_CAP),
    otherOmitted,
    oldestOpenAccepted,
  };
}

function loadWeekly(hermitDir: string): WeeklyState | null {
  const compiledDir = path.join(hermitDir, 'compiled');
  const files = globDir(compiledDir, /^review-weekly-.*\.md$/); // YYYY-Wnn sorts chronologically by name
  if (files.length === 0) return null;

  const latest = readFileWithFrontmatter(files[files.length - 1]);
  if (!latest || !latest.fm) return null;
  const prior = files.length > 1 ? readFileWithFrontmatter(files[files.length - 2]) : null;

  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? parseFloat(v) : (typeof v === 'number' ? v : NaN);
    return Number.isFinite(n) ? n : null;
  };

  const autonomy = num(latest.fm.self_directed_rate);
  const priorAutonomy = prior?.fm ? num(prior.fm.self_directed_rate) : null;

  return {
    week: typeof latest.fm.week === 'string' ? latest.fm.week : 'unknown',
    costUsd: num(latest.fm.total_cost_usd),
    autonomyPct: autonomy != null ? autonomy * 100 : null,
    createdCount: num(latest.fm.proposals_created),
    resolvedCount: num(latest.fm.proposals_resolved),
    priorCostUsd: prior?.fm ? num(prior.fm.total_cost_usd) : null,
    priorAutonomyPct: priorAutonomy != null ? priorAutonomy * 100 : null,
    hasPrior: !!prior?.fm,
    bodyHtml: mdToHtml(latest.body),
  };
}

function loadLastBrief(hermitDir: string): LastBriefState | null {
  const raw = readJsonSafe(path.join(hermitDir, 'state', 'last-brief.json'));
  if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) return null;
  return {
    kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'brief',
    text: raw.text,
    generatedAt: typeof raw.generated_at === 'string' ? raw.generated_at : null,
  };
}

const COMPILED_INDEX_CAP = 20;

function statMtimeMs(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Excludes review-weekly-*.md — those already have their own dedicated section
// (renderWeekly) so listing them again here would just be confusing duplication.
// Newest-first (by mtime) before the cap, so on a hermit with >20 compiled docs the
// discovery surface shows the most recently compiled ones rather than an arbitrary
// alphabetical slice that could hide a just-written doc.
function loadCompiledIndex(hermitDir: string): { docs: CompiledDocRow[]; omitted: number } {
  const compiledDir = path.join(hermitDir, 'compiled');
  const files = globDir(compiledDir, /\.md$/)
    .filter(f => !/^review-weekly-.*\.md$/.test(path.basename(f)))
    .map(f => ({ f, mtime: statMtimeMs(f) })) // stat once per file, not O(n log n) times in the comparator
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ f }) => f);
  const docs: CompiledDocRow[] = files.slice(0, COMPILED_INDEX_CAP).map(f => {
    const name = path.basename(f);
    const parsed = readFileWithFrontmatter(f);
    const title = typeof parsed?.fm?.title === 'string' && parsed.fm.title.trim() ? parsed.fm.title : name;
    return { name, title };
  });
  const omitted = Math.max(0, files.length - COMPILED_INDEX_CAP);
  return { docs, omitted };
}

// Alert entries have no single schema: telemetry/checklist alerts carry a `message`
// string, but budget alerts (the dominant type) store structured fields and no message.
// Synthesize a readable line for those instead of falling back to the raw dedup key.
// Returns an already-escaped, safe-to-inject-raw string: file-derived parts (message,
// period, dedup key) are escaped here; the chrome templates are pre-escaped by
// loadStrings(). renderStatus injects the result without re-escaping, so a translated
// budget-alert string isn't double-escaped.
function alertMessage(key: string, v: Json, s: ArtifactStrings): string {
  if (typeof v?.message === 'string') return escapeHtml(v.message);
  if (v?.kind === 'budget') {
    const period = escapeHtml(typeof v.period === 'string' ? v.period : 'budget');
    const state = v.level === 'breach' ? s.budget_state_breached : s.budget_state_warning;
    const spend = typeof v.spend === 'number' ? `$${v.spend.toFixed(2)}` : null;
    const cap = typeof v.cap === 'number' ? `$${v.cap.toFixed(2)}` : null;
    const amounts = spend && cap ? fmt(s.budget_amounts, { spend, cap }) : '';
    return fmt(s.budget_text, { period, state, amounts });
  }
  return escapeHtml(key);
}

export function loadDashboardState(hermitDir: string): DashboardState {
  const config = readJsonSafe(path.join(hermitDir, 'config.json')) ?? {};
  const timezone = typeof config.timezone === 'string' && config.timezone ? config.timezone : 'UTC';
  const strings = loadStrings(hermitDir);
  const runtime = readJsonSafe(path.join(hermitDir, 'state', 'runtime.json'));
  const today = loadTodayCost(hermitDir, timezone);
  // Union alerts across the per-writer files (skill/checklist + budget + telemetry).
  const alerts: AlertRow[] = [];
  for (const [key, v] of Object.entries<Json>(readMergedAlerts(hermitDir))) {
    if (v?.suppressed === true) continue; // dismissed/digested — not an active alert
    alerts.push({
      key,
      message: alertMessage(key, v, strings),
      timestamp: typeof v?.timestamp === 'string' ? v.timestamp : null,
    });
  }

  return {
    agentName: typeof config.agent_name === 'string' && config.agent_name.trim() ? config.agent_name : 'Hermit',
    sessionState: typeof runtime?.session_state === 'string' ? runtime.session_state : null,
    todayCostUsd: today.costUsd,
    todayTokens: today.tokens,
    alerts,
    proposals: loadProposals(hermitDir),
    weekly: loadWeekly(hermitDir),
    lastBrief: loadLastBrief(hermitDir),
    compiledIndex: loadCompiledIndex(hermitDir),
    strings,
  };
}

// ---------- markdown-subset -> HTML ----------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(escaped: string): string {
  const codeSpans: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `~~CODE~~${codeSpans.length - 1}~~CODE~~`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
    if (/^(https?:|#|mailto:)/i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return text; // unknown/unsafe scheme: keep the label, drop the link
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/~~CODE~~(\d+)~~CODE~~/g, (_m, i) => codeSpans[Number(i)]);
  return s;
}

/** Small markdown subset — headings, lists, fenced/inline code, bold/italic, links.
 *  Not CommonMark; sized for proposal bodies and weekly-review reports. */
export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listBuffer: string[] = [];
  let paraBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length) {
      out.push('<ul>' + listBuffer.map(item => `<li>${inline(item)}</li>`).join('') + '</ul>');
      listBuffer = [];
    }
  };
  const flushPara = () => {
    if (paraBuffer.length) {
      out.push(`<p>${inline(paraBuffer.join(' '))}</p>`);
      paraBuffer = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];

    if (/^```/.test(raw.trim())) {
      flushList(); flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(escapeHtml(lines[i]));
        i++;
      }
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      i++; // skip closing fence
      continue;
    }

    const heading = raw.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      flushList(); flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
      i++;
      continue;
    }

    const listItem = raw.match(/^[-*]\s+(.*)/);
    if (listItem) {
      flushPara();
      listBuffer.push(escapeHtml(listItem[1]));
      i++;
      continue;
    }

    if (raw.trim() === '') {
      flushList(); flushPara();
      i++;
      continue;
    }

    flushList();
    paraBuffer.push(escapeHtml(raw));
    i++;
  }
  flushList();
  flushPara();
  return out.join('\n');
}

// ---------- rendering ----------

export function chip(status: string): string {
  const cls = ['proposed', 'accepted', 'resolved', 'dismissed', 'deferred'].includes(status)
    ? status
    : 'unknown';
  return `<span class="chip chip-${cls}">${escapeHtml(status)}</span>`;
}

function ageLabel(days: number | null, s: ArtifactStrings): string {
  if (days == null) return '';
  if (days === 0) return s.age_today;
  return fmt(s.age_days, { n: days });
}

// Renders " (Nd)" (leading space included) or '' when age is unknown, so callers
// never emit an empty "()" placeholder.
function ageParen(days: number | null, s: ArtifactStrings): string {
  const label = ageLabel(days, s);
  return label ? ` <span class="muted">(${label})</span>` : '';
}

function pct(n: number | null): string {
  return n == null ? '—' : `${Math.round(n)}%`;
}

function delta(current: number | null, prior: number | null, unit: 'pp' | '$', s: ArtifactStrings): string {
  if (current == null || prior == null) return '';
  const diff = current - prior;
  const sign = diff >= 0 ? '+' : '';
  if (unit === '$') {
    const relBase = Math.abs(prior) > 0.0001 ? prior : null;
    const relPct = relBase != null ? Math.round((diff / relBase) * 100) : null;
    return relPct != null
      ? fmt(s.weekly_delta_cost, { prior: `$${prior.toFixed(2)}`, sign, pct: relPct })
      : fmt(s.weekly_delta_cost_no_pct, { prior: `$${prior.toFixed(2)}` });
  }
  return fmt(s.weekly_delta_pp, { prior: Math.round(prior), sign, diff: Math.round(diff) });
}

function renderStatus(state: DashboardState): string {
  const s = state.strings;
  const alertsHtml = state.alerts.length
    ? `<ul class="alerts">${state.alerts
        .map(a => `<li>⚠ ${a.message}</li>`)
        .join('')}</ul>`
    : `<p class="muted">${s.status_no_alerts}</p>`;

  return `
    <section class="card">
      <h2>${s.status_heading}</h2>
      <div class="stat-row">
        <div class="stat"><span class="stat-label">${s.status_session}</span><span class="stat-value">${escapeHtml(state.sessionState ?? 'idle')}</span></div>
        <div class="stat"><span class="stat-label">${s.status_today}</span><span class="stat-value">$${state.todayCostUsd.toFixed(2)} · ${escapeHtml(formatTokens(state.todayTokens))}</span></div>
        <div class="stat"><span class="stat-label">${s.status_alerts}</span><span class="stat-value">${state.alerts.length}</span></div>
      </div>
      ${alertsHtml}
    </section>`;
}

// Shared label for a proposal row: status chip, id, title, age — used both in the
// expandable open-proposal summary and the one-line history entries.
function proposalLabel(p: ProposalRow, s: ArtifactStrings): string {
  return `${chip(p.status)} <strong>${escapeHtml(p.id)}</strong> — ${escapeHtml(p.title)}${ageParen(p.ageDays, s)}`;
}

function renderProposals(state: DashboardState): string {
  const s = state.strings;
  const { open, other, otherOmitted, oldestOpenAccepted } = state.proposals;

  const openHtml = open.length
    ? open
        .map(
          p => `<details class="proposal">
            <summary>${proposalLabel(p, s)}</summary>
            <div class="proposal-body">${mdToHtml(p.body)}</div>
          </details>`
        )
        .join('')
    : `<p class="muted">${s.proposals_none_open}</p>`;

  const otherHtml = other.length
    ? `<ul class="proposal-history">${other
        .map(p => `<li>${proposalLabel(p, s)}</li>`)
        .join('')}${otherOmitted > 0 ? `<li class="muted">${fmt(s.common_more_not_shown, { n: otherOmitted })}</li>` : ''}</ul>`
    : '';

  const oldestLine = oldestOpenAccepted
    ? `<p class="muted">${fmt(s.proposals_oldest_accepted, {
        id: escapeHtml(oldestOpenAccepted.id),
        age: oldestOpenAccepted.ageDays != null
          ? fmt(s.proposals_since_accepted, { age: ageLabel(oldestOpenAccepted.ageDays, s) })
          : '',
      })}</p>`
    : '';

  return `
    <section class="card">
      <h2>${s.proposals_heading}</h2>
      ${oldestLine}
      ${openHtml}
      ${otherHtml}
    </section>`;
}

function renderWeekly(state: DashboardState): string {
  const s = state.strings;
  const w = state.weekly;
  if (!w) {
    return `<section class="card"><h2>${s.weekly_heading}</h2><p class="muted">${s.weekly_none}</p></section>`;
  }

  const costLine = w.costUsd != null
    ? fmt(s.weekly_cost, { amount: `$${w.costUsd.toFixed(2)}`, delta: w.hasPrior ? delta(w.costUsd, w.priorCostUsd, '$', s) : '' })
    : null;
  const autonomyLine = w.autonomyPct != null
    ? fmt(s.weekly_autonomy, { pct: pct(w.autonomyPct), delta: w.hasPrior ? delta(w.autonomyPct, w.priorAutonomyPct, 'pp', s) : '' })
    : null;
  const proposalsLine = (w.createdCount != null || w.resolvedCount != null)
    ? fmt(s.weekly_proposals, { created: w.createdCount ?? 0, resolved: w.resolvedCount ?? 0 })
    : null;

  const summary = [costLine, autonomyLine, proposalsLine].filter(Boolean) as string[];

  return `
    <section class="card">
      <h2>${fmt(s.weekly_week, { week: escapeHtml(w.week) })}</h2>
      <ul class="evolution">${summary.map(l => `<li>${l}</li>`).join('')}</ul>
      <details class="weekly-body">
        <summary>${s.weekly_full_review}</summary>
        <div>${w.bodyHtml}</div>
      </details>
    </section>`;
}

function renderBrief(state: DashboardState): string {
  const s = state.strings;
  const b = state.lastBrief;
  if (!b) {
    return `<section class="card"><h2>${s.brief_heading}</h2><p class="muted">${s.brief_none}</p></section>`;
  }
  const when = b.generatedAt ? ` <span class="muted">· ${escapeHtml(b.generatedAt)}</span>` : '';
  return `
    <section class="card">
      <h2>${s.brief_heading} <span class="muted">(${escapeHtml(b.kind)})</span>${when}</h2>
      ${mdToHtml(b.text)}
    </section>`;
}

function renderCompiledIndex(state: DashboardState): string {
  const s = state.strings;
  const { docs, omitted } = state.compiledIndex;
  if (!docs.length) {
    return `<section class="card"><h2>${s.compiled_heading}</h2><p class="muted">${s.compiled_none}</p></section>`;
  }
  const items = docs.map(d => `<li>${escapeHtml(d.title)} <span class="muted">(${escapeHtml(d.name)})</span></li>`).join('');
  const omittedLine = omitted > 0 ? `<li class="muted">${fmt(s.common_more_not_shown, { n: omitted })}</li>` : '';
  return `
    <section class="card">
      <h2>${s.compiled_heading}</h2>
      <p class="muted">${s.compiled_hint}</p>
      <ul class="proposal-history">${items}${omittedLine}</ul>
    </section>`;
}

export const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --border: #e5e7eb; --card-bg: #fafafa;
  --chip-proposed-bg: #fef3c7; --chip-proposed-fg: #92400e;
  --chip-accepted-bg: #dbeafe; --chip-accepted-fg: #1e40af;
  --chip-resolved-bg: #dcfce7; --chip-resolved-fg: #166534;
  --chip-dismissed-bg: #f3f4f6; --chip-dismissed-fg: #4b5563;
  --chip-deferred-bg: #ede9fe; --chip-deferred-fg: #5b21b6;
  --chip-unknown-bg: #f3f4f6; --chip-unknown-fg: #6b7280;
  --code-bg: #f3f4f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --fg: #e5e7eb; --muted: #9ca3af; --border: #2a2e37; --card-bg: #171a20;
    --chip-proposed-bg: #422006; --chip-proposed-fg: #fbbf24;
    --chip-accepted-bg: #1e3a5f; --chip-accepted-fg: #93c5fd;
    --chip-resolved-bg: #14321f; --chip-resolved-fg: #86efac;
    --chip-dismissed-bg: #1f2229; --chip-dismissed-fg: #9ca3af;
    --chip-deferred-bg: #2e1f4d; --chip-deferred-fg: #c4b5fd;
    --chip-unknown-bg: #1f2229; --chip-unknown-fg: #9ca3af;
    --code-bg: #1f2229;
  }
}
:root[data-theme="light"] {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --border: #e5e7eb; --card-bg: #fafafa; --code-bg: #f3f4f6;
}
:root[data-theme="dark"] {
  --bg: #0f1115; --fg: #e5e7eb; --muted: #9ca3af; --border: #2a2e37; --card-bg: #171a20; --code-bg: #1f2229;
}
* { box-sizing: border-box; }
body, .hermit-page { margin: 0; }
.hermit-page {
  background: var(--bg); color: var(--fg);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  max-width: 720px; margin: 0 auto; padding: 24px 20px 48px;
}
.hermit-page header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 20px; }
.hermit-page header h1 { font-size: 18px; margin: 0; }
.hermit-page header .updated { color: var(--muted); font-size: 13px; }
.card { border: 1px solid var(--border); background: var(--card-bg); border-radius: 8px; padding: 16px 18px; margin-bottom: 16px; overflow-x: auto; }
.card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 12px; }
.stat-row { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
.stat { display: flex; flex-direction: column; }
.stat-label { font-size: 12px; color: var(--muted); }
.stat-value { font-size: 16px; font-weight: 600; }
.muted { color: var(--muted); font-size: 13px; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.chip-proposed { background: var(--chip-proposed-bg); color: var(--chip-proposed-fg); }
.chip-accepted { background: var(--chip-accepted-bg); color: var(--chip-accepted-fg); }
.chip-resolved { background: var(--chip-resolved-bg); color: var(--chip-resolved-fg); }
.chip-dismissed { background: var(--chip-dismissed-bg); color: var(--chip-dismissed-fg); }
.chip-deferred { background: var(--chip-deferred-bg); color: var(--chip-deferred-fg); }
.chip-unknown { background: var(--chip-unknown-bg); color: var(--chip-unknown-fg); }
.alerts { margin: 8px 0 0; padding-left: 18px; }
.proposal { border-top: 1px solid var(--border); padding: 8px 0; }
.proposal:first-of-type { border-top: none; }
.proposal summary { cursor: pointer; }
.proposal-body { margin-top: 8px; padding-left: 4px; }
.proposal-history { list-style: none; margin: 8px 0 0; padding: 0; }
.proposal-history li { padding: 4px 0; border-top: 1px solid var(--border); }
.proposal-history li:first-child { border-top: none; }
.evolution { margin: 0 0 12px; padding-left: 18px; }
.weekly-body summary { cursor: pointer; color: var(--muted); }
code { background: var(--code-bg); border-radius: 4px; padding: 1px 5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
pre { background: var(--code-bg); border-radius: 6px; padding: 10px 12px; overflow-x: auto; }
pre code { background: none; padding: 0; }
a { color: inherit; }
footer.hermit-footer { color: var(--muted); font-size: 12px; margin-top: 8px; }
`;

/** Renders the full artifact fragment plus a content hash stable across
 *  identical underlying state (the "last updated" stamp is excluded from the hash
 *  via a placeholder token, so the publish gate can skip no-op republishes). */
export function renderDashboard(state: DashboardState, opts?: { now?: string }): { html: string; hash: string } {
  const s = state.strings;
  const templated = `<title>${s.dashboard_title}</title>
<style>${CSS}</style>
<div class="hermit-page">
  <header>
    <h1>${fmt(s.dashboard_header, { name: escapeHtml(state.agentName) })}</h1>
    <span class="updated">${s.label_updated} ${UPDATED_TOKEN}</span>
  </header>
  ${renderStatus(state)}
  ${renderBrief(state)}
  ${renderProposals(state)}
  ${renderWeekly(state)}
  ${renderCompiledIndex(state)}
  <footer class="hermit-footer">${s.footer}</footer>
</div>
`;

  const hash = sha256(templated);
  const now = opts?.now ?? new Date().toISOString();
  const html = templated.replace(UPDATED_TOKEN, escapeHtml(now));
  return { html, hash };
}
