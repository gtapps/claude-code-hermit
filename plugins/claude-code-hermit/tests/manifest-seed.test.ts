// Contract test for scripts/manifest-seed.ts.
// Exercises the process boundary (stdin in, exit code/file out, fail-loud).

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';
import { setupWorkdir, Workdir } from './helpers/workdir';
import { sha256 } from '../scripts/lib/hash';

let wd: Workdir | null = null;
afterEach(() => {
  wd?.cleanup();
  wd = null;
});

function manifestPath(dir: string): string {
  return path.join(dir, '.claude-code-hermit', 'state', 'template-manifest.json');
}
function stateArg(dir: string): string {
  return path.join(dir, '.claude-code-hermit');
}
function readManifest(dir: string): any {
  return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
}

describe('manifest-seed: hashing + shape', () => {
  test('hashes a file correctly and stamps plugin_version', async () => {
    wd = setupWorkdir();
    const f = path.join(wd.dir, 'sample.txt');
    fs.writeFileSync(f, 'hello world\n');

    const r = await runScript('manifest-seed.ts', {
      args: [stateArg(wd.dir)],
      stdin: JSON.stringify({ pluginVersion: '1.2.9', entries: [{ key: 'templates/a', file: f }] }),
    });
    expect(r.exitCode).toBe(0);

    const m = readManifest(wd.dir);
    expect(m.version).toBe(1);
    expect(m.files['templates/a'].sha256).toBe(sha256(fs.readFileSync(f)));
    expect(m.files['templates/a'].plugin_version).toBe('1.2.9');
  });

  test('every written sha256 is 64-hex (shape evolve-plan validates)', async () => {
    wd = setupWorkdir();
    const f = path.join(wd.dir, 'sample.txt');
    fs.writeFileSync(f, 'data');
    await runScript('manifest-seed.ts', {
      args: [stateArg(wd.dir)],
      stdin: JSON.stringify({ pluginVersion: '1.0.0', entries: [{ key: 'bin/x', file: f }] }),
    });
    const m = readManifest(wd.dir);
    for (const v of Object.values(m.files) as any[]) {
      expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('manifest-seed: foreign-key preservation', () => {
  test('preserves untouched keys, overwrites re-seeded ones', async () => {
    wd = setupWorkdir();
    fs.writeFileSync(
      manifestPath(wd.dir),
      JSON.stringify({
        version: 1,
        files: {
          'templates/some-addon': { sha256: 'a'.repeat(64), plugin_version: '0.9.0' },
          'sibling-hermit/CLAUDE-APPEND.md': { sha256: 'b'.repeat(64), plugin_version: '0.9.0' },
          'templates/a': { sha256: 'c'.repeat(64), plugin_version: '0.9.0' },
        },
      }) + '\n',
    );
    const f = path.join(wd.dir, 'a.txt');
    fs.writeFileSync(f, 'new content');

    const r = await runScript('manifest-seed.ts', {
      args: [stateArg(wd.dir)],
      stdin: JSON.stringify({ pluginVersion: '1.2.9', entries: [{ key: 'templates/a', file: f }] }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('preserved 2 foreign keys');

    const m = readManifest(wd.dir);
    // Foreign keys survive untouched.
    expect(m.files['templates/some-addon'].sha256).toBe('a'.repeat(64));
    expect(m.files['sibling-hermit/CLAUDE-APPEND.md'].sha256).toBe('b'.repeat(64));
    // Re-seeded key overwritten with the real hash + new version.
    expect(m.files['templates/a'].sha256).toBe(sha256(fs.readFileSync(f)));
    expect(m.files['templates/a'].plugin_version).toBe('1.2.9');
  });
});

describe('manifest-seed: keyPrefix/dir enumeration', () => {
  test('enumerates the source dir, one entry per file', async () => {
    wd = setupWorkdir();
    const binSrc = path.join(wd.dir, 'src-bin');
    fs.mkdirSync(binSrc);
    fs.writeFileSync(path.join(binSrc, 'hermit-start'), '#!/usr/bin/env bun\n');
    fs.writeFileSync(path.join(binSrc, 'hermit-stop'), '#!/usr/bin/env bun\n');
    fs.mkdirSync(path.join(binSrc, 'subdir')); // must be ignored (non-recursive, files only)

    const r = await runScript('manifest-seed.ts', {
      args: [stateArg(wd.dir)],
      stdin: JSON.stringify({ pluginVersion: '1.0.0', entries: [{ keyPrefix: 'bin', dir: binSrc }] }),
    });
    expect(r.exitCode).toBe(0);

    const m = readManifest(wd.dir);
    expect(Object.keys(m.files).sort()).toEqual(['bin/hermit-start', 'bin/hermit-stop']);
  });
});

describe('manifest-seed: invalid existing manifest is fatal', () => {
  const cases: { name: string; content: string }[] = [
    { name: 'unparseable JSON', content: '{ not json' },
    { name: 'files not an object', content: JSON.stringify({ version: 1, files: [] }) },
    {
      name: 'existing entry with non-64-hex sha256',
      content: JSON.stringify({ version: 1, files: { 'templates/a': { sha256: 'short', plugin_version: '1' } } }),
    },
  ];
  for (const c of cases) {
    test(`${c.name} -> exit 1, file unchanged`, async () => {
      wd = setupWorkdir();
      fs.writeFileSync(manifestPath(wd.dir), c.content);
      const before = fs.readFileSync(manifestPath(wd.dir), 'utf8');
      const f = path.join(wd.dir, 'a.txt');
      fs.writeFileSync(f, 'x');

      const r = await runScript('manifest-seed.ts', {
        args: [stateArg(wd.dir)],
        stdin: JSON.stringify({ pluginVersion: '1.2.9', entries: [{ key: 'templates/a', file: f }] }),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('manifest-seed');
      // File left byte-for-byte unchanged.
      expect(fs.readFileSync(manifestPath(wd.dir), 'utf8')).toBe(before);
    });
  }
});

describe('manifest-seed: malformed stdin is fatal', () => {
  const bad: { name: string; stdin: string }[] = [
    { name: 'invalid JSON', stdin: 'not json' },
    { name: 'empty entries', stdin: JSON.stringify({ pluginVersion: '1', entries: [] }) },
    { name: 'missing pluginVersion', stdin: JSON.stringify({ entries: [{ key: 'a', file: '/x' }] }) },
    { name: 'empty stdin', stdin: '' },
  ];
  for (const b of bad) {
    test(`${b.name} -> exit 1, no manifest written`, async () => {
      wd = setupWorkdir();
      const r = await runScript('manifest-seed.ts', { args: [stateArg(wd.dir)], stdin: b.stdin });
      expect(r.exitCode).toBe(1);
      expect(fs.existsSync(manifestPath(wd.dir))).toBe(false);
    });
  }
});

// Contract: the three skills that call manifest-seed must hand it the intended
// SOURCE paths. Guards against a future edit pointing bin enumeration at the
// destination, or docker hashing rendered output.
describe('manifest-seed: skill-call source-path contract', () => {
  const read = (rel: string) => fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8');

  test('hatch enumerates the source state-templates/bin dir', () => {
    const hatch = read('skills/hatch/SKILL.md');
    expect(hatch).toContain('manifest-seed.ts');
    expect(hatch).toContain('state-templates/bin');
  });

  test('docker-setup delegates rendering + pipes the emitted manifestSeed', () => {
    // The upstream-.template-vs-on-disk-entrypoint source-path contract now lives
    // in render-docker-templates.ts, which emits the manifestSeed payload; it is
    // asserted behaviorally in tests/render-docker-templates.test.ts. Here we only
    // check the skill still routes rendering + manifest seeding through the scripts.
    const docker = read('skills/docker-setup/SKILL.md');
    expect(docker).toContain('render-docker-templates.ts');
    expect(docker).toContain('manifest-seed.ts');
  });

  test('render-docker-templates emits upstream .template files for the two substituted keys', () => {
    const script = read('scripts/render-docker-templates.ts');
    // Keys ending in .template map to plugin-root upstream templates (never rendered output).
    expect(script).toContain("'docker/docker-compose.hermit.yml.template'");
    expect(script).toContain("'docker/Dockerfile.hermit.template'");
    // The entrypoint key hashes the ON-DISK rendered copy at the project root.
    expect(script).toContain("'docker/docker-entrypoint.hermit.sh'");
    expect(script).toContain('entrypointPath');
  });

  test('hermit-evolve routes its manifest write through the script', () => {
    // Step 5b (manifest-seed invocation) lives in reference.md, read by the
    // evolve-runner subagent — SKILL.md is a thin routing stub that no longer
    // carries steps 0-9.
    const evolve = read('skills/hermit-evolve/reference.md');
    expect(evolve).toContain('manifest-seed.ts');
  });
});
