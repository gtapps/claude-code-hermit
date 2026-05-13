'use strict';

// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code) — MIT.
// v0.3.0 simplified the original tokenizer-based parser to regex-only.
// Strict-profile only (AGENT_HOOK_PROFILE=strict). Exit 2 hard-blocks the bash call.

const fs = require('fs');
const path = require('path');

const MAX_STDIN = 1024 * 1024;

function findHermitDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude-code-hermit', 'config.json'))) return path.join(dir, '.claude-code-hermit');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadProtectedBranches() {
  try {
    const hermitDir = findHermitDir(process.cwd());
    if (!hermitDir) return ['main', 'master'];
    const raw = fs.readFileSync(path.join(hermitDir, 'config.json'), 'utf-8');
    const branches = JSON.parse(raw)?.['claude-code-dev-hermit']?.protected_branches;
    if (Array.isArray(branches) && branches.length > 0) return branches;
  } catch (_) {}
  return ['main', 'master'];
}

function branchRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/\\s]*')
    .replace(/§§/g, '.*');
  // Non-glob patterns use exact match against the extracted destination ref so that
  // `feature/main` (a legitimate branch) is not blocked by the `main` rule.
  return pattern.includes('*')
    ? new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`, 'i')
    : new RegExp(`^${escaped}$`, 'i');
}

function extractDests(subcmd) {
  const afterPush = subcmd.replace(/^[\s\S]*?\bpush\b/, '');
  const positionals = afterPush.trim().split(/\s+/).filter(t => t && !t.startsWith('-'));
  if (positionals.length < 2) return null;
  return positionals.slice(1).map(rs => {
    const stripped = rs.replace(/^\+/, '');
    const dest = stripped.includes(':') ? stripped.split(':')[1] : stripped;
    return dest.replace(/^refs\/heads\//, '');
  });
}

function block(msg) {
  console.error(`[git-push-guard] BLOCKED: ${msg}`);
  process.exit(2);
}

async function main() {
  if ((process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase() !== 'strict') process.exit(0);

  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN) process.exit(0);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) process.exit(0);

  let command;
  try {
    const data = JSON.parse(raw);
    command = (data.tool_input || data.input || {}).command || '';
  } catch { process.exit(0); }
  if (!command) process.exit(0);

  if (/(?:^|\s)--no-verify(?:\s|$|=)/.test(command)) {
    block('--no-verify is not allowed. Fix the underlying issue, do not bypass.');
  }

  const subcmds = command.split(/(?:&&|\|\||;|\|)/);
  if (!subcmds.some(s => /\bgit\b[\s\S]*\bpush\b/.test(s))) process.exit(0);

  const branchRegexes = loadProtectedBranches().map(p => ({ pattern: p, rx: branchRegex(p) }));

  for (const subcmd of subcmds) {
    if (!/\bgit\b[\s\S]*\bpush\b/.test(subcmd)) continue;

    const hasForceWithLease = /(?:^|\s)--force-with-lease\b/.test(subcmd);
    const hasBareForce = /(?:^|\s)(?:--force(?!-with-lease)\b|-f\b)/.test(subcmd);

    if (hasBareForce) {
      block('Bare force push is not allowed (--force, -f). Use --force-with-lease on a non-protected branch with an explicit refspec if you must overwrite.');
    }
    if (/(?:^|\s)(?:--mirror\b|--all\b|-a\b)/.test(subcmd)) {
      block('--mirror, --all, and -a are not allowed (would push everything, including protected branches).');
    }
    const dests = extractDests(subcmd);
    for (const { pattern, rx } of branchRegexes) {
      if ((dests ?? [subcmd]).some(t => rx.test(t))) {
        block(`Direct push to protected branch '${pattern}' is not allowed. Push to a feature branch and open a PR.`);
      }
    }
    if (hasForceWithLease && dests === null) {
      block('--force-with-lease without an explicit refspec is not allowed (ambiguous target).');
    }
  }

  process.exit(0);
}

main();
