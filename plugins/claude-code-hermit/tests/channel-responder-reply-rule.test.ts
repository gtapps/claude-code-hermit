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
// The reminder is now a stage of scripts/user-prompt-pipeline.ts, not a
// separately-registered hook script — the file moved, the registration is the
// pipeline's. Test names below still say "channel-reply-reminder" because the
// guarantee they pin is unchanged.
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'prompt-stages', 'channel-reply-reminder.ts');

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
  expect(fs.readFileSync(HOOKS_PATH, 'utf-8')).toContain('user-prompt-pipeline.ts');
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

// default_chat_id pin: chat-id persistence is hook-owned. §1e used to hand the
// model a config.json write recipe, which bypassed the hook's transcript-verified
// inbound gate and its maintainer-chat exclusion. A future SKILL.md rewrite must
// not reintroduce it.
test('§1e delegates chat-id persistence to the hook — no model-side write recipe', () => {
  expect(skill).toContain('hook-owned');
  expect(skill).toMatch(/never edit either field by hand/i);
  expect(skill).not.toMatch(/store the inbound `chat_id`/i);
});

test('§1e names the pinned proactive home', () => {
  expect(skill).toContain('default_chat_id');
});

// The pin is what keeps unattended sends (and no-allowlist control authority)
// from following whoever wrote last. Moving it is an asked write: the native
// permission prompt, not a terminal-only fence.
test('hermit-settings describes the briefing chat as an asked write', () => {
  const settings = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills', 'hermit-settings', 'SKILL.md'), 'utf-8',
  );
  expect(settings).toContain('briefing_chat');
  expect(settings).toContain('default_chat_id');
  expect(settings).toContain('This write raises the native permission prompt');
});
