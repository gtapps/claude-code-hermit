import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';
const read = (skill: string) => fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
it('intake uses the bounded task digest and injected policy', () => {
  const text = read('channel-responder');
  const pre = text.slice(text.indexOf('## 1. Load Context'), text.indexOf('## 1c.'));
  expect(pre).toContain('task.ts list');
  expect(pre).toContain('record-operator-action.ts --force');
  expect(pre).toContain('injected TASKS.md');
  expect(pre).not.toContain('session-archive.ts');
});
it('responder routes assignments, steering, confirmations and completions to task', () => {
  const text = read('channel-responder');
  for (const term of ['/hermitd:task', 'TASKS.md threshold', 'annotated task thread',
    'confirmation, cancel or changed definition of done', '[conversation command: ...]', 'WORKER <task-id>',
    'Acknowledge first', 'steering, never a second record']) expect(text).toContain(term);
});
it('a chat assignment opens a resident record and hands it to a worker', () => {
  const text = read('task');
  expect(text).toContain('[task thread <key>: ');
  expect(text).toContain('--owner resident --conversation <key>');
  expect(text).toContain('hermitd:task-worker');
  expect(text).toContain('--owner worker:<agentId>');
  expect(text).not.toContain('conversation.ts bind');
});
it('the worker is steered by id and replaced only when that send fails', () => {
  const rule = read('task');
  expect(rule).toContain('SendMessage');
  expect(rule).toContain('Only when that send fails');
  expect(rule).toContain('helper-reports/<id>-history.md');
  expect(rule).not.toContain('claude --bg');
});
it('parks a resident-owned record as waiting', () => {
  const rule = read('task');
  expect(rule).toContain('Park the task');
  expect(rule).toContain('--waiting-on <requester>');
});
it('a completion notice posts the report and blocks the record', () => {
  const text = read('task');
  expect(text).toContain('WORKER <task-id> done <id>');
  expect(text).toContain('WORKER <task-id> needs-input <id>');
  expect(text).toContain('[[helper-report <id>]]');
  expect(text).toContain('--result-stdin');
});
it('the status summary lists worker-owned records', () => {
  const text = read('task');
  expect(text).toContain("--open --owner 'worker:*' --json");
});
