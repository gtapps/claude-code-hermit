import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';

const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'spawn-session', 'SKILL.md');
const skill = fs.readFileSync(SKILL_PATH, 'utf-8');

test('conversation helpers route decisions through progress and end their turn', () => {
  expect(skill).toContain('Never call AskUserQuestion');
  expect(skill).toContain('When you need a decision, send `PROGRESS <key> <generation>: needs input: <question>` and end your turn.');
});
