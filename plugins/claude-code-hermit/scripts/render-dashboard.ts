// render-dashboard.ts — renders the Hermit Dashboard artifact fragment to disk.
// Usage: bun render-dashboard.ts <hermit-state-dir> [outPath]
// Prints {"path":..., "bytes":..., "hash":...} on success; exits 1 on failure
// (caller — the Dashboard Refresh protocol — treats any failure as "skip silently").

import fs from 'node:fs';
import path from 'node:path';
import { loadDashboardState, renderDashboard } from './lib/dashboard';

const hermitDir = process.argv[2];
if (!hermitDir) {
  console.error('Usage: bun render-dashboard.ts <hermit-state-dir> [outPath]');
  process.exit(1);
}

const outPath = process.argv[3] || path.join(hermitDir, 'state', 'dashboard.html');

try {
  const state = loadDashboardState(hermitDir);
  const { html, hash } = renderDashboard(state);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  process.stdout.write(JSON.stringify({ path: outPath, bytes: Buffer.byteLength(html), hash }) + '\n');
} catch (err: any) {
  console.error(`render-dashboard: failed: ${err?.message ?? err}`);
  process.exit(1);
}
