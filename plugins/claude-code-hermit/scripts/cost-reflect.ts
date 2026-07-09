import fs from 'node:fs';
import path from 'node:path';

import { costByType } from './lib/pricing';
import { loadConfig } from './lib/channel-auth';
import { money, resolveTimezone, budgetLine } from './lib/spend-status';
import { todayYMD } from './lib/time';

type Json = any;

// Cold-start heuristic: a turn where the context was NOT warm.
// These turns drive cache_write cost without benefiting from a warm cache.
// Condition: cache was written (non-trivial turn), no prior cache was read,
// and output is small (i.e. this was a context-warm-up rather than real work).
const COLD_START_OUTPUT_MAX = 1000; // tokens

const MAX_TOP_SESSIONS = 3;
const MAX_TOP_SOURCES = 5;
const MAX_CHARS = 1500;

// --plain mode: a channel-safe, no-jargon spend statement (audit's "plain spend
// statement" PR). Today + a trailing 7-day baseline needs 8 calendar days of log.
const PLAIN_LOOKBACK_DAYS = 8;

// Buckets the raw `source` values (heartbeat / routine:<id> / channel:<kind> / other)
// into the plain-language groupings a non-dev operator recognizes — never the raw
// source string itself.
function labelSource(src: string): string {
  if (src === 'heartbeat') return 'background check-ins';
  if (src.startsWith('routine:')) return 'scheduled routines';
  if (src.startsWith('channel:')) return 'your messages';
  return 'our conversations';
}

function parseLogEntries(costLog: string): Json[] {
  try {
    const content = fs.readFileSync(costLog, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').reduce((acc: Json[], line) => {
      try { acc.push(JSON.parse(line)); } catch {}
      return acc;
    }, []);
  } catch {
    return [];
  }
}

function pct(part: number, total: number) {
  if (total === 0) return '0%';
  return Math.round((part / total) * 100) + '%';
}

function formatCost(n: number) {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

// Total-vs-typical framing for the plain statement. `typical` is the trailing
// 7-day daily average (today excluded, so a still-running day isn't self-compared).
function compareToTypical(today: number, typical: number): string {
  if (typical <= 0) return '';
  const ratio = today / typical;
  if (ratio >= 1.3) return ` — higher than a typical day (~${money(typical)}/day)`;
  if (ratio <= 0.7) return ` — lower than a typical day (~${money(typical)}/day)`;
  return ` — about a typical day (~${money(typical)}/day)`;
}

// Top 2-3 plain-language drivers by cost. Multiple raw sources collapsing into the
// same label (e.g. several routine:<id> buckets) are summed under that one label.
function buildDriverLine(bySource: Record<string, number>): string | null {
  const merged: Record<string, number> = {};
  for (const [src, cost] of Object.entries(bySource)) {
    const label = labelSource(src);
    merged[label] = (merged[label] || 0) + cost;
  }
  const top = Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length === 0) return null;
  return `Mostly from ${top.map(([label, cost]) => `${label} (${money(cost)})`).join(', ')}.`;
}

function buildPlainStatement(stateDir: string, costLog: string): string {
  const config = loadConfig(stateDir) || {};
  const timezone = resolveTimezone(config);

  // Timezone-aware calendar-day key, matching how lib/cost-log.ts buckets the same
  // log for budgetLine's cap check below — a raw UTC slice here would let "Today"'s
  // total and the cap line disagree near a non-UTC operator's day boundary.
  const entryDate = (e: Json): string => {
    const ts = e.timestamp ? new Date(e.timestamp) : null;
    return ts && !isNaN(ts.getTime()) ? todayYMD(timezone, ts) : '';
  };

  const entries = parseLogEntries(costLog);
  const cutoffDate = todayYMD(timezone, new Date(Date.now() - PLAIN_LOOKBACK_DAYS * 86400000));
  const recent = entries.filter(e => {
    const d = entryDate(e);
    return d && d >= cutoffDate;
  });

  if (recent.length === 0) {
    return 'No spend recorded yet.\n';
  }

  const today = todayYMD(timezone);
  const byDate: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const e of recent) {
    const model = e.model || 'sonnet';
    const types = costByType(model, e.input_tokens || 0, e.cache_write_tokens || 0, e.cache_read_tokens || 0, e.output_tokens || 0);
    const cost = types.input + types.cacheWrite + types.cacheRead + types.output;
    const date = entryDate(e);
    if (date) byDate[date] = (byDate[date] || 0) + cost;
    bySource[e.source || 'other'] = (bySource[e.source || 'other'] || 0) + cost;
  }

  const lines: string[] = [];

  const todaySpend = byDate[today] || 0;
  const priorDates = Object.keys(byDate).filter(d => d !== today);
  const typical = priorDates.length > 0
    ? priorDates.reduce((sum, d) => sum + byDate[d], 0) / priorDates.length
    : 0;
  lines.push(`Today: ${money(todaySpend)}${compareToTypical(todaySpend, typical)}.`);

  const driverLine = buildDriverLine(bySource);
  if (driverLine) lines.push(driverLine);

  const cap = budgetLine(stateDir, config, timezone);
  if (cap) lines.push(cap);

  lines.push('These dollar figures are an estimate for tracking spend, not a literal bill.');

  return lines.join('\n') + '\n';
}

function run() {
  const rawArgs = process.argv.slice(2);
  const plainMode = rawArgs.includes('--plain');
  const positional = rawArgs.filter(a => a !== '--plain');
  const stateDir = positional[0] || '.claude-code-hermit';
  const days = Math.max(1, parseInt(positional[1], 10) || 7);

  // cost-log.jsonl is a sibling of the state dir (both under the project root).
  const costLog = path.resolve(stateDir, '..', '.claude', 'cost-log.jsonl');

  if (plainMode) {
    process.stdout.write(buildPlainStatement(stateDir, costLog));
    return;
  }

  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const entries = parseLogEntries(costLog);

  const window = entries.filter(e => {
    const d = (e.timestamp || '').slice(0, 10);
    return d && d >= cutoffDate;
  });

  if (window.length === 0) {
    process.stdout.write(`No cost data in the last ${days} days.\n`);
    return;
  }

  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let coldStartTurns = 0;
  let coldStartCost = 0;
  const sessionMap: Record<string, Json> = {}; // session_id -> { cost, turns, byType }
  const sourceMap: Record<string, number> = {};
  const modelMap: Record<string, { cost: number; byType: { input: number; cacheWrite: number; cacheRead: number; output: number } }> = {};

  for (const e of window) {
    const model = e.model || 'sonnet';
    const inp  = e.input_tokens        || 0;
    const cw   = e.cache_write_tokens  || 0;
    const cr   = e.cache_read_tokens   || 0;
    const out  = e.output_tokens       || 0;

    const types = costByType(model, inp, cw, cr, out);
    const entryCost = types.input + types.cacheWrite + types.cacheRead + types.output;
    totals.input      += types.input;
    totals.cacheWrite += types.cacheWrite;
    totals.cacheRead  += types.cacheRead;
    totals.output     += types.output;

    // Subagent lines contribute to cost totals but not to turn counts or cold-start detection.
    if (!e.subagent && cw > 0 && cr === 0 && out < COLD_START_OUTPUT_MAX) {
      coldStartTurns++;
      coldStartCost += entryCost;
    }

    // Per-session attribution (by sub-cost, not token volume)
    const sid = e.session_id || '';
    if (sid) {
      if (!sessionMap[sid]) {
        sessionMap[sid] = { cost: 0, turns: 0, byType: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };
      }
      const s = sessionMap[sid];
      s.cost += entryCost;
      if (!e.subagent) s.turns++;
      s.byType.input      += types.input;
      s.byType.cacheWrite += types.cacheWrite;
      s.byType.cacheRead  += types.cacheRead;
      s.byType.output     += types.output;
    }

    // Per-source attribution; legacy entries without 'source' bucket to 'other'
    const src = e.source || 'other';
    sourceMap[src] = (sourceMap[src] || 0) + entryCost;

    // subagent lines included intentionally — they carry a resolved model unlike the cold-start guard above
    if (!modelMap[model]) modelMap[model] = { cost: 0, byType: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };
    const mm = modelMap[model];
    mm.cost += entryCost;
    mm.byType.input      += types.input;
    mm.byType.cacheWrite += types.cacheWrite;
    mm.byType.cacheRead  += types.cacheRead;
    mm.byType.output     += types.output;
  }

  const total = totals.input + totals.cacheWrite + totals.cacheRead + totals.output;
  const sessions = Object.keys(sessionMap).length;
  const turns = window.filter(e => !e.subagent).length;

  const topSessions = Object.entries(sessionMap)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, MAX_TOP_SESSIONS)
    .map(([sid, s]) => {
      const dominant = Object.entries(s.byType).sort((a: Json, b: Json) => b[1] - a[1])[0][0];
      const label = dominant === 'cacheRead' ? 'cache_read' : dominant === 'cacheWrite' ? 'cache_write' : dominant;
      return { id: sid.slice(0, 8), cost: s.cost, turns: s.turns, dominant: label };
    });

  // All source entries sorted desc by cost; tail count used for the '+N more' line
  const allSources = Object.entries(sourceMap).sort((a, b) => b[1] - a[1]);

  const header = `### Cost by token type (${days}d · ${formatCost(total)} · ${turns} turns / ${sessions} sessions)\n` +
    `- cache_read ${formatCost(totals.cacheRead)} (${pct(totals.cacheRead, total)})` +
    ` · cache_write ${formatCost(totals.cacheWrite)} (${pct(totals.cacheWrite, total)})` +
    ` · output ${formatCost(totals.output)} (${pct(totals.output, total)})` +
    ` · input ${formatCost(totals.input)} (${pct(totals.input, total)})\n`;

  const coldSection = coldStartTurns > 0
    ? `\n### Cold starts\n- ${coldStartTurns} turn${coldStartTurns === 1 ? '' : 's'} · ${formatCost(coldStartCost)} (${pct(coldStartCost, total)}) — cache-write, no cache-read, <${COLD_START_OUTPUT_MAX} output tokens\n`
    : '';

  function buildSourceSection(n: number) {
    if (n <= 0 || allSources.length === 0) return '';
    const rest = allSources.length - n;
    const shown = allSources.slice(0, n);
    const rows = shown.map(([src, cost]) => {
      const label = src === 'other' ? `${src} _(non-scheduled)_` : src;
      return `- ${label}: ${formatCost(cost)} (${pct(cost, total)})`;
    });
    if (rest > 0) rows.push(`- +${rest} more sources`);
    // Footnote only when a routine row is actually displayed — otherwise it dangles.
    const footnote = shown.some(([src]) => src.startsWith('routine:'))
      ? `\n_routine model-override subagent cost is included, attributed to its dispatching source_\n`
      : '';
    return `\n### Cost by source\n${rows.join('\n')}\n${footnote}`;
  }

  function buildModelSection() {
    // Only render when ≥2 distinct models are present — a single-model window learns
    // nothing new from this vs the combined token-type header.
    const entries = Object.entries(modelMap);
    if (entries.length < 2) return '';
    const rows = entries
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([mdl, { cost, byType }]) => {
        const components = (
          [
            ['cache_read',  byType.cacheRead],
            ['cache_write', byType.cacheWrite],
            ['output',      byType.output],
            ['input',       byType.input],
          ] as [string, number][]
        )
          .filter(([, v]) => v > 0)
          .map(([label, v]) => `${label} ${formatCost(v)}`)
          .join(', ');
        return `- ${mdl} ${formatCost(cost)} (${pct(cost, total)})${components ? ` — ${components}` : ''}`;
      });
    return `\n### Cost by model\n${rows.join('\n')}\n`;
  }

  function buildTopSection(n: number) {
    if (n <= 0 || topSessions.length === 0) return '';
    const lines = topSessions.slice(0, n).map(s =>
      `- ${s.id}: ${formatCost(s.cost)} (${s.turns} turn${s.turns === 1 ? '' : 's'}, mostly ${s.dominant})`
    ).join('\n');
    return `\n### Top sessions\n${lines}\n`;
  }

  const modelSection = buildModelSection();

  // Enforce ≤1500 chars. Shed source rows first (lowest-value for operators with
  // many routines) down to zero, then shed top-sessions — a single monotonic path.
  for (let m = MAX_TOP_SOURCES; m >= 1; m--) {
    const body = header + modelSection + coldSection + buildSourceSection(m) + buildTopSection(MAX_TOP_SESSIONS);
    if (body.length <= MAX_CHARS) {
      process.stdout.write(body);
      return;
    }
  }
  for (let n = MAX_TOP_SESSIONS; n >= 0; n--) {
    const body = header + modelSection + coldSection + buildTopSection(n);
    if (body.length <= MAX_CHARS || n === 0) {
      process.stdout.write(body);
      return;
    }
  }
}

try {
  run();
} catch (err: any) {
  // Fail-open: never block on a cost-reflect failure
  process.stdout.write(`cost-reflect: error — ${err.message}\n`);
  process.exit(0);
}
