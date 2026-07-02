/**
 * search.ts — full-text search lib over hermit state: sessions/, compiled/,
 * proposals/ (files, Node stdlib only) plus the episodic channel log
 * (state/channel-log.sqlite, PROP-010) as a fourth source when present.
 *
 * Usage as lib:   require('./search').search(hermitDir, query, opts) => results[]
 *
 * results: Array<{ path, relPath, type, title, date, score, snippets, channel? }>
 *   snippets: Array<{ line, startLine, text }>: matching line plus surrounding context.
 *     line/startLine are file-relative (frontmatter offset included), so file:line resolves.
 *     Channel-log hits (type:'channel') carry a bounded excerpt instead and set
 *     `channel: { source, chat_id, direction, sender }` — untrusted, operator-authored
 *     external input, not a file the printer should render a `:line` ref for.
 *
 * opts: { type?: string, since?: string (ISO date), limit?: number }
 */

import path from 'node:path';
import { globDirRecursive, readFileWithFrontmatter } from './frontmatter';
import { searchLog } from './channel-log';
import { safeForLLM } from './sanitize';

type Json = any;

// Weight multiplier for a term hit in a frontmatter field (vs. plain body hit)
const FM_BOOST = 5;
// Max snippets returned per file
const MAX_SNIPPETS_PER_FILE = 3;
// Max chars per snippet context block
const SNIPPET_MAX_CHARS = 200;
// Soft recency half-life in days (0 days → 1.0; this many days → ~0.5)
const RECENCY_HALF_LIFE_DAYS = 180;
// Candidate rows pulled from the channel log before scoring/sorting
const CHANNEL_CANDIDATE_LIMIT = 200;
// Max chars per channel excerpt (channel text has no lines to snip around)
const CHANNEL_EXCERPT_MAX_CHARS = 200;

/**
 * Extract the best available date string from a frontmatter object.
 * Tries keys in priority order; returns null if none found.
 */
function extractDate(fm: Json): string | null {
  for (const key of ['updated', 'created', 'date', 'accepted_date', 'start_date']) {
    if (fm[key] && typeof fm[key] === 'string') return fm[key];
  }
  return null;
}

/**
 * Recency multiplier [0..1]. Exponential half-life decay from RECENCY_HALF_LIFE_DAYS.
 * Unparseable date → neutral (0.5).
 */
function recencyBoost(dateStr: string | null): number {
  if (!dateStr) return 0.5;
  const ms = Date.parse(dateStr);
  if (isNaN(ms)) return 0.5;
  const daysSince = Math.max(0, (Date.now() - ms) / (1000 * 60 * 60 * 24));
  return Math.pow(0.5, daysSince / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Tokenize a string into lowercase terms of length >= 2.
 * Strips non-alphanumeric chars except hyphens and underscores.
 */
function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^a-z0-9_-]/g, ''))
    .filter(t => t.length >= 2);
}

/**
 * Count overlapping occurrences of all terms in text (case-insensitive).
 */
function countHits(text: string, terms: string[]): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    let idx = 0;
    while ((idx = lower.indexOf(term, idx)) !== -1) {
      hits++;
      idx += term.length;
    }
  }
  return hits;
}

/**
 * Extract up to MAX_SNIPPETS_PER_FILE snippets from body for matching lines.
 * Each snippet includes the matching line + one line of context above and below.
 * lineOffset is the number of lines preceding `body` in the source file (frontmatter
 * + stripped leading blanks) so the returned line numbers resolve against the real file.
 * Returns Array<{ line, startLine, text }>; both line numbers are 1-indexed, file-relative.
 */
function extractSnippets(body: string, terms: string[], lineOffset: number): Array<{ line: number; startLine: number; text: string }> {
  const lines = (body || '').split('\n');
  const snippets: Array<{ line: number; startLine: number; text: string }> = [];

  for (let i = 0; i < lines.length && snippets.length < MAX_SNIPPETS_PER_FILE; i++) {
    const lower = lines[i].toLowerCase();
    if (!terms.some(t => lower.includes(t))) continue;

    const contextStart = Math.max(0, i - 1);
    const contextEnd = Math.min(lines.length - 1, i + 1);
    const contextText = lines.slice(contextStart, contextEnd + 1).join('\n');
    const text = contextText.slice(0, SNIPPET_MAX_CHARS).trimEnd();

    snippets.push({
      line: lineOffset + i + 1,
      startLine: lineOffset + contextStart + 1,
      text,
    });
  }
  return snippets;
}

/**
 * Bounded excerpt centered on the first matching term, so a long channel
 * message doesn't dump its full text (capped elsewhere at 8KB) into a result.
 * Falls back to the leading chars when no term substring is found (FTS5
 * tokenization can match a row our own substring scan doesn't hit exactly).
 */
function excerptAround(text: string, terms: string[], maxChars: number): string {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) return text.slice(0, maxChars).trim();
  const start = Math.max(0, idx - Math.floor(maxChars / 2));
  return text.slice(start, start + maxChars).trim();
}

/**
 * Full-text search over sessions/, compiled/, and proposals/ in hermitDir.
 *
 * @param {string} hermitDir - hermit state directory (e.g. .claude-code-hermit)
 * @param {string} query - search query
 * @param {object} [opts]
 * @param {string}  [opts.type]  - filter by compiled/proposal `type` frontmatter field
 * @param {string}  [opts.since] - ISO date string; exclude files older than this date
 * @param {number}  [opts.limit] - max results to return (default 10)
 * @returns {Array<{path, relPath, type, title, date, score, snippets}>}
 */
function search(hermitDir: string, query: string, opts?: Json): Json[] {
  const o = opts || {};
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const limit = typeof o.limit === 'number' ? o.limit : 10;
  const since = o.since ? Date.parse(o.since) : null;
  const typeFilter = o.type || null;

  const dirs = [
    path.join(hermitDir, 'sessions'),
    path.join(hermitDir, 'compiled'),
    path.join(hermitDir, 'proposals'),
  ];

  const results: Json[] = [];

  for (const dir of dirs) {
    const files = globDirRecursive(dir);
    for (const filePath of files) {
      const r = readFileWithFrontmatter(filePath);
      if (!r) continue;
      const fm = r.fm || {};
      const body = r.body || '';

      // Type filter (applies when the artifact has a type field)
      if (typeFilter && fm.type && fm.type !== typeFilter) continue;

      // Date filter — files without a parseable date are kept (undated history
      // shouldn't silently vanish under --since).
      const dateStr = extractDate(fm);
      if (since && dateStr) {
        const fileMs = Date.parse(dateStr);
        if (fileMs && fileMs < since) continue;
      }

      // Score: frontmatter field hits (boosted) + body hits
      const fmText = [
        fm.title || '',
        Array.isArray(fm.tags) ? fm.tags.join(' ') : fm.tags || '',
        fm.summary || '',
        fm.task || '',
      ].join(' ');

      const rawScore = countHits(fmText, terms) * FM_BOOST + countHits(body, terms);
      if (rawScore === 0) continue;

      const score = rawScore * recencyBoost(dateStr);
      // body is a suffix of content (frontmatter stripped, then trimStart); the prefix
      // length gives the file-relative line offset so snippet line numbers resolve.
      const lineOffset = r.content ? r.content.slice(0, r.content.length - body.length).split('\n').length - 1 : 0;
      const snippets = extractSnippets(body, terms, lineOffset);
      const relPath = path.relative(hermitDir, filePath);

      // Derive type label: prefer frontmatter type, fall back to parent dir name
      const typeLabel = fm.type || relPath.split(path.sep)[0] || 'unknown';

      results.push({
        path: filePath,
        relPath,
        type: typeLabel,
        title: fm.title || path.basename(filePath, '.md'),
        date: dateStr ? dateStr.slice(0, 10) : null,
        score,
        snippets,
      });
    }
  }

  // Channel log — fourth source (episodic tier, PROP-010). searchLog()
  // feature-detects the DB: no channel traffic yet → [] → this contributes
  // nothing, matching the "inert until a channel first delivers a message"
  // guarantee. A type filter that isn't 'channel' excludes this source
  // entirely, same as the dirs loop above excludes non-matching fm.type.
  if (!typeFilter || typeFilter === 'channel') {
    const rows = searchLog(hermitDir, terms, { since: o.since, limit: CHANNEL_CANDIDATE_LIMIT });
    for (const row of rows) {
      // searchLog already matched this row via FTS5 (token/phrase/diacritic-fold
      // semantics), so keep it even when our substring countHits can't re-find
      // the term — e.g. query "foo-bar" matching stored "foo bar", or "cafe"
      // matching "café". Floor the score at 1 so an FTS-only hit still ranks,
      // and let excerptAround fall back to a leading slice.
      const score = Math.max(1, countHits(row.text, terms)) * recencyBoost(row.ts);
      const excerpt = safeForLLM(excerptAround(row.text, terms, CHANNEL_EXCERPT_MAX_CHARS));

      results.push({
        path: null,
        relPath: `channel:${row.source}:${row.chat_id}`,
        type: 'channel',
        title: safeForLLM(`${row.direction === 'in' ? 'from' : 'to'} ${row.source} (${row.chat_id})`),
        date: row.ts ? row.ts.slice(0, 10) : null,
        score,
        snippets: [{ line: null, startLine: null, text: excerpt }],
        channel: {
          source: row.source,
          chat_id: row.chat_id,
          direction: row.direction,
          sender: row.sender,
        },
      });
    }
  }

  results.sort((a: Json, b: Json) => b.score - a.score);
  return results.slice(0, limit);
}

export { search };
