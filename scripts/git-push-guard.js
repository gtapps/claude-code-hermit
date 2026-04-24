// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/pre-bash-git-push-reminder.js + --no-verify blocker — MIT License
// Changes: Merged both scripts into one, uses exit code 2 to hard-block,
//          gated to "strict" profile only via AGENT_HOOK_PROFILE,
//          config-driven protected branches, tokenizer-based command parser.

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_STDIN = 1024 * 1024; // 1MB

// --- Protected branch helpers ---

function loadProtectedBranches() {
  try {
    const configPath = path.join(process.cwd(), '.claude-code-hermit', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const branches = cfg?.dev?.protected_branches;
    if (Array.isArray(branches) && branches.length > 0) {
      return branches;
    }
  } catch (_) {
    // Config missing or unreadable — fall back to defaults
  }
  return ['main', 'master'];
}

function normalizeBranch(name) {
  // Strip refs/heads/, refs/remotes/, origin/ prefixes
  return name
    .replace(/^refs\/remotes\/[^/]+\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^[^/]+\//, (m) => {
      // Only strip if it looks like a remote prefix (e.g. origin/)
      // Keep prefixes that are part of branch names like feature/
      // Heuristic: if the prefix is a known remote indicator we saw in git
      // We can't know remotes here, so only strip common ones
      return ['origin/', 'upstream/', 'fork/'].includes(m) ? '' : m;
    });
}

function globMatch(pattern, str) {
  // Simple glob: * matches anything within a segment, ** matches across segments
  const reStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars
    .replace(/\*\*/g, '§§')               // placeholder for **
    .replace(/\*/g, '[^/]*')              // * = anything except /
    .replace(/§§/g, '.*');               // ** = anything
  return new RegExp('^' + reStr + '$').test(str);
}

function isProtected(branchName, protectedList) {
  const normalized = normalizeBranch(branchName);
  return protectedList.some((pattern) => globMatch(pattern, normalized));
}

// --- Command tokenizer ---

function splitOnOperators(cmd) {
  // Split unquoted &&, ||, ;, | into sub-commands
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" && !inDouble) { inSingle = !inSingle; current += c; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; current += c; continue; }
    if (inSingle || inDouble) { current += c; continue; }

    // Check for &&, ||
    if ((c === '&' || c === '|') && cmd[i + 1] === c) {
      parts.push(current.trim());
      current = '';
      i++; // skip second char
      continue;
    }
    if (c === ';') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    if (c === '|' && cmd[i + 1] !== '|') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function tokenize(str) {
  // Split on whitespace, respecting single/double quotes
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

function extractGitPushInfo(subcmd) {
  // Returns null if not a git push, or { isForce, isForceWithLease, isMirror, isAll, isDelete, refs }
  let tokens = tokenize(subcmd);
  if (!tokens.length) return null;

  // Strip leading env-var assignments (FOO=bar)
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    tokens = tokens.slice(1);
  }
  // Strip leading 'command' or 'exec' alias
  while (tokens.length && (tokens[0] === 'command' || tokens[0] === 'exec')) {
    tokens = tokens.slice(1);
  }
  if (!tokens.length) return null;

  // Must start with 'git'
  if (tokens[0] !== 'git') return null;
  tokens = tokens.slice(1);

  // Skip git global flags: -C <path>, --git-dir=..., --work-tree=..., -c key=val
  while (tokens.length) {
    if ((tokens[0] === '-C' || tokens[0] === '--git-dir' || tokens[0] === '--work-tree') && tokens[1]) {
      tokens = tokens.slice(2);
    } else if (tokens[0] === '-c' && tokens[1]) {
      tokens = tokens.slice(2);
    } else if (/^--git-dir=/.test(tokens[0]) || /^--work-tree=/.test(tokens[0]) || /^-c[A-Za-z]/.test(tokens[0])) {
      tokens = tokens.slice(1);
    } else {
      break;
    }
  }

  if (!tokens.length || tokens[0] !== 'push') return null;
  tokens = tokens.slice(1); // consume 'push'

  // Parse push flags and refs
  let isForce = false;
  let isForceWithLease = false;
  let isMirror = false;
  let isAll = false;
  let isDelete = false;
  let noRefspec = true;
  const refs = [];
  let sawRemote = false; // first non-flag positional is the remote

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--force' || t === '-f') { isForce = true; continue; }
    if (t === '--force-with-lease' || /^--force-with-lease=/.test(t)) { isForceWithLease = true; continue; }
    if (t === '--mirror') { isMirror = true; continue; }
    if (t === '--all' || t === '-a') { isAll = true; continue; }
    if (t === '--delete' || t === '-d') { isDelete = true; continue; }
    if (t === '--no-verify') continue; // handled separately
    if (t === '--tags' || t === '--follow-tags') continue;
    if (t === '--dry-run' || t === '-n') continue;
    if (t === '--porcelain' || t === '--progress' || t === '--verbose' || t === '-v') continue;
    if (t === '--set-upstream' || t === '-u') continue;
    if (t === '--push-option' || t === '-o') { i++; continue; } // skip value
    if (/^--push-option=/.test(t)) continue;
    if (/^-/.test(t)) continue; // unknown flag — skip

    // Positional args
    if (!sawRemote) {
      sawRemote = true; // first positional is the remote, ignore it
      continue;
    }
    noRefspec = false;
    refs.push(t);
  }

  return { isForce, isForceWithLease, isMirror, isAll, isDelete, noRefspec, refs };
}

function extractBranchesFromRef(ref) {
  // Given a refspec token, extract branch name(s) to check
  // Handles: main, origin/main, refs/heads/main, HEAD:main, :main, +main, +HEAD:main
  const names = [];
  let r = ref;

  // Strip leading +
  if (r.startsWith('+')) r = r.slice(1);

  // :branch — delete by empty source (e.g. :main)
  if (r.startsWith(':')) {
    names.push(r.slice(1));
    return names;
  }

  // src:dest
  if (r.includes(':')) {
    const dest = r.split(':')[1];
    if (dest) names.push(dest);
    return names;
  }

  names.push(r);
  return names;
}

// --- Main ---

async function main() {
  try {
    const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
    if (profile !== 'strict') {
      process.exit(0);
    }

    const chunks = [];
    let totalSize = 0;
    for await (const chunk of process.stdin) {
      totalSize += chunk.length;
      if (totalSize > MAX_STDIN) { process.exit(0); }
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) process.exit(0);

    const data = JSON.parse(raw);
    const command = data.tool_input?.command || data.input?.command || '';
    if (!command) process.exit(0);

    // Check --no-verify anywhere in the full command string
    if (/--no-verify/.test(command)) {
      console.error(
        '[git-push-guard] BLOCKED: --no-verify is not allowed. ' +
        'Fix the issue that the hook caught instead of bypassing it.'
      );
      process.exit(2);
    }

    // Quick pre-check: does the raw command even contain 'push'?
    if (!/\bpush\b/.test(command)) process.exit(0);

    const protectedBranches = loadProtectedBranches();
    const subcmds = splitOnOperators(command);

    for (const subcmd of subcmds) {
      const info = extractGitPushInfo(subcmd);
      if (!info) continue;

      const { isForce, isForceWithLease, isMirror, isAll, isDelete, noRefspec, refs } = info;

      // --mirror and --all always blocked (would push everything, including protected)
      if (isMirror || isAll) {
        console.error(
          '[git-push-guard] BLOCKED: --mirror and --all are not allowed. ' +
          'Push specific branches instead.'
        );
        process.exit(2);
      }

      // --force (not lease) is always blocked
      if (isForce && !isForceWithLease) {
        console.error(
          '[git-push-guard] BLOCKED: Force push is not allowed. ' +
          'Use --force-with-lease on feature branches if you must overwrite.'
        );
        process.exit(2);
      }

      // --force-with-lease with no explicit refspec: block (can't verify target branch)
      if (isForceWithLease && noRefspec) {
        console.error(
          '[git-push-guard] BLOCKED: --force-with-lease without an explicit refspec is not allowed. ' +
          'Specify the target branch explicitly (e.g. git push --force-with-lease origin feature/my-branch).'
        );
        process.exit(2);
      }

      // Collect all branch names to check
      const branchesToCheck = [];
      if (isDelete) {
        // --delete main / -d main
        branchesToCheck.push(...refs);
      } else {
        for (const ref of refs) {
          branchesToCheck.push(...extractBranchesFromRef(ref));
        }
      }

      for (const branch of branchesToCheck) {
        if (!branch || branch === 'HEAD') continue;
        if (isProtected(branch, protectedBranches)) {
          if (isForceWithLease) {
            console.error(
              `[git-push-guard] BLOCKED: --force-with-lease to protected branch '${branch}' is not allowed.`
            );
          } else if (isDelete) {
            console.error(
              `[git-push-guard] BLOCKED: Deleting protected branch '${branch}' is not allowed.`
            );
          } else {
            console.error(
              `[git-push-guard] BLOCKED: Direct push to protected branch '${branch}' is not allowed. ` +
              'Push to a feature branch and create a pull request instead.'
            );
          }
          process.exit(2);
        }
      }
    }

    process.exit(0);
  } catch (err) {
    // On parse error or unexpected failure, allow through — don't block on guard failure
    console.error(`[git-push-guard] Error: ${err.message}`);
    process.exit(0);
  }
}

main();
