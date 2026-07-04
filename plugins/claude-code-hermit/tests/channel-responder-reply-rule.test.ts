// Channel-responder reply-rule contract test.
// (bun test port of test-channel-responder-reply-rule.sh)
//
// Asserts that the §0 reply-via-channel contract is present in the
// channel-responder skill, that the hook is registered in hooks.json, and
// that the hook script exists. Prevents silent regressions on future
// SKILL.md rewrites or hooks.json edits.
//
// Usage: bun test tests/channel-responder-reply-rule.test.ts   (from the plugin root)

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'channel-responder', 'SKILL.md');
const HOOKS_PATH = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'channel-reply-reminder.ts');

const skill = fs.readFileSync(SKILL_PATH, 'utf-8');

test('skill file exists', () => {
  expect(fs.existsSync(SKILL_PATH)).toBe(true);
});

test('skill has §0 heading', () => {
  expect(skill).toContain('## 0.');
});

test('skill §0 names reply via channel', () => {
  expect(skill).toContain('Reply via the channel');
});

test('skill §0 names generic reply tool pattern', () => {
  expect(skill).toContain('mcp__plugin_');
});

test('hooks.json has channel-reply-reminder entry', () => {
  expect(fs.readFileSync(HOOKS_PATH, 'utf-8')).toContain('channel-reply-reminder.ts');
});

test('channel-reply-reminder.ts exists and is non-empty', () => {
  expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
  expect(fs.statSync(SCRIPT_PATH).size).toBeGreaterThan(0);
});

// PROP-017: channel-safe approvals — resolver extension + bridge section.
test('resolver accepts numbered and label replies', () => {
  expect(skill).toContain('options[k-1]');
  expect(skill).toContain('case-insensitive prefix match');
});

test('channel-safe ask bridge section present', () => {
  expect(skill).toContain('Channel-safe ask bridge');
});

test('on_resolve resolution path present', () => {
  expect(skill).toContain('on_resolve');
  expect(skill).toContain('"action":"answered"');
});
