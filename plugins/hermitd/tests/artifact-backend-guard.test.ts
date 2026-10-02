// Contract tests for scripts/artifact-backend-guard.ts — the PreToolUse
// binding gate on Artifact publish when artifacts.backend is not "claude".
// Exercised as a subprocess (stdin in, exit code out), the same boundary
// Claude Code sees.
//
// Usage: bun test tests/artifact-backend-guard.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { withDir, writeConfig } from './helpers/workdir';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function setBackend(dir: string, backend: string) {
  writeConfig(dir, { artifacts: { backend } });
}

const PUBLISH_PAYLOAD = { tool_name: 'Artifact', tool_input: { action: 'publish' } };

const run = (payload: object, dir: string) =>
  runScript('artifact-backend-guard.ts', {
    stdin: JSON.stringify(payload),
    cwd: dir,
  });

describe('artifact-backend-guard', () => {
  test('backend "claude" publish — allow', withDir(async (dir) => {
    setBackend(dir, 'claude');
    const r = await run(PUBLISH_PAYLOAD, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('no config.json — fail-open, allow', withDir(async (dir) => {
    const r = await run(PUBLISH_PAYLOAD, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('backend "dropartifact", action "publish" — deny, names the file to publish', withDir(async (dir) => {
    setBackend(dir, 'dropartifact');
    const r = await run(
      { tool_name: 'Artifact', tool_input: { action: 'publish', file_path: '/tmp/page.html' } },
      dir,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('dropartifact');
    expect(r.stderr).toContain('/tmp/page.html');
  }));

  test('backend "dropartifact", no action — deny, names backend and MCP tools', withDir(async (dir) => {
    setBackend(dir, 'dropartifact');
    const r = await run({ tool_name: 'Artifact', tool_input: {} }, dir);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('dropartifact');
    expect(r.stderr).toContain('mcp__dropartifact__');
  }));

  test('backend "dropartifact", action "read" — allow', withDir(async (dir) => {
    setBackend(dir, 'dropartifact');
    const r = await run({ tool_name: 'Artifact', tool_input: { action: 'read' } }, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('config.json is not JSON — fail-open, allow', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{not json');
    const r = await run(PUBLISH_PAYLOAD, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('tool_name "Read" with a dropartifact backend — allow', withDir(async (dir) => {
    setBackend(dir, 'dropartifact');
    const r = await run({ tool_name: 'Read', tool_input: { file_path: 'x.md' } }, dir);
    expect(r.exitCode).toBe(0);
  }));
});
