'use strict';

// Structural lint for the hatch-mode feature (v0.3.2).
// Verifies template shape, preamble presence, and skill references.
// These are grep-level checks — no runtime skill execution.

const fs = require('fs');
const path = require('path');
const { makeReporter } = require('./test-utils');

const PLUGIN_ROOT = path.join(__dirname, '..');
const TEMPLATES = path.join(PLUGIN_ROOT, 'state-templates');
const STANDARD = path.join(TEMPLATES, 'CLAUDE-APPEND.md');
const SAFETY = path.join(TEMPLATES, 'CLAUDE-APPEND-SAFETY.md');
const HATCH_SKILL = path.join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md');

const { ok, summary } = makeReporter();

// ── Safety template shape ────────────────────────────────────────────────────

console.log('\nCLAUDE-APPEND-SAFETY.md shape:');

ok('file exists', fs.existsSync(SAFETY), SAFETY);

if (fs.existsSync(SAFETY)) {
  const text = fs.readFileSync(SAFETY, 'utf-8');
  const marker = '<!-- claude-code-dev-hermit: Development Workflow -->';

  ok('marker present', text.includes(marker));
  ok('marker is near top (within first 10 lines)',
    text.split('\n').slice(0, 10).some(l => l.includes(marker)));

  // /dev-pr is the universal sanctioned push primitive — allowed in safety template.
  // Workflow-chain skills (/dev-quality, /dev-test) and workflow sections stay out.
  ok('no /dev-quality reference', !text.includes('/dev-quality'));
  ok('no /dev-test reference', !text.includes('/dev-test'));
  ok('safety: §Git Safety push rule names /dev-pr',
    /Never `git push`[\s\S]{0,200}\/claude-code-dev-hermit:dev-pr/.test(text));
  ok('no commands.test reference', !text.includes('commands.test'));
  ok('no §Implementation Flow section', !text.includes('## Implementation Flow'));
  ok('no §Tests Before PR section', !text.includes('## Tests Before PR'));

  // Mode-independent sections MUST appear.
  ok('§Git Safety present', text.includes('## Git Safety'));
  ok('§Branch Discipline present', text.includes('## Branch Discipline'));
  ok('§Technical Constraints present', text.includes('## Technical Constraints'));
  ok('§Dev Proposal Categories present', text.includes('## Dev Proposal Categories'));
}

// ── Standard template preambles + required sections ─────────────────────────

console.log('\nCLAUDE-APPEND.md preambles and sections:');

ok('file exists', fs.existsSync(STANDARD), STANDARD);

if (fs.existsSync(STANDARD)) {
  const text = fs.readFileSync(STANDARD, 'utf-8');

  // Mode-independent sections must be present in the standard template too.
  ok('§Git Safety present', text.includes('## Git Safety'));
  ok('§Branch Discipline present', text.includes('## Branch Discipline'));
  ok('§Technical Constraints present', text.includes('## Technical Constraints'));
  ok('§Dev Proposal Categories present', text.includes('## Dev Proposal Categories'));
  ok('standard: §Git Safety push rule names /dev-pr',
    /Never `git push`[\s\S]{0,200}\/claude-code-dev-hermit:dev-pr/.test(text));

  // Each preamble ends with "fallback for projects without one" or "fallback."
  const branchSection = text.match(/## Branch Discipline[\s\S]*?## Implementation Flow/);
  ok('§Branch Discipline has precedence preamble',
    branchSection !== null && branchSection[0].includes('fallback for projects without one'));

  const implSection = text.match(/## Implementation Flow[\s\S]*?## Tests Before PR/);
  ok('§Implementation Flow has precedence preamble',
    implSection !== null && implSection[0].includes('fallback for projects without one'));

  const prSection = text.match(/## Tests Before PR[\s\S]*?## Technical Constraints/);
  ok('§Tests Before PR has precedence preamble',
    prSection !== null && prSection[0].includes('fallback'));
}

// ── Hatch SKILL.md references ────────────────────────────────────────────────

console.log('\nskills/hatch/SKILL.md mode references:');

ok('file exists', fs.existsSync(HATCH_SKILL), HATCH_SKILL);

if (fs.existsSync(HATCH_SKILL)) {
  const text = fs.readFileSync(HATCH_SKILL, 'utf-8');

  ok('references hatch_mode', text.includes('hatch_mode'));
  ok('references safety mode', text.includes('"safety"') || text.includes("'safety'") || text.includes('`safety`'));
  ok('references standard mode', text.includes('"standard"') || text.includes("'standard'") || text.includes('`standard`'));
  ok('references CLAUDE-APPEND-SAFETY.md', text.includes('CLAUDE-APPEND-SAFETY.md'));
  ok('references capability scan slugs', text.includes('create-pr') && text.includes('release'));
}

process.exit(summary() === 0 ? 0 : 1);
