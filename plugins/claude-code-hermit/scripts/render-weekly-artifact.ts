// render-weekly-artifact.ts — finds the latest compiled/review-weekly-*.md and
// strips its YAML frontmatter (rendered raw it's an ugly wall of metrics; every
// field is already legible in the report body's evolution block and the
// dashboard's weekly section), writing the plain markdown body to disk. The
// Artifact tool renders .md directly — no HTML renderer needed for this page.
// Usage: bun render-weekly-artifact.ts <hermit-state-dir> [outPath]
// Prints {"path":..., "bytes":..., "hash":...} on success; exits 1 on failure
// (caller — the artifacts.md refresh protocol — treats any failure as "skip silently").

import fs from 'node:fs';
import path from 'node:path';
import { readFileWithFrontmatter, globDir } from './lib/frontmatter';
import { sha256 } from './lib/hash';

const hermitDir = process.argv[2];
if (!hermitDir) {
  console.error('Usage: bun render-weekly-artifact.ts <hermit-state-dir> [outPath]');
  process.exit(1);
}

const outPath = process.argv[3] || path.join(hermitDir, 'state', 'weekly-review-artifact.md');

try {
  const compiledDir = path.join(hermitDir, 'compiled');
  const files = globDir(compiledDir, /^review-weekly-.*\.md$/); // YYYY-Wnn sorts chronologically by name
  if (files.length === 0) {
    console.error('render-weekly-artifact: no compiled/review-weekly-*.md found');
    process.exit(1);
  }
  const latest = readFileWithFrontmatter(files[files.length - 1]);
  if (!latest) {
    console.error('render-weekly-artifact: latest weekly review file unreadable');
    process.exit(1);
  }
  const body = latest.body;
  const hash = sha256(body);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body, 'utf8');
  process.stdout.write(JSON.stringify({ path: outPath, bytes: Buffer.byteLength(body), hash }) + '\n');
} catch (err: any) {
  console.error(`render-weekly-artifact: failed: ${err?.message ?? err}`);
  process.exit(1);
}
