// bun test for scripts/lib/dashboard.ts — dashboard renderer.
// Usage: bun test tests/dashboard.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadDashboardState, renderDashboard, mdToHtml, escapeHtml } from '../scripts/lib/dashboard';

// ---------- fixture scaffolding ----------

function makeHermitDir(): { hermitDir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-dashboard-'));
  const hermitDir = path.join(root, '.claude-code-hermit');
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'compiled'), { recursive: true });
  return { hermitDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function withHermitDir(fn: (hermitDir: string) => void) {
  return () => {
    const h = makeHermitDir();
    try { fn(h.hermitDir); } finally { h.cleanup(); }
  };
}

function writeJson(hermitDir: string, rel: string, data: unknown): void {
  fs.writeFileSync(path.join(hermitDir, rel), JSON.stringify(data, null, 2));
}

// "Today" cost is sourced from cost-index.json's timezone-aware daily bucket.
const TODAY_UTC = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
function writeTodayCost(hermitDir: string, cost: number, tokens: number): void {
  // version must match cost-log.ts's INDEX_VERSION; readCostIndex null-gates on it.
  writeJson(hermitDir, 'state/cost-index.json', { version: 3, by_date: { [TODAY_UTC]: { cost, tokens, session_ids: [] } } });
}

function writeProposal(hermitDir: string, file: string, fm: Record<string, string>, body: string): void {
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(hermitDir, 'proposals', file), `---\n${yaml}\n---\n${body}\n`);
}

function writeWeekly(hermitDir: string, week: string, fm: Record<string, string>, body: string): void {
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(hermitDir, 'compiled', `review-weekly-${week}.md`), `---\n${yaml}\n---\n${body}\n`);
}

function writeLastBrief(hermitDir: string, kind: string, text: string, generatedAt = '2026-07-05T08:00:00Z'): void {
  writeJson(hermitDir, 'state/last-brief.json', { kind, text, generated_at: generatedAt });
}

function writeCompiledDoc(hermitDir: string, file: string, fm: Record<string, string> | null, body: string): void {
  const content = fm
    ? `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`
    : `${body}\n`;
  fs.writeFileSync(path.join(hermitDir, 'compiled', file), content);
}

// ---------- mdToHtml ----------

describe('mdToHtml', () => {
  test('renders headings, bold, italic, inline code, and links', () => {
    const html = mdToHtml('# Title\n\nSome **bold** and *italic* and `code` and a [link](https://example.com).');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>');
  });

  test('handles multiple inline code spans in one paragraph', () => {
    const html = mdToHtml('Compare `alpha` against `beta` and `gamma`.');
    expect(html).toContain('<code>alpha</code>');
    expect(html).toContain('<code>beta</code>');
    expect(html).toContain('<code>gamma</code>');
  });

  test('renders unordered lists', () => {
    const html = mdToHtml('- one\n- two\n- three');
    expect(html).toBe('<ul><li>one</li><li>two</li><li>three</li></ul>');
  });

  test('renders fenced code blocks with escaped content', () => {
    const html = mdToHtml('```\nconst x = 1 < 2;\n```');
    expect(html).toContain('<pre><code>const x = 1 &lt; 2;</code></pre>');
  });

  test('drops javascript: scheme links but keeps the label', () => {
    const html = mdToHtml('[click me](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).toContain('click me');
  });

  test('escapes raw HTML in proposal text', () => {
    const html = mdToHtml('<script>alert(1)</script> and & ampersand');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; ampersand');
  });
});

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

// ---------- loadDashboardState ----------

describe('loadDashboardState', () => {
  test('degrades to placeholders when all state files are missing', withHermitDir((hermitDir) => {
    const state = loadDashboardState(hermitDir);
    expect(state.agentName).toBe('Hermit');
    expect(state.sessionState).toBeNull();
    expect(state.todayCostUsd).toBe(0);
    expect(state.todayTokens).toBe(0);
    expect(state.alerts).toEqual([]);
    expect(state.proposals.open).toEqual([]);
    expect(state.proposals.other).toEqual([]);
    expect(state.weekly).toBeNull();
  }));

  test('reads agent name, session state, cost, and alerts', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'config.json', { agent_name: 'shelly' });
    writeJson(hermitDir, 'state/runtime.json', { session_state: 'in_progress' });
    writeTodayCost(hermitDir, 0.42, 125000);
    writeJson(hermitDir, 'state/alert-state.json', {
      alerts: { 'budget-daily': { message: 'Daily budget at 92%', timestamp: '2026-07-05T08:00:00Z' } },
      self_eval: {}, total_ticks: 1, last_digest_date: null,
    });

    const state = loadDashboardState(hermitDir);
    expect(state.agentName).toBe('shelly');
    expect(state.sessionState).toBe('in_progress');
    expect(state.todayCostUsd).toBe(0.42);
    expect(state.todayTokens).toBe(125000);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0].message).toBe('Daily budget at 92%');
  }));

  test('skips suppressed alerts and reads a readable message for message-less budget alerts', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'state/alert-state.json', {
      alerts: {
        'budget-breach:daily:2026-07-05': { kind: 'budget', level: 'breach', period: 'daily', spend: 5.2, cap: 5, notified: true, ts: '2026-07-05T08:00:00Z' },
        'telemetry-export-failed': { message: 'telemetry export failing', count: 9, suppressed: true },
      },
      self_eval: {}, total_ticks: 1, last_digest_date: null,
    });
    const state = loadDashboardState(hermitDir);
    expect(state.alerts).toHaveLength(1); // suppressed telemetry alert excluded
    expect(state.alerts[0].message).toBe('daily budget breached ($5.20 of $5.00)');
    expect(state.alerts[0].message).not.toContain('budget-breach:daily'); // not the raw dedup key
  }));

  test('oldest open accepted age is measured from accepted_date, not creation', withHermitDir((hermitDir) => {
    const nowMs = Date.now();
    const created = new Date(nowMs - 40 * 86400000).toISOString();  // created 40d ago
    const accepted = new Date(nowMs - 3 * 86400000).toISOString();  // accepted 3d ago
    writeProposal(hermitDir, 'PROP-010-accepted-100000.md',
      { id: 'PROP-010-accepted-100000', title: '"Long-open accept"', status: 'accepted', created, accepted_date: accepted },
      'body');
    const state = loadDashboardState(hermitDir);
    expect(state.proposals.oldestOpenAccepted?.id).toBe('PROP-010-accepted-100000');
    expect(state.proposals.oldestOpenAccepted?.ageDays).toBe(3); // since accepted, not 40 since created
  }));

  test('splits proposed/accepted (open, with body) from resolved/dismissed (one-liners)', withHermitDir((hermitDir) => {
    writeProposal(hermitDir, 'PROP-001-open-100000.md',
      { id: 'PROP-001-open-100000', title: '"Open one"', status: 'proposed', created: '2026-07-01T10:00:00Z' },
      '## Context\nSome details here.');
    writeProposal(hermitDir, 'PROP-002-accepted-100000.md',
      { id: 'PROP-002-accepted-100000', title: '"Accepted one"', status: 'accepted', created: '2026-06-20T10:00:00Z', accepted_date: '2026-06-21T10:00:00Z' },
      'Accepted body.');
    writeProposal(hermitDir, 'PROP-003-resolved-100000.md',
      { id: 'PROP-003-resolved-100000', title: '"Resolved one"', status: 'resolved', created: '2026-06-01T10:00:00Z' },
      'Resolved body should not appear.');

    const state = loadDashboardState(hermitDir);
    expect(state.proposals.open.map(p => p.id).sort()).toEqual(['PROP-001-open-100000', 'PROP-002-accepted-100000']);
    expect(state.proposals.other.map(p => p.id)).toEqual(['PROP-003-resolved-100000']);

    const open = state.proposals.open.find(p => p.id === 'PROP-001-open-100000')!;
    expect(open.body).toContain('Some details here.');
    // Resolved rows are one-liners: no body field on the ProposalRow shape.
    expect((state.proposals.other[0] as any).body).toBeUndefined();

    expect(state.proposals.oldestOpenAccepted?.id).toBe('PROP-002-accepted-100000');
  }));

  test('caps the "other" (resolved/dismissed) list and reports the omitted count', withHermitDir((hermitDir) => {
    for (let i = 0; i < 25; i++) {
      writeProposal(hermitDir, `PROP-${String(i).padStart(3, '0')}-old-100000.md`,
        { id: `PROP-${String(i).padStart(3, '0')}-old-100000`, title: '"Old"', status: 'resolved', created: '2026-01-01T10:00:00Z' },
        'body');
    }
    const state = loadDashboardState(hermitDir);
    expect(state.proposals.other.length).toBe(20);
    expect(state.proposals.otherOmitted).toBe(5);
  }));

  test('reads latest weekly review and computes deltas against the prior week', withHermitDir((hermitDir) => {
    writeWeekly(hermitDir, '2026-W26', { week: '2026-W26', total_cost_usd: '3.65', self_directed_rate: '0.61' }, 'Prior body.');
    writeWeekly(hermitDir, '2026-W27', {
      week: '2026-W27', total_cost_usd: '3.20', self_directed_rate: '0.64',
      proposals_created: '3', proposals_resolved: '2',
    }, '## Summary\nThis week had **14 sessions**.');

    const state = loadDashboardState(hermitDir);
    expect(state.weekly).not.toBeNull();
    expect(state.weekly!.week).toBe('2026-W27');
    expect(state.weekly!.costUsd).toBeCloseTo(3.20, 5);
    expect(state.weekly!.priorCostUsd).toBeCloseTo(3.65, 5);
    expect(state.weekly!.hasPrior).toBe(true);
    expect(state.weekly!.autonomyPct).toBeCloseTo(64, 5);
    expect(state.weekly!.priorAutonomyPct).toBeCloseTo(61, 5);
    expect(state.weekly!.bodyHtml).toContain('<strong>14 sessions</strong>');
  }));

  test('weekly review with no prior week omits comparison fields', withHermitDir((hermitDir) => {
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27', total_cost_usd: '3.20', self_directed_rate: '0.64' }, 'Body.');
    const state = loadDashboardState(hermitDir);
    expect(state.weekly!.hasPrior).toBe(false);
    expect(state.weekly!.priorCostUsd).toBeNull();
  }));

  test('lastBrief is null when state/last-brief.json is absent', withHermitDir((hermitDir) => {
    const state = loadDashboardState(hermitDir);
    expect(state.lastBrief).toBeNull();
  }));

  test('lastBrief is null when text is blank', withHermitDir((hermitDir) => {
    writeLastBrief(hermitDir, 'morning', '   ');
    const state = loadDashboardState(hermitDir);
    expect(state.lastBrief).toBeNull();
  }));

  test('reads lastBrief kind, text, and generated_at', withHermitDir((hermitDir) => {
    writeLastBrief(hermitDir, 'evening', 'Working on the artifact hub. 3 proposals resolved.', '2026-07-05T22:00:00Z');
    const state = loadDashboardState(hermitDir);
    expect(state.lastBrief?.kind).toBe('evening');
    expect(state.lastBrief?.text).toBe('Working on the artifact hub. 3 proposals resolved.');
    expect(state.lastBrief?.generatedAt).toBe('2026-07-05T22:00:00Z');
  }));

  test('compiledIndex is empty when compiled/ has no docs', withHermitDir((hermitDir) => {
    const state = loadDashboardState(hermitDir);
    expect(state.compiledIndex.docs).toEqual([]);
    expect(state.compiledIndex.omitted).toBe(0);
  }));

  test('compiledIndex excludes review-weekly files and uses frontmatter title when present', withHermitDir((hermitDir) => {
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27' }, 'body');
    writeCompiledDoc(hermitDir, 'architecture-decisions.md', { title: '"Architecture Decisions"' }, 'body');
    writeCompiledDoc(hermitDir, 'no-frontmatter-doc.md', null, 'plain body, no frontmatter');
    const state = loadDashboardState(hermitDir);
    const names = state.compiledIndex.docs.map(d => d.name).sort();
    expect(names).toEqual(['architecture-decisions.md', 'no-frontmatter-doc.md']);
    expect(state.compiledIndex.docs.find(d => d.name === 'architecture-decisions.md')?.title).toBe('Architecture Decisions');
    expect(state.compiledIndex.docs.find(d => d.name === 'no-frontmatter-doc.md')?.title).toBe('no-frontmatter-doc.md');
  }));

  test('compiledIndex caps at 20 and reports the omitted count', withHermitDir((hermitDir) => {
    for (let i = 0; i < 25; i++) {
      writeCompiledDoc(hermitDir, `doc-${String(i).padStart(2, '0')}.md`, null, 'body');
    }
    const state = loadDashboardState(hermitDir);
    expect(state.compiledIndex.docs.length).toBe(20);
    expect(state.compiledIndex.omitted).toBe(5);
  }));

  test('compiledIndex is newest-first by mtime, so a recent doc is not hidden by an alphabetically-late name', withHermitDir((hermitDir) => {
    // 20 older docs whose names sort BEFORE the newest, plus one recent doc whose
    // name sorts LAST — under an alphabetical cap it would fall into the omitted bucket.
    for (let i = 0; i < 20; i++) {
      const f = path.join(hermitDir, 'compiled', `aaa-old-${String(i).padStart(2, '0')}.md`);
      fs.writeFileSync(f, 'body\n');
      fs.utimesSync(f, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    }
    const recent = path.join(hermitDir, 'compiled', 'zzz-newest.md');
    fs.writeFileSync(recent, 'body\n');
    fs.utimesSync(recent, new Date('2026-07-05T00:00:00Z'), new Date('2026-07-05T00:00:00Z'));

    const state = loadDashboardState(hermitDir);
    expect(state.compiledIndex.docs[0].name).toBe('zzz-newest.md');
    expect(state.compiledIndex.omitted).toBe(1);
  }));
});

// ---------- renderDashboard ----------

describe('renderDashboard', () => {
  test('is a self-contained fragment with no doctype/html/head/body wrapper', withHermitDir((hermitDir) => {
    const state = loadDashboardState(hermitDir);
    const { html } = renderDashboard(state, { now: '2026-07-05T09:00:00Z' });
    expect(html).not.toMatch(/<!DOCTYPE/i);
    expect(html).not.toMatch(/<html/i);
    expect(html).not.toMatch(/<head>/i);
    expect(html).not.toMatch(/<body>/i);
    expect(html).toContain('<title>Hermit Dashboard</title>');
  }));

  test('hash is stable across identical state regardless of the "now" timestamp', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'config.json', { agent_name: 'shelly' });
    const state = loadDashboardState(hermitDir);
    const a = renderDashboard(state, { now: '2026-07-05T09:00:00Z' });
    const b = renderDashboard(state, { now: '2026-07-05T10:30:00Z' });
    expect(a.hash).toBe(b.hash);
    expect(a.html).not.toBe(b.html); // displayed timestamp still differs
    expect(a.html).toContain('2026-07-05T09:00:00Z');
    expect(b.html).toContain('2026-07-05T10:30:00Z');
  }));

  test('hash changes when the underlying state changes', withHermitDir((hermitDir) => {
    const before = renderDashboard(loadDashboardState(hermitDir), { now: '2026-07-05T09:00:00Z' });
    writeTodayCost(hermitDir, 1.23, 5000);
    const after = renderDashboard(loadDashboardState(hermitDir), { now: '2026-07-05T09:00:00Z' });
    expect(before.hash).not.toBe(after.hash);
  }));

  test('never embeds config env values', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'config.json', {
      agent_name: 'shelly',
      env: { HERMIT_SECRET_TOKEN: 'super-secret-value-should-not-leak' },
    });
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).not.toContain('super-secret-value-should-not-leak');
    expect(html).not.toContain('HERMIT_SECRET_TOKEN');
  }));

  test('still never embeds config env values when a brief is present', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'config.json', {
      agent_name: 'shelly',
      env: { HERMIT_SECRET_TOKEN: 'super-secret-value-should-not-leak' },
    });
    writeLastBrief(hermitDir, 'morning', 'Brief text mentioning nothing sensitive.');
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).not.toContain('super-secret-value-should-not-leak');
    expect(html).not.toContain('HERMIT_SECRET_TOKEN');
  }));

  test('renders the latest brief section, safely escaping markdown', withHermitDir((hermitDir) => {
    writeLastBrief(hermitDir, 'morning', 'Working on **the hub**. <script>alert(1)</script>');
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('Latest brief');
    expect(html).toContain('(morning)');
    expect(html).toContain('<strong>the hub</strong>');
    expect(html).not.toContain('<script>alert(1)</script>');
  }));

  test('brief section shows when it was generated, so a stale brief is not undated', withHermitDir((hermitDir) => {
    writeLastBrief(hermitDir, 'morning', 'Brief body.', '2026-07-05T08:00:00Z');
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('2026-07-05T08:00:00Z');
  }));

  test('renders the compiled-docs index, capped, excluding weekly-review files', withHermitDir((hermitDir) => {
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27' }, 'body');
    writeCompiledDoc(hermitDir, 'architecture-decisions.md', { title: '"Architecture Decisions"' }, 'body');
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('Architecture Decisions');
    expect(html).toContain('architecture-decisions.md');
    expect(html).not.toContain('review-weekly-2026-W27.md');
  }));

  test('renders open proposals as expandable details and history as one-liners', withHermitDir((hermitDir) => {
    writeProposal(hermitDir, 'PROP-001-open-100000.md',
      { id: 'PROP-001-open-100000', title: '"Open one"', status: 'proposed', created: '2026-07-01T10:00:00Z' },
      'Full body text for the open proposal.');
    writeProposal(hermitDir, 'PROP-002-resolved-100000.md',
      { id: 'PROP-002-resolved-100000', title: '"Resolved one"', status: 'resolved', created: '2026-06-01T10:00:00Z' },
      'Body that must not appear on the page.');

    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('<details class="proposal">');
    expect(html).toContain('Full body text for the open proposal.');
    expect(html).not.toContain('Body that must not appear on the page.');
    expect(html).toContain('PROP-002-resolved-100000');
  }));

  test('shows placeholder copy for empty proposals and missing weekly review', withHermitDir((hermitDir) => {
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('No open proposals.');
    expect(html).toContain('No weekly review yet.');
    expect(html).toContain('No active alerts.');
  }));
});
