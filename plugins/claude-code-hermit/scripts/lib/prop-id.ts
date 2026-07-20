// lib/prop-id.ts — proposal ID assignment (number + slug + timestamp + collision
// suffix). Extracted from next-prop-id.ts so proposal.ts's create verb can claim
// an ID and write the file as one atomic operation (next-prop-id.ts's separate
// assign-then-write flow allows a half-created state: a burned ID with no file).

import fs from 'node:fs';
import path from 'node:path';
import { nowHHMMSS } from './time';
import { readJson } from './cli';

export function nextNumber(proposalsDir: string): string {
  let files: string[] = [];
  try { files = fs.readdirSync(proposalsDir); } catch { files = []; }
  let max = 0;
  for (const f of files) {
    const m = f.match(/^PROP-(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(3, '0');
}

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'by', 'from', 'as', 'is', 'are']);

export function slugify(title: string): string {
  // a. drop non-ASCII, lowercase
  const ascii = title.replace(/[^\x00-\x7F]/g, '').toLowerCase();
  // b. runs of non-[a-z0-9] -> single space
  const spaced = ascii.replace(/[^a-z0-9]+/g, ' ').trim();
  const allTokens = spaced.split(/\s+/).filter(Boolean);
  // c-d. drop stopwords; fall back to the pre-filter token list if that empties it
  const filtered = allTokens.filter(t => !STOPWORDS.has(t));
  const tokens = filtered.length > 0 ? filtered : allTokens;
  // e. first 5 tokens, join, truncate to 40 chars at a word boundary
  let slug = tokens.slice(0, 5).join('-');
  if (slug.length > 40) {
    const parts = slug.split('-');
    while (parts.length > 1 && parts.join('-').length > 40) parts.pop();
    slug = parts.join('-');
    if (slug.length > 40) slug = slug.slice(0, 40); // single token exceeds 40: hard-cut
  }
  // f. empty slug -> literal fallback; never a double dash
  return slug || 'proposal';
}

export interface PropIdParts {
  id: string;
  num: string;
  slug: string;
  hhmmss: string;
  suffix: string;
}

export const SUFFIX_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export function readTimezone(stateDir: string): string {
  const config = readJson(path.join(stateDir, 'config.json'));
  return config?.timezone || 'UTC';
}

export interface BaseId {
  num: string;
  slug: string;
  hhmmss: string;
}

// The un-suffixed, un-claimed parts of the next ID — shared by both suffix
// strategies below. `now` is injectable so callers can pin `created` and the
// `HHMMSS` suffix to the same instant (decision 7) and so collision behavior
// is deterministically testable.
export function computeBase(
  stateDir: string,
  title: string,
  now: Date = new Date(),
  timezone: string = readTimezone(stateDir),
): BaseId {
  const proposalsDir = path.join(stateDir, 'proposals');
  return {
    num: nextNumber(proposalsDir),
    slug: slugify(title),
    hhmmss: nowHHMMSS(timezone, now),
  };
}

// existsSync suffix walk over a FIXED base — separated from computeBase so
// the collision-suffix branch is unit-testable without the num recomputation
// that a fresh computeBase call would trigger (any pre-seeded collision file
// also matches computeBase's own NNN scan, which would shift `num` before
// the walk ever runs). Returns null once the a-z suffix range is exhausted.
export function resolveSuffix(proposalsDir: string, base: BaseId): PropIdParts | null {
  let suffix = '';
  let i = -1;
  while (true) {
    const candidateId = `PROP-${base.num}-${base.slug}-${base.hhmmss}${suffix}`;
    if (!fs.existsSync(path.join(proposalsDir, `${candidateId}.md`))) {
      return { id: candidateId, num: base.num, slug: base.slug, hhmmss: base.hhmmss, suffix };
    }
    i++;
    if (i >= SUFFIX_LETTERS.length) return null;
    suffix = SUFFIX_LETTERS[i];
  }
}

// Predicts the next canonical ID — used only by next-prop-id.ts, which hands
// the ID to a separate caller that writes the file later (a TOCTOU gap this
// script's own callers no longer have). The create verb in proposal.ts does
// NOT use this: it claims the ID atomically via exclusive file create (see
// proposal.ts), looping the same suffix alphabet against write failures
// (EEXIST) rather than a pre-check.
export function nextPropId(stateDir: string, title: string, now: Date = new Date()): PropIdParts | null {
  const proposalsDir = path.join(stateDir, 'proposals');
  return resolveSuffix(proposalsDir, computeBase(stateDir, title, now));
}
