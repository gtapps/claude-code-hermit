// next-prop-id.ts — generates the next canonical proposal ID + filename stem.
// Usage (argv):  bun next-prop-id.ts <hermit-state-dir> '<title>'
// Usage (stdin): bun next-prop-id.ts <hermit-state-dir> <<'HERMIT_TITLE'
//                <title>
//                HERMIT_TITLE
//   — stdin required when the title contains an apostrophe (dual-mode convention,
//     matches append-metrics.ts).
// Output (stdout, one line): PROP-NNN-<slug>-HHMMSS
// Exit 1 (+ stderr) on a missing state dir, or on exhausting the same-second
// collision-suffix range — creation should never proceed with a guessed ID.
// Implements proposal-create/SKILL.md § How to Create steps 1-2 (ID + slug +
// same-second collision guard).

import fs from 'node:fs';
import path from 'node:path';
import { nowHHMMSS } from './lib/time';
import { readStdin, readJson } from './lib/cli';

const stateDir = process.argv[2];

if (!stateDir) {
  console.error("Usage: bun next-prop-id.ts <hermit-state-dir> '<title>'");
  process.exit(1);
}

function nextNumber(proposalsDir: string): string {
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

function slugify(title: string): string {
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

function readTitle(): Promise<string> {
  if (process.argv[3] !== undefined) return Promise.resolve(process.argv[3]);
  return readStdin().then(s => s.trim());
}

(async () => {
  if (!fs.existsSync(stateDir)) {
    console.error(`Error: state dir not found: ${stateDir}`);
    process.exit(1);
  }

  const proposalsDir = path.join(stateDir, 'proposals');
  const title = await readTitle();
  const config = readJson(path.join(stateDir, 'config.json')) ?? {};
  const timezone = config.timezone || 'UTC';

  const num = nextNumber(proposalsDir);
  const slug = slugify(title);
  const hhmmss = nowHHMMSS(timezone);

  const suffixLetters = 'abcdefghijklmnopqrstuvwxyz';
  let suffix = '';
  let i = -1;
  while (true) {
    const candidateId = `PROP-${num}-${slug}-${hhmmss}${suffix}`;
    if (!fs.existsSync(path.join(proposalsDir, `${candidateId}.md`))) {
      process.stdout.write(candidateId + '\n');
      process.exit(0);
    }
    i++;
    if (i >= suffixLetters.length) {
      console.error('Error: exhausted same-second collision suffixes (a-z)');
      process.exit(1);
    }
    suffix = suffixLetters[i];
  }
})();
