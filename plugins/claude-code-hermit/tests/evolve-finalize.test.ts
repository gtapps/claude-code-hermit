// bun test suite for scripts/evolve-finalize.ts — the deterministic
// _hermit_versions writer that replaces the LLM hand-edit in evolve step 9.
// These are the regression tests for issue #426 (silent dropped version bump).
//
// Usage: bun test tests/evolve-finalize.test.ts   (from the plugin root)

import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { finalize } from '../scripts/evolve-finalize';
import { runScript } from './helpers/run';

// Fake plugin root with plugin.json version "1.2.6" (shared, read-only across tests).
let PR: string;

beforeAll(() => {
  PR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-finalize-pr-'));
  fs.mkdirSync(path.join(PR, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(PR, '.claude-plugin', 'plugin.json'), '{"version":"1.2.6"}\n');
});

afterAll(() => {
  try { fs.rmSync(PR, { recursive: true, force: true }); } catch {}
});

/** Run a test body against a throwaway hermit dir, always cleaning up. */
function withProj(fn: (hermitDir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-finalize-'));
    try { await fn(dir); } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
}

const writeConfig = (dir: string, content: string) =>
  fs.writeFileSync(path.join(dir, 'config.json'), content);

const readConfig = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

// -------------------------------------------------------
// 1. #426 regression — core bump actually lands on disk
// -------------------------------------------------------

test('#426 regression: core bump lands and confirmed', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"claude-code-hermit":"1.2.5"}}');
  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(result.core.requested).toBe('1.2.6');
  expect(result.core.confirmed).toBe('1.2.6');
  expect(result.core.matched).toBe(true);
  expect(result.errors).toEqual([]);

  // Independently verify the on-disk file actually changed
  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['claude-code-hermit']).toBe('1.2.6');
}));

// -------------------------------------------------------
// 2. Step-9 keys preserved — only _hermit_versions.claude-code-hermit changes
// -------------------------------------------------------

test('step-9 keys preserved: other keys untouched after bump', withProj(async (dir) => {
  writeConfig(dir, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.2.5' },
    model: 'sonnet',
    reflection: { graduation_min_sessions: 1 },
    routines: [{ id: 'brief' }],
  }, null, 2));

  finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['claude-code-hermit']).toBe('1.2.6');
  expect(onDisk.model).toBe('sonnet');
  expect(onDisk.reflection).toEqual({ graduation_min_sessions: 1 });
  expect(onDisk.routines).toEqual([{ id: 'brief' }]);
}));

// -------------------------------------------------------
// 3. Sibling present → applied; sibling NOT a key → skipped, not added
// -------------------------------------------------------

test('sibling present: bumped and confirmed', withProj(async (dir) => {
  writeConfig(dir, JSON.stringify({
    _hermit_versions: {
      'claude-code-hermit': '1.2.5',
      'claude-code-dev-hermit': '0.3.0',
    },
  }));
  const result = finalize({
    hermitDir: dir,
    core: '1.2.6',
    pluginRoot: PR,
    siblings: [{ name: 'claude-code-dev-hermit', version: '0.4.0' }],
  });

  expect(result.ok).toBe(true);
  expect(result.siblings_confirmed['claude-code-dev-hermit']).toBe('0.4.0');
  expect(result.siblings_skipped).toEqual([]);

  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['claude-code-dev-hermit']).toBe('0.4.0');
}));

test('sibling NOT a key: skipped, not added to config', withProj(async (dir) => {
  writeConfig(dir, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.2.5' },
  }));
  const result = finalize({
    hermitDir: dir,
    core: '1.2.6',
    pluginRoot: PR,
    siblings: [{ name: 'foo-hermit', version: '1.0.0' }],
  });

  expect(result.ok).toBe(true);
  expect(result.siblings_skipped).toContain('foo-hermit');
  expect('foo-hermit' in result.siblings_confirmed).toBe(false);

  const onDisk = readConfig(dir);
  expect('foo-hermit' in onDisk._hermit_versions).toBe(false); // key must NOT be added
}));

// -------------------------------------------------------
// 4. --core ≠ plugin.json.version → refuse, file unchanged
// -------------------------------------------------------

test('core_version_mismatch: --core differs from plugin.json → error, file unchanged', withProj(async (dir) => {
  const original = '{"_hermit_versions":{"claude-code-hermit":"1.2.5"}}';
  writeConfig(dir, original);

  const result = finalize({ hermitDir: dir, core: '1.2.9', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(false);
  expect(result.errors.map(e => e.code)).toContain('core_version_mismatch');
  expect(result.core.confirmed).toBeNull(); // no write attempted

  // File must be unchanged
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(original);
}));

// -------------------------------------------------------
// 5. Missing config → no_config; malformed config → config_json_invalid
// -------------------------------------------------------

test('no_config: missing config.json → error, exit behavior', withProj(async (dir) => {
  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(false);
  expect(result.errors.map(e => e.code)).toContain('no_config');
}));

test('config_json_invalid: malformed JSON → error, bytes unchanged', withProj(async (dir) => {
  const bad = '{"_hermit_versions":';
  writeConfig(dir, bad);

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(false);
  expect(result.errors.map(e => e.code)).toContain('config_json_invalid');

  // Original bytes must be unchanged
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(bad);
}));

// -------------------------------------------------------
// 6. Missing --core → no_core_target, no write
// -------------------------------------------------------

test('no_core_target: --core absent → error, no file touched', withProj(async (dir) => {
  const original = '{"_hermit_versions":{"claude-code-hermit":"1.2.5"}}';
  writeConfig(dir, original);

  const result = finalize({ hermitDir: dir, core: null, pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(false);
  expect(result.errors.map(e => e.code)).toContain('no_core_target');
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(original);
}));

test('no_core_target: empty --core string → error', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"claude-code-hermit":"1.2.5"}}');
  const result = finalize({ hermitDir: dir, core: '', pluginRoot: null, siblings: [] });
  expect(result.errors.map(e => e.code)).toContain('no_core_target');
}));

// -------------------------------------------------------
// 7. _hermit_versions absent entirely → created, core key set
// -------------------------------------------------------

test('_hermit_versions absent: created and core key set', withProj(async (dir) => {
  writeConfig(dir, '{"model":"sonnet"}');

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(result.core.confirmed).toBe('1.2.6');

  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['claude-code-hermit']).toBe('1.2.6');
  expect(onDisk.model).toBe('sonnet'); // other keys preserved
}));

// -------------------------------------------------------
// 8. Idempotency — running twice produces identical file
// -------------------------------------------------------

test('idempotency: second run is a no-op, both ok:true', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"claude-code-hermit":"1.2.5"}}');

  const r1 = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });
  expect(r1.ok).toBe(true);
  const afterFirst = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

  const r2 = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });
  expect(r2.ok).toBe(true);
  const afterSecond = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

  expect(afterSecond).toBe(afterFirst);
}));

// -------------------------------------------------------
// 9. Sibling version contains dots + = in rest of version string
// -------------------------------------------------------

test('sibling first-= split: name and version parsed correctly', withProj(async (dir) => {
  writeConfig(dir, JSON.stringify({
    _hermit_versions: { 'claude-code-hermit': '1.2.5', 'x-hermit': '0.1.0' },
  }));
  const result = finalize({
    hermitDir: dir,
    core: '1.2.6',
    pluginRoot: PR,
    siblings: [{ name: 'x-hermit', version: '1.2.3.4' }],
  });

  expect(result.ok).toBe(true);
  expect(result.siblings_confirmed['x-hermit']).toBe('1.2.3.4');
  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['x-hermit']).toBe('1.2.3.4');
}));

// -------------------------------------------------------
// 10. Exit code via subprocess (the actual binary contract)
// -------------------------------------------------------

test('process exit 0 on success', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"claude-code-hermit":"1.2.5"}}');
  const r = await runScript('evolve-finalize.ts', {
    args: [dir, `--core=1.2.6`, `--plugin-root=${PR}`],
  });
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.ok).toBe(true);
  expect(out.core.confirmed).toBe('1.2.6');
}));

test('process exit 1 on error (no_config)', withProj(async (dir) => {
  // No config.json
  const r = await runScript('evolve-finalize.ts', {
    args: [dir, `--core=1.2.6`, `--plugin-root=${PR}`],
  });
  expect(r.exitCode).toBe(1);
  const out = JSON.parse(r.stdout);
  expect(out.ok).toBe(false);
  expect(out.errors.map((e: any) => e.code)).toContain('no_config');
}));

test('process exit 1 on mismatch (core_version_mismatch)', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"claude-code-hermit":"1.2.5"}}');
  const r = await runScript('evolve-finalize.ts', {
    args: [dir, `--core=9.9.9`, `--plugin-root=${PR}`],
  });
  expect(r.exitCode).toBe(1);
  const out = JSON.parse(r.stdout);
  expect(out.ok).toBe(false);
  expect(out.errors.map((e: any) => e.code)).toContain('core_version_mismatch');
}));

// -------------------------------------------------------
// 11. malformed --sibling: goes to siblings_skipped, does not affect ok
// -------------------------------------------------------

test('malformed sibling: goes to siblings_skipped, core still bumps, ok:true', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"claude-code-hermit":"1.2.5"}}');
  const result = finalize({
    hermitDir: dir,
    core: '1.2.6',
    pluginRoot: PR,
    siblings: [{ name: 'bad-hermit', version: '' }], // malformed (no version)
  });

  expect(result.siblings_skipped.some(s => s.includes('bad-hermit'))).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.core.confirmed).toBe('1.2.6');
  expect(result.ok).toBe(true);
}));
