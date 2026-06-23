import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run';

const tmpdirs: string[] = [];
function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-dpf-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpdirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

async function run(projectRoot: string) {
  const r = await runScript('docker-preflight.ts', { args: [projectRoot] });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

describe('docker-preflight.ts', () => {
  test('clean project: stable shape, fail-open fields', async () => {
    const dir = freshDir();
    const out = await run(dir);

    // dockerVersion is host-dependent — string or null, never throws.
    expect(out.dockerVersion === null || typeof out.dockerVersion === 'string').toBe(true);
    expect(out.configExists).toBe(false);
    expect(out.existing).toEqual({ dockerfile: false, entrypoint: false, compose: false });
    expect(typeof out.gitconfigExists).toBe('boolean');
    // path key is derived from the project root passed in (mirrors `pwd | sed 's|/|-|g'`,
    // leading dash retained) — keyed off the supplied logical path, not a resolved one.
    expect(out.memory.pathKey).toBe(dir.replace(/\//g, '-'));
    expect(typeof out.memory.seedExists).toBe('boolean');
  });

  test('detects config.json and existing docker files', async () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.claude-code-hermit'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, 'Dockerfile.hermit'), 'FROM ubuntu\n');
    fs.writeFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'services: {}\n');

    const out = await run(dir);
    expect(out.configExists).toBe(true);
    expect(out.existing.dockerfile).toBe(true);
    expect(out.existing.compose).toBe(true);
    expect(out.existing.entrypoint).toBe(false);
  });
});
