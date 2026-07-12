// Deterministic renderer for the Hermit Proposals-page artifact — mirrors
// scripts/lib/dashboard.ts's render/hash-gate discipline (see docs/artifacts.md).
// Open (proposed/accepted) proposals render as collapsed-by-default
// <details class="proposal" id="prop-nnn"> — a one-line summary that expands to
// full text on click, each anchored for deep-linking from channel messages;
// deferred/resolved/dismissed proposals are one-line history entries, same bucket the
// dashboard already computes. Self-contained fragment — no
// <!DOCTYPE>/<html>/<head>/<body> (Artifact tool wraps it).

import { loadProposals, mdToHtml, escapeHtml, CSS, proposalLabel, type ProposalRow, type OpenProposalRow } from './dashboard';
import { sha256 } from './hash';
import { loadStrings, fmt, type ArtifactStrings } from './artifact-strings';

const UPDATED_TOKEN = '__PROPOSALS_PAGE_UPDATED__';

export interface ProposalsPageState {
  open: OpenProposalRow[];
  other: ProposalRow[];
  otherOmitted: number;
  strings: ArtifactStrings;
}

export function loadProposalsPageState(hermitDir: string): ProposalsPageState {
  const { open, other, otherOmitted } = loadProposals(hermitDir);
  return { open, other, otherOmitted, strings: loadStrings(hermitDir) };
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

function renderOpen(open: OpenProposalRow[], s: ArtifactStrings): string {
  if (!open.length) return `<p class="muted">${s.proposals_none_open}</p>`;
  const items = open
    .map(p => `<details class="proposal" id="${proposalAnchorId(p.id)}">
      <summary>${proposalLabel(p, createdLabel(p.created))}</summary>
      <div class="proposal-body">${mdToHtml(p.body)}</div>
    </details>`)
    .join('');
  return `<section class="card">
    <h2>${fmt(s.proposals_open_count, { n: open.length })}</h2>
    ${items}
  </section>`;
}

function renderOther(other: ProposalRow[], otherOmitted: number, s: ArtifactStrings): string {
  if (!other.length) return '';
  const items = other
    .map(p => `<li>${proposalLabel(p, createdLabel(p.created))}</li>`)
    .join('');
  const omittedLine = otherOmitted > 0 ? `<li class="muted">${fmt(s.common_more_not_shown, { n: otherOmitted })}</li>` : '';
  return `
    <section class="card">
      <h2>${s.proposals_history}</h2>
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
  const s = state.strings;
  const templated = `<title>${s.proposals_page_title}</title>
<style>${CSS}</style>
<div class="hermit-page">
  <header>
    <h1>${s.proposals_page_header}</h1>
    <span class="updated">${s.label_updated} ${UPDATED_TOKEN}</span>
  </header>
  ${renderOpen(state.open, s)}
  ${renderOther(state.other, state.otherOmitted, s)}
  <footer class="hermit-footer">${s.footer}</footer>
</div>
`;

  const hash = sha256(templated);
  const now = opts?.now ?? new Date().toISOString();
  const html = templated.replace(UPDATED_TOKEN, escapeHtml(now));
  return { html, hash };
}
