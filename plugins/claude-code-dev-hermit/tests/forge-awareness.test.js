'use strict';

// Structural lint for forge-aware /dev-pr and /hatch (issue #33).
// Asserts exact flag snippets per tool, rejects old wrong defaults, and
// checks that stale-doc strings have been removed from docs.

const fs = require('fs');
const path = require('path');
const { makeReporter } = require('./test-utils');

const PLUGIN_ROOT = path.join(__dirname, '..');
const HATCH_SKILL  = path.join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md');
const DEV_PR_SKILL = path.join(PLUGIN_ROOT, 'skills', 'dev-pr', 'SKILL.md');
const README       = path.join(PLUGIN_ROOT, 'README.md');
const WORKFLOW     = path.join(PLUGIN_ROOT, 'docs', 'WORKFLOW.md');
const HOW_TO_USE   = path.join(PLUGIN_ROOT, 'docs', 'HOW-TO-USE.md');

const { ok, summary } = makeReporter();

// ── Load files ──────────────────────────────────────────────────────────────

function load(p) {
  ok(`${path.relative(PLUGIN_ROOT, p)} exists`, fs.existsSync(p), p);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

const hatch  = load(HATCH_SKILL);
const devPr  = load(DEV_PR_SKILL);
const readme = load(README);
const wf     = load(WORKFLOW);
const htu    = load(HOW_TO_USE);

// ── Regression: old wrong defaults must not appear anywhere ─────────────────

console.log('\nRegression — glab pr create (wrong command) not present:');

ok('hatch SKILL.md',   !hatch.includes('glab pr create'));
ok('dev-pr SKILL.md',  !devPr.includes('glab pr create'));
ok('README.md',        !readme.includes('glab pr create'));
ok('WORKFLOW.md',      !wf.includes('glab pr create'));
ok('HOW-TO-USE.md',    !htu.includes('glab pr create'));

// ── Regression: glab --description-file does not exist ──────────────────────

console.log('\nRegression — glab --description-file (invalid flag) not present:');

ok('dev-pr SKILL.md',  !devPr.includes('--description-file'));
ok('hatch SKILL.md',   !hatch.includes('--description-file'));

// ── Regression: gh pr edit auto-update branch dropped ───────────────────────

console.log('\nRegression — auto-edit gh pr edit --body-file dropped:');

ok('dev-pr SKILL.md no gh pr edit --body-file', !devPr.includes('gh pr edit --body-file'));

// ── Hatch — forge classification ────────────────────────────────────────────

console.log('\nHatch SKILL.md — forge classification:');

ok('classifies github',   hatch.includes('FORGE=github'));
ok('classifies gitlab',   hatch.includes('FORGE=gitlab'));
ok('classifies bitbucket', hatch.includes('FORGE=bitbucket'));
ok('classifies custom',   hatch.includes('FORGE=custom'));

// ── Hatch — correct canonical commands ──────────────────────────────────────

console.log('\nHatch SKILL.md — canonical command heads:');

ok('gh pr create present',   hatch.includes('gh pr create'));
ok('glab mr create present', hatch.includes('glab mr create'));

// ── Hatch — PR cmd question in Round 2 ──────────────────────────────────────

console.log('\nHatch SKILL.md — PR cmd question:');

ok('PR cmd header present', hatch.includes('"PR cmd"'));
ok('Skip option present',   hatch.includes("Skip — I'll configure later"));
ok('step 6 shows PR cmd:',  hatch.includes('PR cmd:'));

// ── Hatch — gitlab template path in ls ──────────────────────────────────────

console.log('\nHatch SKILL.md — extended template detection:');

ok('gitlab template path in ls',
   hatch.includes('.gitlab/merge_request_templates/Default.md'));
ok('bitbucket template path in ls',
   hatch.includes('.bitbucket/pull_request_template.md'));

// ── dev-pr — Configuration section ──────────────────────────────────────────

console.log('\ndev-pr SKILL.md — Configuration section:');

ok('## Configuration present', devPr.includes('## Configuration'));
ok('gh pr create documented',   devPr.includes('gh pr create'));
ok('glab mr create documented', devPr.includes('glab mr create'));

// ── dev-pr — Gate 0 forge/tool sanity check ─────────────────────────────────

console.log('\ndev-pr SKILL.md — Gate 0 forge sanity check:');

ok('not configured message present',        devPr.includes('not configured'));
ok('FORGE=github check present',            devPr.includes('FORGE=github'));
ok('FORGE=gitlab check present',            devPr.includes('FORGE=gitlab'));
ok('GitLab SSH→HTTPS fallback present',     devPr.includes('!glab auth git-credential'));
ok('unsupported-forge SSH message present', devPr.includes('only supported for GitHub and GitLab'));

// ── dev-pr — Gate 3 exact flag assertions ───────────────────────────────────

console.log('\ndev-pr SKILL.md — Gate 3 tool-aware dispatch flags:');

ok('gh arm: --body-file present',          devPr.includes('--body-file "$PR_BODY_TMP"'));
ok('gh arm: --base present',               devPr.includes('--base "$BASE"'));
ok('glab arm: --description "$(cat ...")', devPr.includes('--description "$(cat "$PR_BODY_TMP")'));
ok('glab arm: --target-branch present',    devPr.includes('--target-branch "$BASE"'));
ok('case block has *) arm',                devPr.includes('  *)\n'));
ok('no bb) arm in case block',            !devPr.includes('  bb)\n'));

// ── dev-pr — template chain ──────────────────────────────────────────────────

console.log('\ndev-pr SKILL.md — extended PR template chain:');

ok('gitlab template path in chain',
   devPr.includes('.gitlab/merge_request_templates/Default.md'));
ok('bitbucket template path in chain',
   devPr.includes('.bitbucket/pull_request_template.md'));

// ── Docs updated ─────────────────────────────────────────────────────────────

console.log('\nDocs — stale references removed:');

ok('README mentions glab mr create',   readme.includes('glab mr create'));
ok('WORKFLOW mentions glab mr create', wf.includes('glab mr create'));
ok('HOW-TO-USE updated',               htu.includes('glab') && !htu.includes('glab pr create'));

process.exit(summary() === 0 ? 0 : 1);
