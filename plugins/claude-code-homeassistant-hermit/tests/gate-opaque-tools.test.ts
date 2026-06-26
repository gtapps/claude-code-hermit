// Behavioral tests for opaque MCP tools — calls that reach the gate with no
// resolvable entity_id and no targeting selector (the canonical case is a
// script-derived tool like mcp__homeassistant__unlock_front, which carries
// only its own fields). These behaviors are NEW relative to the retired Python
// gate, so they live here rather than in the byte-equivalence corpus: the
// corpus divergence channel asserts py.stdout === ts.stdout, which can't
// represent "TS emits an ask decision while Python blocks".
//
// Contract:
//   strict -> block (exit 2), becomes a proposal
//   ask    -> prompt (exit 0 + permissionDecision "ask")
// Read-only tools (GetLiveContext/GetDateTime) allow in BOTH modes.
// The unresolvable-selector fan-out invariant still hard-blocks in BOTH modes.

import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { cleanEnv, cleanupTmp, makeHaConfig, tmpPath } from './helpers';

const MCP_HOOK = join(import.meta.dir, '..', 'hooks', 'mcp-safety-gate.ts');

afterEach(cleanupTmp);

function runGate(stdin: string, mode?: string) {
  const cwd = mode !== undefined ? makeHaConfig(mode) : tmpPath();
  const r = Bun.spawnSync([process.execPath, MCP_HOOK], {
    cwd,
    env: cleanEnv(),
    stdin: Buffer.from(stdin, 'utf8'),
    timeout: 10_000,
  });
  return { exit: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const SCRIPT_TOOL = JSON.stringify({
  tool_name: 'mcp__homeassistant__unlock_front',
  tool_input: {},
});

test('opaque script tool blocks under strict', () => {
  const r = runGate(SCRIPT_TOOL, 'strict');
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
  expect(r.stderr).not.toBe('');
});

test('opaque script tool blocks when mode is absent (defaults strict)', () => {
  const r = runGate(SCRIPT_TOOL);
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
});

test('opaque script tool prompts under ask', () => {
  const r = runGate(SCRIPT_TOOL, 'ask');
  expect(r.exit).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
    'mcp__homeassistant__unlock_front',
  );
});

test('read-only tools allow in both modes', () => {
  for (const mode of ['strict', 'ask']) {
    for (const name of ['GetLiveContext', 'GetDateTime']) {
      const r = runGate(
        JSON.stringify({ tool_name: `mcp__homeassistant__${name}`, tool_input: {} }),
        mode,
      );
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    }
  }
});

test('unresolvable area_id selector hard-blocks even under ask', () => {
  const r = runGate(JSON.stringify({ tool_input: { area_id: 'kitchen' } }), 'ask');
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
});

// A Hass* intent tool targets by name/area, which HA fans out server-side to
// an entity set the gate cannot enumerate. It must hard-block in EVERY mode
// (the old Hass.* matcher did; the widened matcher must not downgrade it to a
// prompt). Only bare-named script tools are mode-dependent.
test('Hass* intent tool with name/area target hard-blocks even under ask', () => {
  for (const input of [{ name: 'front gate' }, { area: 'garage' }]) {
    const r = runGate(
      JSON.stringify({ tool_name: 'mcp__homeassistant__HassTurnOff', tool_input: input }),
      'ask',
    );
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe('');
  }
});
