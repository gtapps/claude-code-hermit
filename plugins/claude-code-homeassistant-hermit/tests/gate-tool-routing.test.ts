// Tests for the tool-name routing added to mcp-safety-gate.ts when the matcher
// widened from `mcp__homeassistant__Hass.*` to `mcp__homeassistant__.*`.
//
// These exercise behavior that has NO Python counterpart (the retired gate never
// read tool_name), so they live here rather than in the golden corpus — keeping
// gate-corpus.test.ts byte-equal with the Python gate and free of divergence
// markers. PreToolUse exit semantics: 0 = allow (empty stdout) / ask (JSON
// stdout); 2 = block.

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupTmp, makeHaConfig, makeHaConfigWith } from './helpers';

const MCP_HOOK = join(import.meta.dir, '..', 'hooks', 'mcp-safety-gate.ts');

afterAll(cleanupTmp);

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

// An isolated tmp root carrying an explicit strict config, never a repo-internal
// path: projectRoot() walks up to 8 ancestor dirs looking for
// .claude-code-hermit/config.json, and import.meta.dir sits well within that
// range of this repo's own root — an operator with a hermit hatched there would
// have silently flipped every default-cwd "blocks under strict" assertion below
// to ask mode.
const STRICT_CWD = makeHaConfig('strict');

function runGate(stdin: string, cwd: string = STRICT_CWD) {
  const r = Bun.spawnSync([process.execPath, MCP_HOOK], {
    stdin: Buffer.from(stdin, 'utf8'),
    env: cleanEnv(),
    cwd,
    timeout: 10_000,
  });
  return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** A temp project dir carrying a given ha_safety_mode in config.json. */
function askModeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ha-gate-'));
  mkdirSync(join(dir, '.claude-code-hermit'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-code-hermit', 'config.json'),
    JSON.stringify({ ha_safety_mode: 'ask' }),
  );
  return dir;
}


test('read-only tool with no entity is allowed', () => {
  const r = runGate(JSON.stringify({ tool_name: 'mcp__homeassistant__GetLiveContext', tool_input: {} }));
  expect(r.exit).toBe(0);
  expect(r.stdout).toBe('');
});

test('GetDateTime read-only tool is allowed', () => {
  const r = runGate(JSON.stringify({ tool_name: 'mcp__homeassistant__GetDateTime', tool_input: {} }));
  expect(r.exit).toBe(0);
  expect(r.stdout).toBe('');
});

test('read-only allow is mode-independent (still allows under ask mode)', () => {
  const dir = askModeCwd();
  try {
    const r = runGate(
      JSON.stringify({ tool_name: 'mcp__homeassistant__GetLiveContext', tool_input: {} }),
      dir,
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown non-entity tool fails closed (blocks)', () => {
  // A script-style actuation tool that carries no entity_id — e.g. an exposed
  // HA script tool. The widened matcher now routes it here; with no resolvable
  // target it must block, not slip through.
  const r = runGate(JSON.stringify({ tool_name: 'mcp__homeassistant__armar_alarme', tool_input: {} }));
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
  expect(r.stderr).not.toBe('');
});

test('unknown tool carrying a sensitive entity still blocks under strict', () => {
  const r = runGate(
    JSON.stringify({
      tool_name: 'mcp__homeassistant__SomeActuator',
      tool_input: { entity_id: 'lock.front_door' },
    }),
  );
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
});

test('non-read-only tool with a safe concrete entity is allowed', () => {
  const r = runGate(
    JSON.stringify({
      tool_name: 'mcp__homeassistant__HassTurnOn',
      tool_input: { entity_id: 'light.living_room' },
    }),
  );
  expect(r.exit).toBe(0);
  expect(r.stdout).toBe('');
});

test('a non-string tool_name does not bypass the gate (falls through to fail-closed)', () => {
  const r = runGate(JSON.stringify({ tool_name: 123, tool_input: {} }));
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
});

const SENSITIVE_CALL = JSON.stringify({
  tool_name: 'mcp__homeassistant__HassTurnOn',
  tool_input: { entity_id: 'lock.front_door' },
});

test('ask mode: sensitive entity emits permissionDecision ask', () => {
  const dir = askModeCwd();
  try {
    const r = runGate(SENSITIVE_CALL, dir);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain('"permissionDecision": "ask"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Hass* intent tool with no entity_id blocks when assist control is disabled', () => {
  const r = runGate(
    JSON.stringify({ tool_name: 'mcp__homeassistant__HassTurnOn', tool_input: { name: 'living room lights' } }),
  );
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
});

test('Hass* intent tool with no entity_id allows when assist control is enabled', () => {
  const dir = makeHaConfigWith('ask', { ha_assist_control_enabled: true });
  try {
    const r = runGate(
      JSON.stringify({ tool_name: 'mcp__homeassistant__HassTurnOn', tool_input: { name: 'living room lights' } }),
      dir,
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
