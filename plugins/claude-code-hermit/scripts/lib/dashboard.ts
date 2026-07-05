// Deterministic renderer for the Hermit Dashboard artifact — no model authorship,
// so a publish costs a render (pennies) instead of a generation (dollars). Reads only
// state already on disk (runtime.json, cost-index.json, alert-state.json, proposals-index.json
// + proposal bodies, latest compiled/review-weekly-*.md) and produces one self-contained
// HTML fragment. The Artifact tool wraps the fragment in the page shell — this file must
// not include <!DOCTYPE>/<html>/<head>/<body> (see https://code.claude.com/docs/en/artifacts,
// Page constraints).

import fs from 'node:fs';
import path from 'node:path';
import { readFileWithFrontmatter, globDir } from './frontmatter';
import { formatTokens } from './format';
import { sha256 } from './hash';
import { readAlertState } from './alert-state';
import { todayYMD } from './time';
import { costIndexPath, readCostIndex } from './cost-log';
import { rebuildIndex, type ProposalsIndex } from '../proposals-index';

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

function loadProposals(hermitDir: string): DashboardState['proposals'] {
  const idxPath = path.join(hermitDir, 'state', 'proposals-index.json');
  let index: ProposalsIndex | null = readJsonSafe(idxPath);
  if (!index) index = rebuildIndex(hermitDir); // self-heal: missing/stale cache, or first run
  if (!index || !Array.isArray(index.proposals)) {
    return { open: [], other: [], otherOmitted: 0, oldestOpenAccepted: null };
  }

  const proposalsDir = path.join(hermitDir, 'proposals');
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
      let body = '';
      if (row.file) {
        const parsed = readFileWithFrontmatter(path.join(proposalsDir, row.file));
        if (parsed) body = parsed.body;
      }
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

// Alert entries have no single schema: telemetry/checklist alerts carry a `message`
// string, but budget alerts (the dominant type) store structured fields and no message.
// Synthesize a readable line for those instead of falling back to the raw dedup key.
function alertMessage(key: string, v: Json): string {
  if (typeof v?.message === 'string') return v.message;
  if (v?.kind === 'budget') {
    const period = typeof v.period === 'string' ? v.period : 'budget';
    const state = v.level === 'breach' ? 'breached' : 'warning';
    const spend = typeof v.spend === 'number' ? `$${v.spend.toFixed(2)}` : null;
    const cap = typeof v.cap === 'number' ? `$${v.cap.toFixed(2)}` : null;
    const amounts = spend && cap ? ` (${spend} of ${cap})` : '';
    return `${period} budget ${state}${amounts}`;
  }
  return key;
}

export function loadDashboardState(hermitDir: string): DashboardState {
  const config = readJsonSafe(path.join(hermitDir, 'config.json')) ?? {};
  const timezone = typeof config.timezone === 'string' && config.timezone ? config.timezone : 'UTC';
  const runtime = readJsonSafe(path.join(hermitDir, 'state', 'runtime.json'));
  const today = loadTodayCost(hermitDir, timezone);
  const alertRead = readAlertState(path.join(hermitDir, 'state', 'alert-state.json'));

  const alerts: AlertRow[] = [];
  if (alertRead.kind === 'ok' && alertRead.value.alerts && typeof alertRead.value.alerts === 'object') {
    for (const [key, v] of Object.entries<Json>(alertRead.value.alerts)) {
      if (v?.suppressed === true) continue; // dismissed/digested — not an active alert
      alerts.push({
        key,
        message: alertMessage(key, v),
        timestamp: typeof v?.timestamp === 'string' ? v.timestamp : null,
      });
    }
  }

  return {
    agentName: typeof config.agent_name === 'string' && config.agent_name.trim() ? config.agent_name : 'Hermit',
    sessionState: typeof runtime?.session_state === 'string' ? runtime.session_state : null,
    todayCostUsd: today.costUsd,
    todayTokens: today.tokens,
    alerts,
    proposals: loadProposals(hermitDir),
    weekly: loadWeekly(hermitDir),
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

function chip(status: string): string {
  const cls = ['proposed', 'accepted', 'resolved', 'dismissed', 'deferred'].includes(status)
    ? status
    : 'unknown';
  return `<span class="chip chip-${cls}">${escapeHtml(status)}</span>`;
}

function ageLabel(days: number | null): string {
  if (days == null) return '';
  if (days === 0) return 'today';
  return `${days}d`;
}

// Renders " (Nd)" (leading space included) or '' when age is unknown, so callers
// never emit an empty "()" placeholder.
function ageParen(days: number | null): string {
  const label = ageLabel(days);
  return label ? ` <span class="muted">(${label})</span>` : '';
}

function pct(n: number | null): string {
  return n == null ? '—' : `${Math.round(n)}%`;
}

function delta(current: number | null, prior: number | null, unit: 'pp' | '$'): string {
  if (current == null || prior == null) return '';
  const diff = current - prior;
  const sign = diff >= 0 ? '+' : '';
  if (unit === '$') {
    const relBase = Math.abs(prior) > 0.0001 ? prior : null;
    const relPct = relBase != null ? Math.round((diff / relBase) * 100) : null;
    return relPct != null ? ` (vs $${prior.toFixed(2)} prior, ${sign}${relPct}%)` : ` (vs $${prior.toFixed(2)} prior)`;
  }
  return ` (vs ${Math.round(prior)}% prior, ${sign}${Math.round(diff)}pp)`;
}

function renderStatus(state: DashboardState): string {
  const alertsHtml = state.alerts.length
    ? `<ul class="alerts">${state.alerts
        .map(a => `<li>⚠ ${escapeHtml(a.message)}</li>`)
        .join('')}</ul>`
    : `<p class="muted">No active alerts.</p>`;

  return `
    <section class="card">
      <h2>Status</h2>
      <div class="stat-row">
        <div class="stat"><span class="stat-label">Session</span><span class="stat-value">${escapeHtml(state.sessionState ?? 'idle')}</span></div>
        <div class="stat"><span class="stat-label">Today</span><span class="stat-value">$${state.todayCostUsd.toFixed(2)} · ${escapeHtml(formatTokens(state.todayTokens))}</span></div>
        <div class="stat"><span class="stat-label">Alerts</span><span class="stat-value">${state.alerts.length}</span></div>
      </div>
      ${alertsHtml}
    </section>`;
}

// Shared label for a proposal row: status chip, id, title, age — used both in the
// expandable open-proposal summary and the one-line history entries.
function proposalLabel(p: ProposalRow): string {
  return `${chip(p.status)} <strong>${escapeHtml(p.id)}</strong> — ${escapeHtml(p.title)}${ageParen(p.ageDays)}`;
}

function renderProposals(state: DashboardState): string {
  const { open, other, otherOmitted, oldestOpenAccepted } = state.proposals;

  const openHtml = open.length
    ? open
        .map(
          p => `<details class="proposal">
            <summary>${proposalLabel(p)}</summary>
            <div class="proposal-body">${mdToHtml(p.body)}</div>
          </details>`
        )
        .join('')
    : `<p class="muted">No open proposals.</p>`;

  const otherHtml = other.length
    ? `<ul class="proposal-history">${other
        .map(p => `<li>${proposalLabel(p)}</li>`)
        .join('')}${otherOmitted > 0 ? `<li class="muted">+${otherOmitted} more not shown</li>` : ''}</ul>`
    : '';

  const oldestLine = oldestOpenAccepted
    ? `<p class="muted">Oldest open accepted: ${escapeHtml(oldestOpenAccepted.id)}${oldestOpenAccepted.ageDays != null ? ` (${ageLabel(oldestOpenAccepted.ageDays)} since accepted)` : ''}</p>`
    : '';

  return `
    <section class="card">
      <h2>Proposals</h2>
      ${oldestLine}
      ${openHtml}
      ${otherHtml}
    </section>`;
}

function renderWeekly(state: DashboardState): string {
  const w = state.weekly;
  if (!w) {
    return `<section class="card"><h2>This week's evolution</h2><p class="muted">No weekly review yet.</p></section>`;
  }

  const costLine = w.costUsd != null
    ? `Cost: $${w.costUsd.toFixed(2)}${w.hasPrior ? delta(w.costUsd, w.priorCostUsd, '$') : ''}`
    : null;
  const autonomyLine = w.autonomyPct != null
    ? `Autonomy: ${pct(w.autonomyPct)} self-directed${w.hasPrior ? delta(w.autonomyPct, w.priorAutonomyPct, 'pp') : ''}`
    : null;
  const proposalsLine = (w.createdCount != null || w.resolvedCount != null)
    ? `Proposals: +${w.createdCount ?? 0} created, ${w.resolvedCount ?? 0} resolved`
    : null;

  const summary = [costLine, autonomyLine, proposalsLine].filter(Boolean) as string[];

  return `
    <section class="card">
      <h2>Week ${escapeHtml(w.week)}</h2>
      <ul class="evolution">${summary.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
      <details class="weekly-body">
        <summary>Full review</summary>
        <div>${w.bodyHtml}</div>
      </details>
    </section>`;
}

const CSS = `
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
body, .hermit-dashboard { margin: 0; }
.hermit-dashboard {
  background: var(--bg); color: var(--fg);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  max-width: 720px; margin: 0 auto; padding: 24px 20px 48px;
}
.hermit-dashboard header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 20px; }
.hermit-dashboard header h1 { font-size: 18px; margin: 0; }
.hermit-dashboard header .updated { color: var(--muted); font-size: 13px; }
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
  const templated = `<title>Hermit Dashboard</title>
<style>${CSS}</style>
<div class="hermit-dashboard">
  <header>
    <h1>${escapeHtml(state.agentName)} — Hermit Dashboard</h1>
    <span class="updated">updated ${UPDATED_TOKEN}</span>
  </header>
  ${renderStatus(state)}
  ${renderProposals(state)}
  ${renderWeekly(state)}
  <footer class="hermit-footer">Rendered by claude-code-hermit — script-generated, not model-authored.</footer>
</div>
`;

  const hash = sha256(templated);
  const now = opts?.now ?? new Date().toISOString();
  const html = templated.replace(UPDATED_TOKEN, escapeHtml(now));
  return { html, hash };
}
