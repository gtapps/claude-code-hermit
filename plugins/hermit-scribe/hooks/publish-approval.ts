#!/usr/bin/env bun
import { basename } from 'node:path';
import { shellCommands } from './shell-words';

export function needsApproval(command: string): boolean {
  if (!command.includes('file-issue.ts')) return false;
  return shellCommands(command).some(words => {
    const index = words.findIndex(word => basename(word) === 'file-issue.ts');
    if (index < 0 || (index !== 0 && !(index === 1 && ['bun', 'node'].includes(basename(words[0]))))) return false;
    const args = words.slice(index + 1);
    return args[0] === '--comment' || (args.length >= 2 && !['--check', '--templates', 'classify'].includes(args[0]));
  });
}
if (import.meta.main) {
  try {
    const payload = JSON.parse(await Bun.stdin.text());
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid hook payload');
    if (payload.tool_name === 'Bash' && typeof payload.tool_input?.command === 'string' && needsApproval(payload.tool_input.command)) {
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'ask',
        permissionDecisionReason: 'Publish the issue or comment shown in the final sanitized preview using the configured Scribe bot.',
      } }));
    }
  } catch {
    console.error('Cannot verify Scribe publication command.');
    process.exit(2);
  }
}
