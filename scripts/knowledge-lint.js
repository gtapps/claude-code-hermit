#!/usr/bin/env node
// knowledge-lint.js — lint raw/ and compiled/ knowledge directories
// Zero npm dependencies. Node stdlib only.
//
// Usage as CLI:   node knowledge-lint.js <hermit-state-dir>
// Usage as lib:   require('./knowledge-lint').lint(hermitDir) => { findings, counts }
//
// findings: array of { type, file, age, reason }
//   type: 'unreferenced' | 'stale' | 'missing-type' | 'oversized' | 'working-set' | 'stale-compiled' | 'line-limit' | 'tag-variant'
// counts: { raw, compiled, archived }

'use strict';

const fs = require('fs');
const path = require('path');
const { readFrontmatter, readFileWithFrontmatter, newestByType, globDirRecursive } = require('./lib/frontmatter');

function lint(hermitDir) {
  const rawDir = path.join(hermitDir, 'raw');
  const archiveDir = path.join(rawDir, '.archive');
  const compiledDir = path.join(hermitDir, 'compiled');
  const now = Date.now();

  // --- Read config ---
  let retentionDays = 14;
  let compiledBudgetChars = 1000;
  let workingSetWarn = 20;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(hermitDir, 'config.json'), 'utf8'));
    if (config.knowledge) {
      if (typeof config.knowledge.raw_retention_days === 'number') retentionDays = config.knowledge.raw_retention_days;
      if (typeof config.knowledge.compiled_budget_chars === 'number') compiledBudgetChars = config.knowledge.compiled_budget_chars;
      if (typeof config.knowledge.working_set_warn === 'number') workingSetWarn = config.knowledge.working_set_warn;
    }
  } catch {}

  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const STALE_COMPILED_DAYS = 60;
  const staleCutoffMs = STALE_COMPILED_DAYS * 24 * 60 * 60 * 1000;
  const LINE_LIMIT = 150;
  const TAG_VARIANTS = ['foundation', 'core', 'important', 'essential', 'permanent'];

  const findings = [];

  // --- Load compiled artifacts (shared across checks) ---
  let compiledArtifacts = [];
  const compiledBodies = new Map(); // filename -> body text
  try {
    const files = fs.readdirSync(compiledDir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
    compiledArtifacts = files.map(f => {
      try {
        const result = readFileWithFrontmatter(path.join(compiledDir, f));
        if (!result || !result.fm) return null;
        const lineCount = result.content.split('\n').length;
        const bodyChars = result.body.length;
        compiledBodies.set(f, result.body);
        return { file: f, fm: result.fm, lineCount, bodyChars };
      } catch { return null; }
    }).filter(Boolean);
  } catch {}

  // --- Raw checks (active files only, not archive) ---
  let rawFiles = [];
  try {
    rawFiles = fs.readdirSync(rawDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'))
      .map(f => ({ file: f, fm: readFrontmatter(path.join(rawDir, f)) }))
      .filter(r => r.fm);
  } catch {}

  for (const raw of rawFiles) {
    const filename = raw.file;

    // Check if any compiled/ body references this filename
    let referenced = false;
    for (const [, body] of compiledBodies) {
      if (body.includes(filename)) { referenced = true; break; }
    }

    if (!referenced) {
      const created = raw.fm.created ? new Date(raw.fm.created) : null;
      const ageMs = created && !isNaN(created.getTime()) ? now - created.getTime() : null;
      const age = ageMs !== null ? Math.floor(ageMs / 86400000) : null;
      const ageStr = age !== null ? `${age}d` : 'unknown';

      if (ageMs !== null && ageMs > retentionMs) {
        // Stale subsumes unreferenced — emit only stale to avoid double-counting
        findings.push({
          type: 'stale',
          file: `raw/${filename}`,
          age: ageStr,
          reason: `Past retention (>${retentionDays}d) and unreferenced.`
        });
      } else {
        findings.push({
          type: 'unreferenced',
          file: `raw/${filename}`,
          age: ageStr,
          reason: 'Possibly unreferenced — no compiled/ body mentions this filename.'
        });
      }
    }
  }

  // --- Compiled checks ---
  if (compiledArtifacts.length > 0) {
    const workingSet = Array.from(newestByType(compiledArtifacts).values());

    // Working set size
    if (workingSet.length > workingSetWarn) {
      findings.push({
        type: 'working-set',
        file: 'compiled/',
        age: '—',
        reason: `Working set has ${workingSet.length} active types (warn threshold: ${workingSetWarn}).`
      });
    }

    // Stale compiled (not foundational, older than 60 days)
    for (const a of workingSet) {
      if (!a.fm.created) continue;
      if ((a.fm.tags || []).includes('foundational')) continue;
      if (now - new Date(a.fm.created).getTime() > staleCutoffMs) {
        const age = Math.floor((now - new Date(a.fm.created).getTime()) / 86400000);
        findings.push({
          type: 'stale-compiled',
          file: `compiled/${a.file}`,
          age: `${age}d`,
          reason: `Stale (>${STALE_COMPILED_DAYS}d, not foundational).`
        });
      }
    }

    for (const a of compiledArtifacts) {
      // Missing type
      if (!a.fm.type) {
        findings.push({
          type: 'missing-type',
          file: `compiled/${a.file}`,
          age: '—',
          reason: 'No `type` field in frontmatter — won\'t be grouped at session start.'
        });
      }

      // Oversized by char budget
      if (a.bodyChars > compiledBudgetChars) {
        findings.push({
          type: 'oversized',
          file: `compiled/${a.file}`,
          age: '—',
          reason: `Body is ${a.bodyChars} chars (budget: ${compiledBudgetChars}). Will be truncated when injected into session context.`
        });
      }

      // Line count violations
      if (a.lineCount > LINE_LIMIT) {
        findings.push({
          type: 'line-limit',
          file: `compiled/${a.file}`,
          age: '—',
          reason: `${a.lineCount} lines (limit: ${LINE_LIMIT}).`
        });
      }

      // Tag variant warnings
      const offenders = (a.fm.tags || []).filter(t => TAG_VARIANTS.includes(t));
      if (offenders.length > 0) {
        findings.push({
          type: 'tag-variant',
          file: `compiled/${a.file}`,
          age: '—',
          reason: `Tag [${offenders.join(', ')}] — did you mean \`foundational\`?`
        });
      }
    }
  }

  // --- Counts ---
  let archivedCount = 0;
  try {
    archivedCount = globDirRecursive(archiveDir).length;
  } catch {}

  return {
    findings,
    counts: {
      raw: rawFiles.length,
      compiled: compiledArtifacts.length,
      archived: archivedCount
    }
  };
}

// --- CLI mode ---
if (require.main === module) {
  const hermitDir = process.argv[2] || '.claude-code-hermit';
  const { findings, counts } = lint(hermitDir);

  if (findings.length === 0) {
    console.log(`Knowledge base is clean. (${counts.raw} raw, ${counts.compiled} compiled, ${counts.archived} archived)`);
    process.exit(0);
  }

  // Group by type
  const groups = new Map();
  for (const f of findings) {
    if (!groups.has(f.type)) groups.set(f.type, []);
    groups.get(f.type).push(f);
  }

  for (const [type, items] of groups) {
    console.log(`\n${type} (${items.length}):`);
    for (const item of items) {
      console.log(`  ${item.file} [${item.age}] — ${item.reason}`);
    }
  }

  // Advice
  console.log('');
  if (groups.has('stale')) console.log('Stale raw files will be archived on next weekly review.');
  if (groups.has('oversized')) console.log('Oversized compiled artifacts will be truncated when injected into session context.');
  if (groups.has('unreferenced')) console.log('Possibly unreferenced — verify before cleanup.');
  if (groups.has('missing-type')) console.log('Add a `type` field to frontmatter for proper grouping at session start.');

  console.log(`\n(${counts.raw} raw, ${counts.compiled} compiled, ${counts.archived} archived)`);
}

module.exports = { lint };
