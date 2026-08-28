import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { detectPlatform } from '../scripts/lib/platform';
import { freshDirFactory } from './helpers/workdir';
import { runScript } from './helpers/run';

const { freshDir, cleanup } = freshDirFactory('hermit-host-platform-');
afterAll(cleanup);

/** Write a fake /proc/version and return its path. */
function procVersion(contents: string): string {
  const p = path.join(freshDir(), 'version');
  fs.writeFileSync(p, contents);
  return p;
}

const LINUX = 'Linux version 6.8.0-137-generic (buildd@lcy02) #137-Ubuntu SMP';
const WSL = 'Linux version 5.15.167.4-microsoft-standard-WSL2 (root@build) #1 SMP';

describe('detectPlatform', () => {
  test('darwin is macos, and never consults /proc/version', () => {
    const info = detectPlatform({ platform: 'darwin', procVersionPath: procVersion(WSL), env: {} });
    expect(info.platform).toBe('macos');
  });

  test('plain linux kernel is linux', () => {
    const info = detectPlatform({ platform: 'linux', procVersionPath: procVersion(LINUX), env: {} });
    expect(info.platform).toBe('linux');
  });

  test('microsoft in /proc/version is wsl2', () => {
    const info = detectPlatform({ platform: 'linux', procVersionPath: procVersion(WSL), env: {} });
    expect(info.platform).toBe('wsl2');
  });

  test('WSL_DISTRO_NAME alone is enough — a timer-launched shell may not have /proc/version readable', () => {
    const info = detectPlatform({
      platform: 'linux',
      procVersionPath: procVersion(LINUX),
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
    });
    expect(info.platform).toBe('wsl2');
  });

  test('unreadable /proc/version means not WSL, never a throw', () => {
    const info = detectPlatform({
      platform: 'linux',
      procVersionPath: path.join(freshDir(), 'does-not-exist'),
      env: {},
    });
    expect(info.platform).toBe('linux');
  });

  test('launchd is only ever reported on macos', () => {
    expect(detectPlatform({ platform: 'linux', procVersionPath: procVersion(LINUX), env: {} }).launchd).toBe(false);
  });
});

describe('host-platform.ts CLI', () => {
  test('prints one JSON object with the four fields and exits 0', async () => {
    const r = await runScript('host-platform.ts');
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(['linux', 'macos', 'wsl2']).toContain(out.platform);
    expect(typeof out.docker).toBe('boolean');
    expect(typeof out.systemd).toBe('boolean');
    expect(typeof out.launchd).toBe('boolean');
  });
});
