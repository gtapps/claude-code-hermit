// WP8: tests for hooks/curl-host-gate.ts — 1:1 port of
// tests/test_curl_host_gate.py (7 cases), run against the TS gate.

import { expect, test } from 'bun:test';
import { join } from 'node:path';

const HOOK = join(import.meta.dir, '..', 'hooks', 'curl-host-gate.ts');

const HA_LOCAL = 'http://homeassistant.local:8123';

function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env['HOMEASSISTANT_URL'];
  delete env['HOMEASSISTANT_LOCAL_URL'];
  delete env['HOMEASSISTANT_REMOTE_URL'];
  delete env['CLAUDE_PROJECT_DIR'];
  return env;
}

function spawnHook(payload: unknown, env: Record<string, string>) {
  const r = Bun.spawnSync([process.execPath, HOOK], {
    stdin: Buffer.from(JSON.stringify(payload), 'utf8'),
    env,
  });
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString().trim();
  return out ? JSON.parse(out) : null;
}

function run(command: string, toolName = 'Bash', extraEnv: Record<string, string> = {}) {
  const env = { ...cleanEnv(), HOMEASSISTANT_LOCAL_URL: HA_LOCAL, ...extraEnv };
  return spawnHook({ tool_name: toolName, tool_input: { command } }, env);
}

test('curl ha local allows', () => {
  const out = run(`curl ${HA_LOCAL}/api/states`);
  expect(out).not.toBeNull();
  expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
});

test('curl loopback allows when no ha url configured', () => {
  const out = spawnHook(
    { tool_name: 'Bash', tool_input: { command: 'curl http://127.0.0.1:8123/api/' } },
    cleanEnv(),
  );
  expect(out).not.toBeNull();
  expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
});

test('curl loopback passthrough when remote ha configured', () => {
  const out = run('curl http://127.0.0.1:8123/api/');
  expect(out).toBeNull();
});

test('non-ha curl passthrough', () => {
  const out = run('curl https://example.com/data');
  expect(out).toBeNull();
});

test('non-bash passthrough', () => {
  const out = run('/tmp/x', 'Read');
  expect(out).toBeNull();
});

test('unrelated bash passthrough', () => {
  const out = run('ls -la /tmp');
  expect(out).toBeNull();
});

test('curl ha url allows', () => {
  const haUrl = 'https://myha.nabu.casa';
  const out = run(`curl ${haUrl}/api/states`, 'Bash', { HOMEASSISTANT_URL: haUrl });
  expect(out).not.toBeNull();
  expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
});
