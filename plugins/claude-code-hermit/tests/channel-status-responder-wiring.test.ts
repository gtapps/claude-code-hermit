// Wiring guard for the deterministic status responder — mirrors
// channel-responder-reply-rule.test.ts. Prevents a hooks.json edit from
// silently dropping the responder registration.

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const HOOKS_PATH = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
const RESPONDER_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'channel-status-responder.ts');
const SEND_LIB = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'channel-send.ts');
const SEND_CLI = path.join(PLUGIN_ROOT, 'scripts', 'channel-send.ts');

test('channel-status-responder.ts exists and is non-empty', () => {
  expect(fs.existsSync(RESPONDER_SCRIPT)).toBe(true);
  expect(fs.statSync(RESPONDER_SCRIPT).size).toBeGreaterThan(0);
});

test('lib/channel-send.ts exists and is non-empty', () => {
  expect(fs.existsSync(SEND_LIB)).toBe(true);
  expect(fs.statSync(SEND_LIB).size).toBeGreaterThan(0);
});

test('channel-send.ts CLI exists and is non-empty', () => {
  expect(fs.existsSync(SEND_CLI)).toBe(true);
  expect(fs.statSync(SEND_CLI).size).toBeGreaterThan(0);
});

test('hooks.json registers channel-status-responder.ts on UserPromptSubmit', () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf-8'));
  const entries = hooks.hooks.UserPromptSubmit ?? [];
  const registered = entries.some((e: any) =>
    (e.hooks ?? []).some((h: any) => (h.args ?? []).some((a: string) => a.includes('channel-status-responder.ts')))
  );
  expect(registered).toBe(true);
});
