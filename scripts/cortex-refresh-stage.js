'use strict';

// cortex-refresh-stage.js — rebuild Connections.md only when inputs are newer than output.
// Returns early if obsidian/ doesn't exist or nothing changed.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { globDir, resolveArtifactPath } = require('./lib/frontmatter');

const HERMIT_DIR = '.claude-code-hermit';
const OBSIDIAN_DIR = 'obsidian';
const CONNECTIONS_FILE = path.join(OBSIDIAN_DIR, 'Connections.md');
const SCRIPT = path.join(__dirname, 'build-cortex.js');

function fileMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

async function run() {
  if (!fs.existsSync(OBSIDIAN_DIR)) return;

  const sessionFiles = globDir(path.join(HERMIT_DIR, 'sessions'), /^S-\d+-REPORT\.md$/);
  const proposalFiles = globDir(path.join(HERMIT_DIR, 'proposals'), /^PROP-\d+\.md$/);

  const inputMtimes = [
    ...sessionFiles.map(fileMtime),
    ...proposalFiles.map(fileMtime),
  ];

  const manifestPath = path.join(HERMIT_DIR, 'cortex-manifest.json');
  try {
    const st = fs.statSync(manifestPath);
    inputMtimes.push(st.mtimeMs);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const entry of (manifest.artifact_paths || [])) {
      if (typeof entry === 'string') {
        resolveArtifactPath('.', entry).forEach(f => inputMtimes.push(fileMtime(f)));
      }
    }
  } catch { /* no manifest — skip */ }

  const latestInput = Math.max(0, ...inputMtimes);
  if (fileMtime(CONNECTIONS_FILE) >= latestInput) return;

  execFileSync(process.execPath, [SCRIPT, HERMIT_DIR, OBSIDIAN_DIR, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.error('[stop-pipeline] cortex-refresh: Connections.md rebuilt');
}

module.exports = { run };
