'use strict';

// Structural invariants for SKILL.md files in claude-code-fitness-hermit.
// Run with: node tests/skill-structure.test.js
//
// What this checks (and what it does NOT):
//   ✓ Frontmatter present and parseable; `name` and `description` set.
//   ✓ Frontmatter `name` matches the parent directory name.
//   ✓ Expected gate count (and Gate 0/Gate N-1 markers visible).
//   ✓ Internal markdown links resolve to existing on-disk files.
// We do NOT execute the skill or assert on its prose semantics — that's the
// LLM's job at runtime. This is structural lint only.

const fs = require('fs');
const path = require('path');
const { parseFrontmatter, makeReporter } = require('./test-utils');

const SKILL_DIR = path.join(__dirname, '..', 'skills');

// Per-skill expectations. Update if a skill's gate count changes.
// gates: 0 → skill has no Gate N — section structure (e.g., read-only status skills).
const SKILLS = [
  { name: 'domain-brainstorm', gates: 5 }, // Gate 0..4
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

  // Count Gate headers in the body.
  const gateMatches = fm.body.match(/^### Gate \d+ —/gm) || [];
  ok(`expected ${gates} Gate headers`, gateMatches.length === gates, `found ${gateMatches.length}`);

  // First and last gate present — only when the skill is gate-shaped.
  if (gates > 0) {
    ok('Gate 0 present', /^### Gate 0 —/m.test(fm.body));
    ok(`Gate ${gates - 1} present`, new RegExp(`^### Gate ${gates - 1} —`, 'm').test(fm.body));
  }

  // Internal links: resolve [text](relative/path) and verify the target exists.
  // Skip absolute URLs (http://, mailto:) and same-document anchors (#section).
  const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
  const skillBaseDir = path.dirname(file);
  let linkMatch;
  let linksChecked = 0;
  let linksBad = 0;
  while ((linkMatch = linkRe.exec(fm.body)) !== null) {
    const target = linkMatch[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    // Strip any anchor suffix.
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
