// resolve-prop.ts — resolves an operator's PROP-id input to a proposal filename.
// Usage: bun resolve-prop.ts <hermit-state-dir> <operator-input>
// Output (stdout, one line):
//   MATCH|<filename>
//   AMBIGUOUS|<json array of {file, title}>
//   NONE|not-a-prop-id
//   NONE|no-match
// Exit 0 always — resolution failures are reported via the verdict token, not exit code.
// Implements proposal-act/SKILL.md § Resolving a Proposal ID. Glob matching is
// case-insensitive: step 1 uppercases the whole input (including any slug suffix),
// while real proposal filenames carry a lowercase slug — case-insensitive matching
// is required for the suffix form to ever match a real file.

import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter } from './lib/frontmatter';
import { emit } from './lib/cli';

const stateDir = process.argv[2];
const rawInput = process.argv[3];

if (!stateDir || rawInput === undefined) emit('NONE|not-a-prop-id');

const input = rawInput.trim().toUpperCase();
const m = input.match(/^PROP-(\d+)(?:-(.+))?$/);
if (!m) emit('NONE|not-a-prop-id');

const num = m![1].padStart(3, '0');
const suffix = m![2];

const proposalsDir = path.join(stateDir, 'proposals');
let files: string[] = [];
try {
  files = fs.readdirSync(proposalsDir).filter(f => f.endsWith('.md')).sort();
} catch {
  emit('NONE|no-match');
}

// Anchored glob → regex. Never a bare `PROP-NNN*` — that collides with 4-digit NNN
// filenames (e.g. `PROP-0061.md`) once proposal counts cross 1000.
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

let matches: string[];
if (!suffix) {
  const legacy = globToRegExp(`PROP-${num}.md`);
  const newFormat = globToRegExp(`PROP-${num}-*.md`);
  matches = files.filter(f => legacy.test(f) || newFormat.test(f));
} else {
  const pattern = globToRegExp(`PROP-${num}-*${suffix}*.md`);
  matches = files.filter(f => pattern.test(f));
}

if (matches.length === 0) emit('NONE|no-match');
if (matches.length === 1) emit(`MATCH|${matches[0]}`);

const payload = matches.map(f => ({
  file: f,
  title: readFrontmatter(path.join(proposalsDir, f))?.title ?? null,
}));
emit(`AMBIGUOUS|${JSON.stringify(payload)}`);
