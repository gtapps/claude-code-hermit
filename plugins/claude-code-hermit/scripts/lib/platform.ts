/**
 * Host platform probe — advisory, never a gate.
 *
 * `hatch` uses this to order the deployment choices it offers: Docker is the
 * right default on a Linux host that has it, but on macOS and WSL2 Docker means
 * a second VM, so bare tmux plus the watchdog timer is the better recommendation
 * there. Always-on itself works on all three (bin/hermit-start +
 * bin/hermit-watchdog install), so nothing here decides what CAN run — only what
 * gets recommended first.
 *
 * Read-only and fail-open: an unreadable /proc/version means "not WSL", never an
 * error. The one real platform gate lives in hermit-start.ts, which refuses
 * win32 outright; win32 therefore never reaches this probe in practice and maps
 * to 'linux' if it somehow does.
 */

import fs from 'node:fs';

export type HostPlatform = 'linux' | 'macos' | 'wsl2';

export type HostInfo = {
  platform: HostPlatform;
  docker: boolean;
  systemd: boolean;
  launchd: boolean;
};

export type DetectOptions = {
  platform?: NodeJS.Platform;
  procVersionPath?: string;
  env?: Record<string, string | undefined>;
};

/**
 * WSL2 tells on two independent signals; either is sufficient.
 *
 * WSL_DISTRO_NAME is set by WSL itself in every interactive shell, but a
 * systemd user unit or a cron job started outside that shell may not carry it,
 * so /proc/version (which holds "microsoft" on both WSL1 and WSL2 kernels) is
 * the durable one. We do not separate WSL1 from WSL2 here: hermit's own
 * always-on path works on both, and Claude Code's sandbox already reports the
 * WSL1 case itself.
 */
function isWsl(procVersionPath: string, env: Record<string, string | undefined>): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync(procVersionPath, 'utf8'));
  } catch {
    return false;
  }
}

export function detectPlatform(opts: DetectOptions = {}): HostInfo {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const procVersionPath = opts.procVersionPath ?? '/proc/version';

  let host: HostPlatform;
  if (platform === 'darwin') host = 'macos';
  else if (isWsl(procVersionPath, env)) host = 'wsl2';
  else host = 'linux';

  return {
    platform: host,
    docker: !!Bun.which('docker'),
    systemd: !!Bun.which('systemctl'),
    launchd: host === 'macos' && !!Bun.which('launchctl'),
  };
}
