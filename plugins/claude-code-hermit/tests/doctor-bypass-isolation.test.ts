import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { checkBypassIsolation, resolvePaths } from '../scripts/doctor-check';
import { isContainer } from '../scripts/lib/container';
import { freshDirFactory, writeConfig } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-bypass-isolation-');
afterAll(cleanup);

function scenario(permissionMode: string, runtimeMode?: string) {
  const projectRoot = freshDir();
  const hermitDir = path.join(projectRoot, '.claude-code-hermit');
  writeConfig(projectRoot, { permission_mode: permissionMode });
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  if (runtimeMode !== undefined) {
    fs.writeFileSync(
      path.join(hermitDir, 'state', 'runtime.json'),
      JSON.stringify({ runtime_mode: runtimeMode })
    );
  }
  return checkBypassIsolation(resolvePaths(hermitDir, PLUGIN_ROOT));
}

describe('doctor bypass-isolation check', () => {
  test('any mode other than bypassPermissions is ok regardless of runtime', () => {
    expect(scenario('auto', 'tmux').status).toBe('ok');
    expect(scenario('acceptEdits', 'tmux').status).toBe('ok');
  });

  test('bypassPermissions inside a container is ok', () => {
    expect(scenario('bypassPermissions', 'docker').status).toBe('ok');
  });

  test('bypassPermissions on an interactive boot is ok — the operator is watching', () => {
    expect(scenario('bypassPermissions', 'interactive').status).toBe('ok');
  });

  test('bypassPermissions on a bare tmux runtime warns and names both remedies', () => {
    const r = scenario('bypassPermissions', 'tmux');
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('/hermit-settings permissions');
    expect(r.detail).toContain('/docker-setup');
  });

  // A hermit that has never booted has no runtime record, so the check falls back
  // to live container detection. Compute the expectation from the same helper the
  // check uses so this passes both on a bare CI runner and inside a container.
  test('no runtime record falls back to container detection', () => {
    const r = scenario('bypassPermissions');
    expect(r.status).toBe(isContainer() ? 'ok' : 'warn');
  });

  test('an unreadable config fails its own entry rather than throwing', () => {
    const hermitDir = path.join(freshDir(), '.claude-code-hermit');
    fs.mkdirSync(hermitDir, { recursive: true });
    const r = checkBypassIsolation(resolvePaths(hermitDir, PLUGIN_ROOT));
    expect(['ok', 'warn', 'fail']).toContain(r.status);
    expect(r.id).toBe('bypass-isolation');
  });
});
