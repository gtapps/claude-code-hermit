'use strict';

// PreToolUse hook: fires on every Bash call and checks if a git commit is
// being attempted. Standard profile: injects additionalContext nudge. Strict
// profile: hard-blocks (exit 2).
// Adapted from git-push-guard.js — same stdin/profile/tokenizer pattern.

const MAX_STDIN = 1024 * 1024;

function isGitCommitCmd(cmd) {
  for (const subcmd of cmd.split(/(?:&&|\|\||;|\|)/)) {
    const tokens = subcmd.trim().split(/\s+/);
    let i = 0;
    // Skip leading shell env assignments (e.g. LANG=en git commit)
    while (i < tokens.length && /^\w+=/.test(tokens[i])) i++;
    if (tokens[i] !== 'git') continue;
    i++;
    // Skip global git options that consume the next token as their value
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '-C' || t === '-c' || t === '--exec-path' ||
          t === '--git-dir' || t === '--work-tree' || t === '--namespace') {
        i += 2;
      } else if (t.startsWith('-')) {
        i++;
      } else {
        break;
      }
    }
    if (tokens[i] === 'commit') return true;
  }
  return false;
}

async function main() {
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

  if (!isGitCommitCmd(command)) process.exit(0);

  const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
  if (profile === 'strict') {
    console.error('[git-commit-quality-gate] BLOCKED: Run /dev-quality first. Order: /dev-quality → git commit → /dev-pr.');
    process.exit(2);
  }

  process.stdout.write(JSON.stringify({
    additionalContext: 'REMINDER: Run /dev-quality on the working tree BEFORE this commit. Order: /dev-quality → git commit → /dev-pr. If you already ran it and the tree is unchanged, proceed.',
  }));
  process.exit(0);
}

main();
