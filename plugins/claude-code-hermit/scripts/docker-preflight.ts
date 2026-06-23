#!/usr/bin/env bun
/**
 * Pre-flight probe for /docker-setup Step 1.
 *
 * Collapses the skill's read-only Step 1 shell probes (docker presence, config
 * existence, WSL path, existing docker files, host ~/.gitconfig, auto-memory
 * seed) into one call so the wizard makes a single Bash round-trip instead of
 * fanning out. The skill still owns every DECISION these signals feed — this
 * script only gathers facts.
 *
 * Usage: bun docker-preflight.ts [project-root] [hermit-state-dir]
 *   project-root defaults to process.cwd(); the skill passes the shell's `$(pwd)`
 *   so the auto-memory path key matches Claude Code's logical-path key.
 *   hermit-state-dir defaults to .claude-code-hermit.
 *
 * Prints a single JSON object to stdout and always exits 0 — callers inspect
 * fields, not the exit code. Any probe that errors degrades to null/false.
 *   {
 *     "dockerVersion": "Docker version 27.0.3, build ..." | null,
 *     "configExists": true,
 *     "isWSL": false,
 *     "existing": { "dockerfile": false, "entrypoint": false, "compose": false },
 *     "gitconfigExists": true,
 *     "memory": { "pathKey": "-home-user-project", "seedExists": false }
 *   }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function dockerVersion(): string | null {
  try {
    const r = spawnSync('docker', ['--version'], { timeout: 5000, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  return null;
}

function probe(projectRoot: string, hermitDir: string) {
  const home = os.homedir();
  // Auto-memory seed path key — derived from the project root the skill passes in
  // (the shell's logical `$(pwd)`, the same path Claude Code keys
  // ~/.claude/projects/<key> off), so it matches even when the root is reached
  // through a symlink. Mirrors the original `pwd | sed 's|/|-|g'` (leading dash kept).
  const pathKey = projectRoot.replace(/\//g, '-');
  return {
    dockerVersion: dockerVersion(),
    configExists: fs.existsSync(path.join(projectRoot, hermitDir, 'config.json')),
    isWSL: projectRoot.startsWith('/mnt/c/') || projectRoot.startsWith('/mnt/d/'),
    existing: {
      dockerfile: fs.existsSync(path.join(projectRoot, 'Dockerfile.hermit')),
      entrypoint: fs.existsSync(path.join(projectRoot, 'docker-entrypoint.hermit.sh')),
      compose: fs.existsSync(path.join(projectRoot, 'docker-compose.hermit.yml')),
    },
    gitconfigExists: fs.existsSync(path.join(home, '.gitconfig')),
    memory: {
      pathKey,
      seedExists: fs.existsSync(path.join(home, '.claude', 'projects', pathKey, 'memory', 'MEMORY.md')),
    },
  };
}

export { probe };

if (import.meta.main) {
  const projectRoot = process.argv[2] || process.cwd();
  const hermitDir = process.argv[3] || '.claude-code-hermit';
  console.log(JSON.stringify(probe(projectRoot, hermitDir)));
  process.exit(0);
}
