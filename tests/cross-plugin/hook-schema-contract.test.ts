// Cross-plugin guard for the hook config schema Claude Code enforces.
//
// Claude Code validates hook config against a closed schema and prints
// `unknown keys "…" ignored` at every session start for anything outside it.
// Documenting a hook inline — a `description` or `profile` sitting next to
// `matcher` — is the tempting way to earn that warning, and it earned one on
// every hermit install until this guard existed. The keys below are the
// documented schema: https://code.claude.com/docs/en/hooks, /plugins-reference
//
// Two emission sites, one schema: every plugin's hooks/hooks.json, and the
// per-boot launch overlay that hermit-start writes to its --settings file.
// A fix that covers only the first leaves always-on hermits still warning.
//
// Lives at the repo root (outside every plugin's `bun test` / run-all.sh
// discovery) so it never blocks a plugin release; the path-scoped
// test-cross-plugin.yml workflow already runs it on `plugins/*/hooks/**` and
// `plugins/claude-code-hermit/scripts/**`, which is every path that can break
// it. Core's own suite is not wired to `plugins/*/hooks/**`, so a sibling-only
// hooks.json edit would not have triggered this guard there.

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');

const ROOT_KEYS = new Set(['description', 'hooks']);
const GROUP_KEYS = new Set(['matcher', 'hooks']);
// Every hook in the fleet is `type: command`, so this is the command surface
// only. Claude Code's real schema is a discriminated union per `type`; adding
// the http/mcp_tool/prompt/agent keys here would widen this into a flat union
// that accepts a stray `server` or `prompt` on a command entry. When the fleet
// gains a second hook type, give this a per-type set rather than merging.
const ENTRY_KEYS = new Set([
  'type', 'timeout', 'statusMessage', 'once', 'if',
  'command', 'args', 'async', 'asyncRewake', 'shell',
]);

// A failure here means one of two things: someone documented a hook inline
// (delete the key, the prose belongs in the hook script's header), or Claude
// Code legalized a new key (add it above, citing the docs).
function checkEventMap(events: Record<string, any>, where: string): string[] {
  const problems: string[] = [];
  for (const [event, groups] of Object.entries(events ?? {})) {
    (groups as any[]).forEach((group, i) => {
      for (const k of Object.keys(group)) {
        if (!GROUP_KEYS.has(k)) problems.push(`${where} ${event}[${i}]: unknown matcher-group key "${k}"`);
      }
      for (const entry of group.hooks ?? []) {
        for (const k of Object.keys(entry)) {
          if (!ENTRY_KEYS.has(k)) problems.push(`${where} ${event}[${i}].hooks: unknown hook key "${k}"`);
        }
      }
    });
  }
  return problems;
}

test('every fleet hooks.json and the launch overlay use only schema keys', async () => {
  const pluginsDir = path.join(ROOT, 'plugins');
  const hookFiles = fs
    .readdirSync(pluginsDir)
    .map((slug) => path.join(pluginsDir, slug, 'hooks', 'hooks.json'))
    .filter((p) => fs.existsSync(p))
    .sort();

  const problems: string[] = [];

  for (const file of hookFiles) {
    const rel = path.relative(ROOT, file);
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const k of Object.keys(doc)) {
      if (!ROOT_KEYS.has(k)) problems.push(`${rel}: unknown root key "${k}"`);
    }
    problems.push(...checkEventMap(doc.hooks, rel));
  }

  const { overlayHooks } = await import(
    path.join(ROOT, 'plugins', 'claude-code-hermit', 'scripts', 'lib', 'settings', 'overlay-hooks.ts')
  );
  problems.push(...checkEventMap(overlayHooks(path.join(ROOT, 'plugins', 'claude-code-hermit')), 'launch overlay'));

  expect(problems).toEqual([]);
  // Path-resolution guard: zero files means the scan is broken, not that all is well.
  expect(hookFiles.length).toBeGreaterThan(0);
});
