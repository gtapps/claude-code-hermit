// UI-chrome string table for the script-rendered artifact pages (dashboard,
// proposals). The renderers stay deterministic and model-free per publish
// (see docs/artifacts.md): language arrives as *input state*, not per-render
// model work — mirroring state/last-brief.json (model-composed once, rendered
// deterministically forever). DEFAULT_STRINGS is English; loadStrings() overlays
// an operator-language table (written once at language-set time) per key, so a
// missing key or an absent file falls back to English and byte-identical output.
//
// Convention: DEFAULT_STRINGS values are trusted (hardcoded, no HTML markup) and
// injected raw by the renderers; an overlay value is file-derived, so loadStrings()
// escapes it the same way renderer-side data (proposal ids/titles, agent name,
// alert text) already is — a corrupt or malformed translation file can't inject
// markup into a published page. Parameterized strings use {placeholder} tokens so
// word order stays translatable; fill them with fmt() (escaping doesn't touch braces).

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_STRINGS = {
  // Page shell / shared chrome
  dashboard_title: 'Hermit Dashboard',
  dashboard_header: '{name} — Hermit Dashboard',
  proposals_page_title: 'Hermit Proposals',
  proposals_page_header: 'Proposals',
  label_updated: 'updated',
  footer: 'Rendered by claude-code-hermit — script-generated, not model-authored.',

  // Status card
  status_heading: 'Status',
  status_session: 'Session',
  status_today: 'Today',
  status_alerts: 'Alerts',
  status_no_alerts: 'No active alerts.',

  // Budget-alert synthesis (message-less budget alerts)
  budget_text: '{period} budget {state}{amounts}',
  budget_state_breached: 'breached',
  budget_state_warning: 'warning',
  budget_amounts: ' ({spend} of {cap})',

  // Age labels
  age_today: 'today',
  age_days: '{n}d',

  // Brief card
  brief_heading: 'Latest brief',
  brief_none: 'No brief yet.',

  // Proposals card (dashboard)
  proposals_heading: 'Proposals',
  proposals_none_open: 'No open proposals.',
  proposals_oldest_accepted: 'Oldest open accepted: {id}{age}',
  proposals_since_accepted: ' ({age} since accepted)',

  // Proposals page
  proposals_history: 'History',
  proposals_open_count: '{n} Open',

  // Weekly card
  weekly_heading: "This week's evolution",
  weekly_none: 'No weekly review yet.',
  weekly_week: 'Week {week}',
  weekly_cost: 'Cost: {amount}{delta}',
  weekly_autonomy: 'Autonomy: {pct} self-directed{delta}',
  weekly_proposals: 'Proposals: +{created} created, {resolved} resolved',
  weekly_full_review: 'Full review',
  weekly_delta_cost: ' (vs {prior} prior, {sign}{pct}%)',
  weekly_delta_cost_no_pct: ' (vs {prior} prior)',
  weekly_delta_pp: ' (vs {prior}% prior, {sign}{diff}pp)',

  // Compiled-docs card
  compiled_heading: 'Compiled docs',
  compiled_none: 'Nothing compiled yet.',
  compiled_hint: 'Ask to open any of these as a page.',

  // Shared
  common_more_not_shown: '+{n} more not shown',
};

export type ArtifactStrings = typeof DEFAULT_STRINGS;

// Local copy of dashboard.ts's escapeHtml — that file already imports from this
// one, so importing it back would be circular. Kept in sync by the shared
// five-char HTML-escape contract; not worth a third shared module for one line.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Overlay state/artifact-strings.json over the English defaults, per key. Missing
 *  keys fall back to English; unknown keys are ignored; an absent or invalid file
 *  yields the pristine defaults (byte-identical to a hermit with no translation).
 *  Overlay values are escaped (defaults are not — they're trusted literals). */
export function loadStrings(hermitDir: string): ArtifactStrings {
  const merged: ArtifactStrings = { ...DEFAULT_STRINGS };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(hermitDir, 'state', 'artifact-strings.json'), 'utf8'));
    const overlay = raw?.strings;
    if (overlay && typeof overlay === 'object') {
      for (const key of Object.keys(DEFAULT_STRINGS) as (keyof ArtifactStrings)[]) {
        const v = overlay[key];
        if (typeof v === 'string') merged[key] = escapeHtml(v);
      }
    }
  } catch {
    // absent/unreadable/invalid JSON -> English defaults
  }
  return merged;
}

/** Fill {placeholder} tokens in a chrome template. Unmatched tokens are left
 *  intact rather than blanked, so a malformed translation degrades visibly. */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
