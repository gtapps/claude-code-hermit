import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { threadRecords } from './lib/tasks';
import { runHook } from './lib/hook-input';

function refuse(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function main(payload: any): void {
  const input = payload.tool_input;
  if (typeof input?.text !== 'string') return;
  if (!input.text.trimStart().startsWith('[[helper-report')) return;
  if (payload.hook_event_name === 'PostToolUse') {
    refuse('helper report was not substituted; delivery failed');
  }
  if (payload.hook_event_name !== 'PreToolUse') return;
  const match = /^\[\[helper-report ([a-z0-9]{6,64})\]\]$/.exec(input.text.trim());
  if (!match) refuse('malformed helper-report placeholder: send exactly [[helper-report <id>]], <id> 6 to 64 characters of [a-z0-9]');
  try {
    if (typeof input.chat_id !== 'string' || !input.chat_id) throw new Error('missing chat_id');
    const dir = hermitDir();
    const owned = threadRecords(dir).filter(record => {
      const [sourceKey, chatId] = record.conversation!.split(':');
      const tool = payload.tool_name;
      return chatId === input.chat_id && typeof tool === 'string' &&
        (tool === `mcp__${sourceKey}__reply` || tool.endsWith(`_${sourceKey}__reply`));
    });
    if (owned.length !== 1) throw new Error('expected exactly one matching open record');
    const reports = fs.realpathSync(path.join(dir, 'helper-reports'));
    const file = fs.realpathSync(path.join(reports, `${match[1]}.md`));
    if (!file.startsWith(`${reports}${path.sep}`)) throw new Error('report outside helper-reports');
    const text = fs.readFileSync(file, 'utf8');
    if (!text.length || text.length > 8192) throw new Error('report must contain 1 to 8192 characters');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, text } },
    }));
  } catch (error) {
    refuse(`helper report delivery failed: ${error instanceof Error ? error.message : 'store or file error'}`);
  }
}

runHook(main);
