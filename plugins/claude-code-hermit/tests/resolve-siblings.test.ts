import { describe, test, expect } from 'bun:test';
import { runScript } from './helpers/run';

const ROOT = '/home/user/project';

// Fixture plugin-list entries spanning every filter case.
const FIXTURE = [
  // kept: core at local scope, this project
  { id: 'claude-code-hermit@claude-code-hermit', scope: 'local', enabled: true, projectPath: ROOT, installPath: '/i/core' },
  // kept: sibling hermit, project scope, this project
  { id: 'claude-code-dev-hermit@claude-code-hermit', scope: 'project', enabled: true, projectPath: ROOT, installPath: '/i/dev' },
  // kept: hermit-scribe — contains "hermit" but not "-hermit"; must survive siblings role
  { id: 'hermit-scribe@claude-code-hermit', scope: 'local', enabled: true, projectPath: ROOT, installPath: '/i/scribe' },
  // kept: a non-hermit channel plugin (dropped only by siblings role)
  { id: 'discord@claude-plugins-official', scope: 'local', enabled: true, projectPath: ROOT, installPath: '/i/discord' },
  // dropped: user scope
  { id: 'claude-code-fitness-hermit@claude-code-hermit', scope: 'user', enabled: true, projectPath: ROOT, installPath: '/i/fit' },
  // dropped: disabled
  { id: 'laravel-forge-hermit@claude-code-hermit', scope: 'local', enabled: false, projectPath: ROOT, installPath: '/i/forge' },
  // dropped: cross-project
  { id: 'other-hermit@claude-code-hermit', scope: 'local', enabled: true, projectPath: '/home/user/other', installPath: '/i/other' },
];

async function run(args: string[], stdin: string) {
  const r = await runScript('resolve-siblings.ts', { args: [...args, '--stdin-json'], stdin });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

describe('resolve-siblings.ts', () => {
  test('canonical filter (role all): drops user, disabled, cross-project', async () => {
    const out = await run([ROOT], JSON.stringify(FIXTURE));
    const plugins = out.map((e: any) => e.plugin).sort();
    expect(plugins).toEqual(['claude-code-dev-hermit', 'claude-code-hermit', 'discord', 'hermit-scribe']);
    // shape carries id + parsed fields
    const dev = out.find((e: any) => e.plugin === 'claude-code-dev-hermit');
    expect(dev).toEqual({
      plugin: 'claude-code-dev-hermit',
      id: 'claude-code-dev-hermit@claude-code-hermit',
      marketplace_name: 'claude-code-hermit',
      scope: 'project',
      projectPath: ROOT,
      installPath: '/i/dev',
      enabled: true,
    });
  });

  test('role siblings: *-hermit* plus hermit-scribe, excludes core and channel', async () => {
    const out = await run([ROOT, '--role', 'siblings'], JSON.stringify(FIXTURE));
    const plugins = out.map((e: any) => e.plugin).sort();
    expect(plugins).toEqual(['claude-code-dev-hermit', 'hermit-scribe']);
  });

  test('role core-scope: local precedence → target local', async () => {
    const out = await run([ROOT, '--role', 'core-scope'], JSON.stringify(FIXTURE));
    expect(out).toEqual({ core_scope: 'local', target: 'local' });
  });

  test('role core-scope: project scope → target committed', async () => {
    const list = [
      { id: 'claude-code-hermit@claude-code-hermit', scope: 'project', enabled: true, projectPath: ROOT, installPath: '/i/core' },
    ];
    const out = await run([ROOT, '--role', 'core-scope'], JSON.stringify(list));
    expect(out).toEqual({ core_scope: 'project', target: 'committed' });
  });

  test('role core-scope: local wins over project when both present', async () => {
    const list = [
      { id: 'claude-code-hermit@claude-code-hermit', scope: 'project', enabled: true, projectPath: ROOT, installPath: '/i/p' },
      { id: 'claude-code-hermit@claude-code-hermit', scope: 'local', enabled: true, projectPath: ROOT, installPath: '/i/l' },
    ];
    const out = await run([ROOT, '--role', 'core-scope'], JSON.stringify(list));
    expect(out).toEqual({ core_scope: 'local', target: 'local' });
  });

  test('role core-scope: user fallback ignores projectPath → target local', async () => {
    const list = [
      { id: 'claude-code-hermit@claude-code-hermit', scope: 'user', enabled: true, projectPath: '/somewhere/else', installPath: '/i/u' },
    ];
    const out = await run([ROOT, '--role', 'core-scope'], JSON.stringify(list));
    expect(out).toEqual({ core_scope: 'user', target: 'local' });
  });

  test('role core-scope: no core entry → null / target local', async () => {
    const list = [
      { id: 'discord@claude-plugins-official', scope: 'local', enabled: true, projectPath: ROOT, installPath: '/i/d' },
    ];
    const out = await run([ROOT, '--role', 'core-scope'], JSON.stringify(list));
    expect(out).toEqual({ core_scope: null, target: 'local' });
  });

  test('dedupe: keeps local over project for same (plugin, marketplace)', async () => {
    const list = [
      { id: 'discord@claude-plugins-official', scope: 'project', enabled: true, projectPath: ROOT, installPath: '/i/p' },
      { id: 'discord@claude-plugins-official', scope: 'local', enabled: true, projectPath: ROOT, installPath: '/i/l' },
    ];
    const out = await run([ROOT, '--dedupe'], JSON.stringify(list));
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe('local');
    expect(out[0].installPath).toBe('/i/l');
  });

  test('dedupe: different marketplaces stay distinct', async () => {
    const list = [
      { id: 'discord@mp-a', scope: 'local', enabled: true, projectPath: ROOT, installPath: '/i/a' },
      { id: 'discord@mp-b', scope: 'project', enabled: true, projectPath: ROOT, installPath: '/i/b' },
    ];
    const out = await run([ROOT, '--dedupe'], JSON.stringify(list));
    expect(out).toHaveLength(2);
  });

  test('empty / malformed stdin degrades to []', async () => {
    const out = await run([ROOT], 'not json');
    expect(out).toEqual([]);
  });
});
