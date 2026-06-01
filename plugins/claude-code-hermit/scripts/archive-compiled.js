#!/usr/bin/env node
// archive-compiled.js — rotates old compiled artifacts into compiled/.archive/
// Zero npm dependencies. Node stdlib only.
// Usage: node archive-compiled.js <hermit-state-dir>
//   hermit-state-dir: path to .claude-code-hermit/ in the target project (default: .claude-code-hermit)
//
// Retention: keeps the newest KEEP_PER_TYPE artifacts per type; foundational-tagged
// artifacts are always retained and excluded from the per-type count.

'use strict';

const fs = require('fs');
const path = require('path');
const { readFrontmatter, globDir } = require('./lib/frontmatter');

const KEEP_PER_TYPE = 2;

const hermitDir = process.argv[2] || '.claude-code-hermit';
const compiledDir = path.join(hermitDir, 'compiled');
const archiveDir = path.join(compiledDir, '.archive');

const fullPaths = globDir(compiledDir, /^[^.].*\.md$/);
if (fullPaths.length === 0) {
  console.log('compiled/ does not exist or is empty — nothing to archive.');
  process.exit(0);
}

fs.mkdirSync(archiveDir, { recursive: true });

let archived = 0;
let retained = 0;
let skipped = 0;

const artifacts = [];
for (const filePath of fullPaths) {
  const filename = path.basename(filePath);
  const fm = readFrontmatter(filePath);

  if (!fm || !fm.type || !fm.created) {
    skipped++;
    continue;
  }

  const created = new Date(fm.created);
  if (isNaN(created.getTime())) {
    skipped++;
    continue;
  }

  artifacts.push({ filePath, filename, fm, created });
}

const rotatable = [];
for (const a of artifacts) {
  if ((a.fm.tags || []).includes('foundational')) {
    retained++;
  } else {
    rotatable.push(a);
  }
}

const byType = new Map();
for (const a of rotatable) {
  if (!byType.has(a.fm.type)) byType.set(a.fm.type, []);
  byType.get(a.fm.type).push(a);
}

for (const [, group] of byType) {
  group.sort((a, b) => b.created - a.created);

  for (let i = 0; i < group.length; i++) {
    if (i < KEEP_PER_TYPE) {
      retained++;
      continue;
    }
    const dest = path.join(archiveDir, group[i].filename);
    try {
      fs.renameSync(group[i].filePath, dest);
      archived++;
    } catch {
      skipped++;
    }
  }
}

console.log(`archive-compiled: ${archived} archived, ${retained} retained, ${skipped} skipped.`);
if (archived > 0) {
  console.log(`Archived to ${archiveDir}`);
}
