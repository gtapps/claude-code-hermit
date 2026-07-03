// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code) — MIT.
// v0.3.0 simplified the original tokenizer-based parser to regex-only.
// Strict-profile only (AGENT_HOOK_PROFILE=strict). Exit 2 hard-blocks the bash call.
//
// Known limit: `cd /x && git push` is not resolved (shell state is lost when
// segments are split), so a bare push behind a `cd` fails open — consistent
// with the hook's fail-open philosophy. `git -C <path> push` IS handled.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_STDIN = 1024 * 1024;

function findHermitDir(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude-code-hermit', 'config.json'))) return path.join(dir, '.claude-code-hermit');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadProtectedBranches(): string[] {
  try {
    const hermitDir = findHermitDir(process.cwd());
    if (!hermitDir) return ['main', 'master'];
    const raw = fs.readFileSync(path.join(hermitDir, 'config.json'), 'utf-8');
    const branches = JSON.parse(raw)?.['claude-code-dev-hermit']?.protected_branches;
    if (Array.isArray(branches) && branches.length > 0) return branches;
  } catch (_) {}
  return ['main', 'master'];
}

function branchRegex(pattern: string): RegExp {
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

function extractDests(subcmd: string): string[] | null {
  const afterPush = subcmd.replace(/^[\s\S]*?\bpush\b/, '');
  const positionals = afterPush.trim().split(/\s+/).filter(t => t && !t.startsWith('-'));
  if (positionals.length < 2) return null;
  return positionals.slice(1).map(rs => {
    const stripped = rs.replace(/^\+/, '');
    const dest = stripped.includes(':') ? stripped.split(':')[1] : stripped;
    return dest.replace(/^refs\/heads\//, '');
  });
}

// Resolve the current branch so bare `git push` / `git push origin HEAD`
// (which carry no explicit destination ref) can be tested against the
// protected list. Fails open (null) on detached HEAD, non-repo, timeout, or
// any error — a bare push from those states fails in git itself.
const branchCache = new Map<string, string | null>();
function resolveCurrentBranch(cwd: string): string | null {
  if (branchCache.has(cwd)) return branchCache.get(cwd) ?? null;
  let branch: string | null = null;
  try {
    const r = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 1500 });
    if (r.status === 0 && typeof r.stdout === 'string') {
      const out = r.stdout.trim();
      if (out) branch = out;
    }
  } catch { branch = null; }
  branchCache.set(cwd, branch);
  return branch;
}

// If the push segment carries `git -C <path>`, that path is where the push
// runs — resolve the branch there, not in the session cwd.
function gitCwd(subcmd: string, baseCwd: string): string {
  const m = subcmd.match(/\bgit\b(?:\s+-c\s+\S+)*\s+-C\s+("[^"]+"|'[^']+'|\S+)/);
  if (!m) return baseCwd;
  const p = m[1].replace(/^["']|["']$/g, '');
  return path.resolve(baseCwd, p);
}

function block(msg: string): void {
  console.error(`[git-push-guard] BLOCKED: ${msg}`);
  process.exit(2);
}

async function main() {
  // Read stdin first (every hook must consume stdin), then gate on profile —
  // so a non-strict session can still surface a one-line "guard inactive" notice.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN) process.exit(0);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) process.exit(0);

  let command: string;
  let baseCwd = process.cwd();
  try {
    const data = JSON.parse(raw);
    command = (data.tool_input || data.input || {}).command || '';
    if (typeof data.cwd === 'string' && data.cwd) baseCwd = data.cwd;
  } catch { process.exit(0); }
  if (!command) process.exit(0);

  if ((process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase() !== 'strict') {
    if (/\bgit\b[\s\S]*\bpush\b/.test(command)) {
      console.error("[git-push-guard] notice: AGENT_HOOK_PROFILE is not 'strict' — push guard inactive.");
    }
    process.exit(0);
  }

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
    // Bare push (no refspec → null) and `HEAD` both resolve to the current
    // branch; explicit refspecs are tested as-is.
    let targets: string[];
    if (dests === null || dests.includes('HEAD')) {
      const branch = resolveCurrentBranch(gitCwd(subcmd, baseCwd));
      targets = dests === null
        ? (branch ? [branch] : [])
        : dests.map(d => (d === 'HEAD' && branch) ? branch : d);
    } else {
      targets = dests;
    }
    for (const { pattern, rx } of branchRegexes) {
      if (targets.some(t => rx.test(t))) {
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
