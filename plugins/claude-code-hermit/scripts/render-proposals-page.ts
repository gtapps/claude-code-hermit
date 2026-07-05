// render-proposals-page.ts — renders the Hermit Proposals-page artifact fragment to disk.
// Usage: bun render-proposals-page.ts <hermit-state-dir> [outPath]
// Prints {"path":..., "bytes":..., "hash":...} on success; exits 1 on failure
// (caller — the artifacts.md refresh protocol — treats any failure as "skip silently").

import fs from 'node:fs';
import path from 'node:path';
import { loadProposalsPageState, renderProposalsPage } from './lib/proposals-page';

const hermitDir = process.argv[2];
if (!hermitDir) {
  console.error('Usage: bun render-proposals-page.ts <hermit-state-dir> [outPath]');
  process.exit(1);
}

const outPath = process.argv[3] || path.join(hermitDir, 'state', 'proposals-page.html');

try {
  const state = loadProposalsPageState(hermitDir);
  const { html, hash } = renderProposalsPage(state);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  process.stdout.write(JSON.stringify({ path: outPath, bytes: Buffer.byteLength(html), hash }) + '\n');
} catch (err: any) {
  console.error(`render-proposals-page: failed: ${err?.message ?? err}`);
  process.exit(1);
}
