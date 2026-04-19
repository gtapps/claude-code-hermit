'use strict';

// cortex-refresh-stage.js — rebuild Connections.md only when inputs are newer than output.
// Returns early if obsidian/ doesn't exist or nothing changed.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERMIT_DIR = '.claude-code-hermit';
const OBSIDIAN_DIR = 'obsidian';
const CONNECTIONS_FILE = path.join(OBSIDIAN_DIR, 'Connections.md');
const SCRIPT = path.join(__dirname, 'build-cortex.js');

function maxMtime(...paths) {
  let max = 0;
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch { /* missing — skip */ }
  }
  return max;
}

function dirFileMtimes(dir, pattern) {
  try {
    return fs.readdirSync(dir)
      .filter(f => pattern.test(f))
      .map(f => fs.statSync(path.join(dir, f)).mtimeMs);
  } catch { return []; }
}

function run() {
  // Bail if cortex not set up
  try { fs.statSync(OBSIDIAN_DIR); } catch { return; }

  // Collect latest mtime across Connections inputs
  const inputMtimes = [
    ...dirFileMtimes(path.join(HERMIT_DIR, 'sessions'), /^S-\d+-REPORT\.md$/),
    ...dirFileMtimes(path.join(HERMIT_DIR, 'proposals'), /^PROP-\d+\.md$/),
  ];

  // Include cortex-manifest.json and its declared artifact paths
  const manifestPath = path.join(HERMIT_DIR, 'cortex-manifest.json');
  inputMtimes.push(maxMtime(manifestPath));
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const entry of (manifest.artifact_paths || [])) {
      if (typeof entry === 'string') inputMtimes.push(maxMtime(entry));
    }
  } catch { /* no manifest — skip */ }

  const latestInput = Math.max(0, ...inputMtimes);

  // Compare against output mtime
  const outputMtime = maxMtime(CONNECTIONS_FILE);
  if (outputMtime >= latestInput) return; // nothing changed

  // Rebuild
  execFileSync(process.execPath, [SCRIPT, HERMIT_DIR, OBSIDIAN_DIR, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('[stop-pipeline] cortex-refresh: Connections.md rebuilt');
}

module.exports = { run };
