// Structural invariants for SKILL.md files in claude-code-error-hermit.
// Run with: bun tests/skill-structure.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, makeReporter } from './test-utils';

const SKILL_DIR = path.join(import.meta.dir, '..', 'skills');

const SKILLS = [
  { name: 'hatch', gates: 0 },
  { name: 'error-triage', gates: 0 },
  { name: 'error-reproduce', gates: 0 },
  { name: 'error-draft-fix', gates: 0 },
];

const { ok, summary } = makeReporter();

for (const { name, gates } of SKILLS) {
  console.log(`\n${name}/SKILL.md:`);
  const file = path.join(SKILL_DIR, name, 'SKILL.md');
  ok('file exists', fs.existsSync(file), file);
  if (!fs.existsSync(file)) continue;

  const text = fs.readFileSync(file, 'utf-8');
  const fm = parseFrontmatter(text);
  ok('frontmatter parseable', fm !== null);
  if (!fm) continue;

  ok('frontmatter has name', !!fm.fields.name, JSON.stringify(fm.fields));
  ok('frontmatter name matches dir', fm.fields.name === name, `${fm.fields.name} vs ${name}`);
  ok('frontmatter has description', !!fm.fields.description && fm.fields.description.length > 20);

  const gateMatches = fm.body.match(/^### Gate \d+ —/gm) || [];
  ok(`expected ${gates} Gate headers`, gateMatches.length === gates, `found ${gateMatches.length}`);

  if (gates > 0) {
    ok('Gate 0 present', /^### Gate 0 —/m.test(fm.body));
    ok(`Gate ${gates - 1} present`, new RegExp(`^### Gate ${gates - 1} —`, 'm').test(fm.body));
  }

  // Internal links: resolve [text](relative/path) and verify the target exists.
  const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
  const skillBaseDir = path.dirname(file);
  let linkMatch: RegExpExecArray | null;
  let linksChecked = 0;
  let linksBad = 0;
  while ((linkMatch = linkRe.exec(fm.body)) !== null) {
    const target = linkMatch[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const cleanTarget = target.split('#')[0];
    if (!cleanTarget) continue;
    const resolved = path.resolve(skillBaseDir, cleanTarget);
    linksChecked += 1;
    if (!fs.existsSync(resolved)) {
      linksBad += 1;
      console.error(`    bad link: ${target} → ${resolved}`);
    }
  }
  ok(`internal links resolve (${linksChecked} checked)`, linksBad === 0, `${linksBad} bad`);
}

process.exit(summary() === 0 ? 0 : 1);
