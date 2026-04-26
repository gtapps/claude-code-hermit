#!/usr/bin/env node
// validate-frontmatter.js — checks cortex-relevant files against the frontmatter contract
// Zero npm dependencies. Node stdlib only.
// Usage: node validate-frontmatter.js [hermit-state-dir] [project-root]
//   hermit-state-dir: path to .claude-code-hermit/ (default: .claude-code-hermit)
//   project-root: project root for resolving artifact_paths (default: cwd)
//
// Exit code 0: all clean (warnings are allowed)
// Exit code 1: errors found

'use strict';

const fs = require('fs');
const path = require('path');
const { readFrontmatter, globDir, resolveArtifactPath } = require('./lib/frontmatter');

const hermitDir = process.argv[2] || '.claude-code-hermit';
const projectRoot = process.argv[3] || process.cwd();

// --- Contract definitions ---

const SESSION_REQUIRED = ['id', 'status', 'date', 'duration', 'cost_usd', 'tags', 'proposals_created', 'task', 'escalation', 'operator_turns'];
const SESSION_ENUMS = {
  status: ['completed', 'partial', 'blocked'],
  escalation: ['conservative', 'balanced', 'autonomous'],
};

const PROPOSAL_REQUIRED = ['id', 'title', 'status', 'source', 'session', 'created', 'category'];
const PROPOSAL_ENUMS = {
  status: ['proposed', 'accepted', 'resolved', 'dismissed'],
  source: ['manual', 'auto-detected', 'operator-request'],
};
// Category uses a core set but custom hermits may extend — unknown values are warnings
const PROPOSAL_CORE_CATEGORIES = ['improvement', 'routine', 'capability', 'constraint', 'bug'];

const REVIEW_REQUIRED = ['week', 'sessions_count', 'proposals_created', 'proposals_accepted', 'proposals_resolved', 'total_cost_usd', 'avg_session_cost_usd', 'self_directed_rate'];

const ARTIFACT_REQUIRED = ['title', 'created'];
const ARTIFACT_SOURCE_ENUM = ['session', 'interactive', 'routine', 'manual'];

// ISO 8601 pattern — full with timezone required for new files
const ISO_FULL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const ISO_LOOSE = /^\d{4}-\d{2}-\d{2}/;

// --- Result tracking ---

const errors = [];
const warnings = [];

function error(file, msg) {
  errors.push({ file: path.relative(projectRoot, file), msg });
}

function warn(file, msg) {
  warnings.push({ file: path.relative(projectRoot, file), msg });
}

// --- Validators ---

function checkRequired(file, fm, required) {
  for (const field of required) {
    if (fm[field] === undefined || fm[field] === '') {
      error(file, `missing required field: ${field}`);
    }
  }
}

function checkEnum(file, fm, field, allowed) {
  if (fm[field] !== undefined && fm[field] !== null && fm[field] !== '') {
    if (!allowed.includes(fm[field])) {
      error(file, `invalid ${field}: "${fm[field]}" (expected: ${allowed.join(', ')})`);
    }
  }
}

function checkTimestamp(file, fm, field) {
  const val = fm[field];
  if (val && val !== 'null' && val !== null) {
    if (!ISO_LOOSE.test(val)) {
      error(file, `${field} is not ISO 8601: "${val}"`);
    } else if (!ISO_FULL.test(val)) {
      warn(file, `${field} missing timezone offset: "${val}" (prefer YYYY-MM-DDTHH:MM:SS±HH:MM)`);
    }
  }
}

function checkArray(file, fm, field) {
  if (fm[field] !== undefined && fm[field] !== null && !Array.isArray(fm[field])) {
    error(file, `${field} should be an array, got: "${fm[field]}"`);
  }
}

// --- File type validators ---

function validateSession(file) {
  const fm = readFrontmatter(file);
  if (!fm) { error(file, 'no frontmatter found'); return; }
  checkRequired(file, fm, SESSION_REQUIRED);
  for (const [field, allowed] of Object.entries(SESSION_ENUMS)) {
    checkEnum(file, fm, field, allowed);
  }
  checkTimestamp(file, fm, 'date');
  checkArray(file, fm, 'tags');
  checkArray(file, fm, 'proposals_created');
}

function validateProposal(file) {
  const fm = readFrontmatter(file);
  if (!fm) { error(file, 'no frontmatter found'); return; }

  // Required fields — session is optional for operator-request proposals
  const required = fm.source === 'operator-request'
    ? PROPOSAL_REQUIRED.filter(f => f !== 'session')
    : PROPOSAL_REQUIRED;
  checkRequired(file, fm, required);
  for (const [field, allowed] of Object.entries(PROPOSAL_ENUMS)) {
    checkEnum(file, fm, field, allowed);
  }
  // category is extensible — custom hermits may add domain-specific values
  checkEnum(file, fm, 'category', PROPOSAL_CORE_CATEGORIES);
  checkTimestamp(file, fm, 'created');
  checkTimestamp(file, fm, 'accepted_date');
  checkTimestamp(file, fm, 'resolved_date');
  checkArray(file, fm, 'related_sessions');
}

function validateReview(file) {
  const fm = readFrontmatter(file);
  if (!fm) { error(file, 'no frontmatter found'); return; }
  checkRequired(file, fm, REVIEW_REQUIRED);
  // week format: YYYY-Www
  if (fm.week && !/^\d{4}-W\d{2}$/.test(fm.week)) {
    error(file, `invalid week format: "${fm.week}" (expected YYYY-Www)`);
  }
}

function validateArtifact(file) {
  const fm = readFrontmatter(file);
  if (!fm) {
    error(file, 'no frontmatter — required for cortex-connected artifacts');
    return;
  }
  checkRequired(file, fm, ARTIFACT_REQUIRED);
  checkTimestamp(file, fm, 'created');
  if (fm.source) {
    checkEnum(file, fm, 'source', ARTIFACT_SOURCE_ENUM);
  }
}

// --- Scan ---

function scanDir(dir, pattern, validator) {
  const files = globDir(dir, pattern);
  for (const file of files) {
    validator(file);
  }
  return files.length;
}

// --- Main ---

const sessionsDir = path.join(hermitDir, 'sessions');
const proposalsDir = path.join(hermitDir, 'proposals');
const reviewsDir = path.join(hermitDir, 'reviews');

let totalFiles = 0;

// Sessions
totalFiles += scanDir(sessionsDir, /^S-\d+-REPORT\.md$/, validateSession);

// Proposals
totalFiles += scanDir(proposalsDir, /^PROP-\d+\.md$/, validateProposal);

// Reviews
if (fs.existsSync(reviewsDir)) {
  totalFiles += scanDir(reviewsDir, /^W-\d{4}-W\d{2}\.md$/, validateReview);
}

// Custom artifacts from cortex-manifest.json
const manifestPath = path.join(hermitDir, 'cortex-manifest.json');
if (fs.existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const artifactPaths = manifest.artifact_paths || [];
    for (const ap of artifactPaths) {
      const files = resolveArtifactPath(projectRoot, ap);
      for (const file of files) {
        validateArtifact(file);
        totalFiles++;
      }
    }
  } catch (e) {
    error(manifestPath, `failed to read cortex-manifest.json: ${e.message}`);
  }
}

// --- Report ---

console.log(`\nFrontmatter validation: ${totalFiles} files scanned\n`);

if (warnings.length > 0) {
  console.log(`⚠  ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}:\n`);
  for (const w of warnings) {
    console.log(`  WARN  ${w.file}`);
    console.log(`        ${w.msg}\n`);
  }
}

if (errors.length > 0) {
  console.log(`✗  ${errors.length} error${errors.length !== 1 ? 's' : ''}:\n`);
  for (const e of errors) {
    console.log(`  ERR   ${e.file}`);
    console.log(`        ${e.msg}\n`);
  }
  process.exit(1);
} else {
  console.log(`✓  No errors.${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length !== 1 ? 's' : ''})` : ''}\n`);
  process.exit(0);
}
