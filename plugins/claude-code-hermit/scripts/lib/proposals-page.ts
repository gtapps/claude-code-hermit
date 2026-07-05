// Deterministic renderer for the Hermit Proposals-page artifact — mirrors
// scripts/lib/dashboard.ts's render/hash-gate discipline (see docs/artifacts.md).
// Full text for open (proposed/accepted) proposals, each in its own anchored
// <section id="prop-nnn"> for deep-linking from channel messages; deferred/
// resolved/dismissed proposals are one-line history entries, same bucket the
// dashboard already computes. Self-contained fragment — no
// <!DOCTYPE>/<html>/<head>/<body> (Artifact tool wraps it).

import { loadProposals, mdToHtml, escapeHtml, CSS, chip, type ProposalRow, type OpenProposalRow } from './dashboard';
import { sha256 } from './hash';

const UPDATED_TOKEN = '__PROPOSALS_PAGE_UPDATED__';

export interface ProposalsPageState {
  open: OpenProposalRow[];
  other: ProposalRow[];
  otherOmitted: number;
}

export function loadProposalsPageState(hermitDir: string): ProposalsPageState {
  const { open, other, otherOmitted } = loadProposals(hermitDir);
  return { open, other, otherOmitted };
}

// "PROP-025-some-slug-123243" -> "prop-025". Falls back to a full slugified id
// for legacy rows with no PROP-NNN prefix.
export function proposalAnchorId(id: string): string {
  const m = id.match(/^(PROP-\d+)/i);
  const base = m ? m[1] : id;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function createdLabel(created: string | null): string {
  if (!created) return '';
  return ` <span class="muted">(${escapeHtml(created)})</span>`;
}

function renderOpen(open: OpenProposalRow[]): string {
  if (!open.length) return `<p class="muted">No open proposals.</p>`;
  return open
    .map(p => `<section class="card" id="${proposalAnchorId(p.id)}">
      <h2>${chip(p.status)} ${escapeHtml(p.id)}</h2>
      <p>${escapeHtml(p.title)}${createdLabel(p.created)}</p>
      <div class="proposal-body">${mdToHtml(p.body)}</div>
    </section>`)
    .join('');
}

function renderOther(other: ProposalRow[], otherOmitted: number): string {
  if (!other.length) return '';
  const items = other
    .map(p => `<li>${chip(p.status)} <strong>${escapeHtml(p.id)}</strong> — ${escapeHtml(p.title)}${createdLabel(p.created)}</li>`)
    .join('');
  const omittedLine = otherOmitted > 0 ? `<li class="muted">+${otherOmitted} more not shown</li>` : '';
  return `
    <section class="card">
      <h2>History</h2>
      <ul class="proposal-history">${items}${omittedLine}</ul>
    </section>`;
}

/** Renders the full artifact fragment plus a content hash stable across
 *  identical underlying state (the "last updated" stamp is excluded from the hash
 *  via a placeholder token, so the publish gate can skip no-op republishes).
 *  Deliberately omits proposal age-in-days (unlike the dashboard) — age is
 *  Date.now()-derived and would otherwise mint a new artifact version once a
 *  day even with zero proposal activity; created-date is shown instead. */
export function renderProposalsPage(state: ProposalsPageState, opts?: { now?: string }): { html: string; hash: string } {
  const templated = `<title>Hermit Proposals</title>
<style>${CSS}</style>
<div class="hermit-page">
  <header>
    <h1>Proposals</h1>
    <span class="updated">updated ${UPDATED_TOKEN}</span>
  </header>
  ${renderOpen(state.open)}
  ${renderOther(state.other, state.otherOmitted)}
  <footer class="hermit-footer">Rendered by claude-code-hermit — script-generated, not model-authored.</footer>
</div>
`;

  const hash = sha256(templated);
  const now = opts?.now ?? new Date().toISOString();
  const html = templated.replace(UPDATED_TOKEN, escapeHtml(now));
  return { html, hash };
}
