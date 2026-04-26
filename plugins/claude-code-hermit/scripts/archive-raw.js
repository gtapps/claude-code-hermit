#!/usr/bin/env node
// archive-raw.js — moves expired raw artifacts to raw/.archive/
// Zero npm dependencies. Node stdlib only.
// Usage: node archive-raw.js <hermit-state-dir>
//   hermit-state-dir: path to .claude-code-hermit/ in the target project (default: .claude-code-hermit)
//
// Safety: a raw artifact is retained if any compiled/ body references its filename.

'use strict';

const fs = require('fs');
const path = require('path');
const { readFrontmatter, globDir } = require('./lib/frontmatter');

const hermitDir = process.argv[2] || '.claude-code-hermit';
const rawDir = path.join(hermitDir, 'raw');
const archiveDir = path.join(rawDir, '.archive');
const compiledDir = path.join(hermitDir, 'compiled');

// --- Read retention from config ---
let retentionDays = 14;
try {
  const config = JSON.parse(fs.readFileSync(path.join(hermitDir, 'config.json'), 'utf8'));
  if (config.knowledge && typeof config.knowledge.raw_retention_days === 'number') {
    retentionDays = config.knowledge.raw_retention_days;
  }
} catch {}

const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
const now = Date.now();

// --- Load compiled artifact bodies for reference check ---
const compiledBodies = new Map(); // basename -> body text
for (const fullPath of globDir(compiledDir, /^[^.].*\.md$/)) {
  try {
    compiledBodies.set(path.basename(fullPath), fs.readFileSync(fullPath, 'utf8'));
  } catch {}
}

// --- Scan raw/ ---
const rawFullPaths = globDir(rawDir, /^[^.].*\.md$/);
if (rawFullPaths.length === 0) {
  console.log('raw/ does not exist or is empty — nothing to archive.');
  process.exit(0);
}

// Ensure .archive/ exists
fs.mkdirSync(archiveDir, { recursive: true });

let archived = 0;
let retained = 0;
let skipped = 0;

for (const filePath of rawFullPaths) {
  const filename = path.basename(filePath);
  const fm = readFrontmatter(filePath);

  // Skip if no frontmatter or no created date — can't determine age
  if (!fm || !fm.created) {
    skipped++;
    continue;
  }

  const created = new Date(fm.created);
  if (isNaN(created.getTime())) {
    skipped++;
    continue;
  }

  // Not yet past retention
  if (now - created.getTime() < cutoffMs) {
    retained++;
    continue;
  }

  // Check if any compiled body references this filename
  let referenced = false;
  for (const [, body] of compiledBodies) {
    if (body.includes(filename)) {
      referenced = true;
      break;
    }
  }

  if (referenced) {
    retained++;
    continue;
  }

  // Archive it
  const dest = path.join(archiveDir, filename);
  try {
    fs.renameSync(filePath, dest);
    archived++;
  } catch {
    skipped++;
  }
}

console.log(`archive-raw: ${archived} archived, ${retained} retained, ${skipped} skipped.`);
if (archived > 0) {
  console.log(`Archived to ${archiveDir}`);
}
