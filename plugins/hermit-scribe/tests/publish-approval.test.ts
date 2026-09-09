import { test, expect } from 'bun:test';
import { needsApproval } from '../hooks/publish-approval';
test('only existing publishing modes ask', () => {
  expect(needsApproval('bun "/cache with space/file-issue.ts" /tmp/title /tmp/body bug')).toBe(true);
  expect(needsApproval('cd /tmp && bun /plugin/file-issue.ts --comment 4 /tmp/body')).toBe(true);
  for (const args of ['--check id', '--templates', 'classify bug /tmp/title /tmp/body']) expect(needsApproval(`bun /plugin/file-issue.ts ${args}`)).toBe(false);
  expect(needsApproval('echo "unrelated"')).toBe(false);
  expect(needsApproval('echo /plugin/file-issue.ts title body')).toBe(false);
  expect(needsApproval('bun /plugin/file-issue.ts --check id; bun /plugin/file-issue.ts title body')).toBe(true);
});
test('hook emits native ask with its reason', async () => {
  const proc = Bun.spawn(['bun', new URL('../hooks/publish-approval.ts', import.meta.url).pathname], { stdin: 'pipe', stdout: 'pipe' });
  proc.stdin.write(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'bun /plugin/file-issue.ts title body' } }));
  await proc.stdin.end();
  const output = JSON.parse(await new Response(proc.stdout).text());
  expect(await proc.exited).toBe(0);
  expect(output.hookSpecificOutput.permissionDecision).toBe('ask');
});

test('publication approval recognizes assignments and bun run', () => {
  for (const prefix of ['FOO=bar bun', 'bun run', 'FOO=bar OTHER="two words" bun run']) {
    expect(needsApproval(`${prefix} /plugin/file-issue.ts /tmp/title /tmp/body`)).toBe(true);
    expect(needsApproval(`${prefix} /plugin/file-issue.ts --comment 4 /tmp/body`)).toBe(true);
    expect(needsApproval(`${prefix} /plugin/file-issue.ts --check id`)).toBe(false);
    expect(needsApproval(`${prefix} /plugin/file-issue.ts --templates`)).toBe(false);
    expect(needsApproval(`${prefix} /plugin/file-issue.ts classify bug /tmp/title /tmp/body`)).toBe(false);
  }
});
