// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/pre-bash-git-push-reminder.js + --no-verify blocker — MIT License
// Changes: Merged both scripts into one, uses exit code 2 to hard-block,
//          gated to "strict" profile only via AGENT_HOOK_PROFILE.

'use strict';

const MAX_STDIN = 1024 * 1024; // 1MB

async function main() {
  try {
    // Profile gating — only run on "strict" profile
    const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
    if (profile !== 'strict') {
      process.exit(0);
    }

    // Read hook input from stdin
    const chunks = [];
    let totalSize = 0;

    for await (const chunk of process.stdin) {
      totalSize += chunk.length;
      if (totalSize > MAX_STDIN) {
        process.exit(0);
      }
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) {
      process.exit(0);
    }

    const data = JSON.parse(raw);
    const command = data.tool_input?.command || data.input?.command || '';

    if (!command) {
      process.exit(0);
    }

    // Check for --no-verify flag
    if (/--no-verify/.test(command)) {
      console.error(
        '[git-push-guard] BLOCKED: --no-verify is not allowed. ' +
        'Fix the issue that the hook caught instead of bypassing it.'
      );
      process.exit(2); // Exit code 2 = hard block
    }

    // Only check git push commands beyond this point
    if (!/\bgit\s+push\b/i.test(command)) {
      process.exit(0);
    }

    // Check for force push (--force or -f) on any branch
    if (/(?:--force\b|-f\b)/i.test(command)) {
      // --force-with-lease to main/master is also blocked
      const hasProtectedBranch = /\b(main|master)(\s|$)/i.test(command);
      if (/--force-with-lease\b/i.test(command) && !hasProtectedBranch) {
        // --force-with-lease on feature branches is allowed
        process.exit(0);
      }
      console.error(
        '[git-push-guard] BLOCKED: Force push is not allowed. ' +
        'Use --force-with-lease on feature branches if you must overwrite, or coordinate with the team.'
      );
      process.exit(2);
    }

    // Check for push to main/master (word boundary + end-of-string or whitespace to avoid matching main-staging etc.)
    if (/\b(main|master)(\s|$)/i.test(command)) {
      console.error(
        '[git-push-guard] BLOCKED: Direct push to main/master is not allowed. ' +
        'Push to a feature branch and create a pull request instead.'
      );
      process.exit(2);
    }

    // All checks passed
    process.exit(0);
  } catch (err) {
    // On parse error, allow the command through — don't block on guard failure
    console.error(`[git-push-guard] Error: ${err.message}`);
    process.exit(0);
  }
}

main();
