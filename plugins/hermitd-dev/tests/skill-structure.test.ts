// Structural invariants for the new SKILL.md files.
// Run with: bun tests/skill-structure.test.ts
// The shared checks live in tests/lib/skill-lint.ts; this file holds the
// expectations and the dev-only script-reference check.

import fs from 'node:fs';
import path from 'node:path';
import { makeReporter, lintSkills } from '../../../tests/lib/skill-lint';

const PLUGIN_ROOT = path.join(import.meta.dir, '..');
const SKILL_DIR = path.join(PLUGIN_ROOT, 'skills');

// Per-skill expectations. Update if a skill's gate count changes.
// gates: 0 → skill has no Gate N — section structure (e.g., read-only status skills).
const SKILLS = [
  { name: 'domain-brainstorm', gates: 5 }, // Gate 0..4
];

const { ok, summary } = makeReporter();

console.log('\nskill structure:');
const lintFailures = lintSkills(PLUGIN_ROOT, SKILLS);
ok(`${SKILLS.length} skills pass structural lint`, lintFailures.length === 0, lintFailures.join('; '));

// Every ${CLAUDE_PLUGIN_ROOT}/scripts/<file> reference must resolve to a script
// this plugin actually ships. Installed plugins cannot reach outside their own
// root, so a reference to a sibling plugin's script (e.g. core's
// observations.ts) fails silently at runtime — see #648.
// Walks the skills dir rather than the SKILLS list above: that list covers only
// the gate-shaped skills, while other skills can also carry refs.
console.log('\nscript references:');
const scriptsDir = path.join(import.meta.dir, '..', 'scripts');
// Trailing `.`/`/` are excluded from the capture so a ref at the end of a prose
// sentence ("… see ${CLAUDE_PLUGIN_ROOT}/scripts/git-push-guard.ts.") doesn't
// report a bogus dangling ref.
const scriptRefRe = /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([A-Za-z0-9._/-]*[A-Za-z0-9_-])/g;
const danglingRefs: string[] = [];
let refsChecked = 0;

for (const entry of fs.readdirSync(SKILL_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillFile = path.join(SKILL_DIR, entry.name, 'SKILL.md');
  if (!fs.existsSync(skillFile)) continue;

  for (const [, script] of fs.readFileSync(skillFile, 'utf-8').matchAll(scriptRefRe)) {
    refsChecked += 1;
    if (!fs.existsSync(path.join(scriptsDir, script))) {
      danglingRefs.push(`${entry.name} → scripts/${script}`);
    }
  }
}

ok(`script refs resolve (${refsChecked} checked)`, danglingRefs.length === 0, danglingRefs.join(', '));

process.exit(summary() === 0 ? 0 : 1);
