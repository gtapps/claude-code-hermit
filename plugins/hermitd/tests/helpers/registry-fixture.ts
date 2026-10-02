// Shared fixture bits for Claude Code's session registry
// (<config dir>/sessions/<pid>.json).
//
// lib/session-registry.ts validates an entry against the live machine — pid
// alive, `procStart` matching /proc/<pid>/stat field 22, `pidDomain` matching
// this boot and pid namespace — so a fixture that hardcodes those values is
// dropped as stale before any test assertion runs. Every consumer therefore
// builds them from this process, and they all did it with their own copy of
// the same two /proc reads until this file.
//
// Plain .ts, not *.test.ts: bunfig.toml's test glob would otherwise register
// it as a (empty) test file.

import fs from 'node:fs';
import path from 'node:path';

/** Field 22 of /proc/<pid>/stat, or null where /proc isn't published (macOS) —
 *  which is also where session-registry skips the check entirely, so tests use
 *  the null to derive the platform's expected verdict. */
export function procStartOf(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/** This machine's pid domain in the registry's spelling. The placeholder is
 *  deliberate: off Linux the lib skips the comparison, so any value passes. */
export function localPidDomain(): string {
  try {
    const machineId = fs.readFileSync('/etc/machine-id', 'utf-8').trim();
    return `linux:${machineId}:${fs.readlinkSync('/proc/self/ns/pid')}`;
  } catch {
    return 'linux:unknown:pid:[0]';
  }
}

/** The identity fields of a registry entry for this process — everything the
 *  lib validates. Spread first so a test's own `...patch` can override any of
 *  them (that is how the pid-reuse and wrong-domain cases are built). */
export function localIdentity(): { pid: number; procStart: string; pidDomain: string } {
  return {
    pid: process.pid,
    procStart: procStartOf(process.pid) ?? '1',
    pidDomain: localPidDomain(),
  };
}

/** Writes a `<config dir>/sessions/<pid>.json` entry that survives the lib's validation.
 *  Not localIdentity(): callers build entries for pids other than this process (a live
 *  parent, a dead one), so the identity is per-pid. `patch` overrides any field. */
export function writeRegistryEntry(configDir: string, pid: number, patch: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'sessions', `${pid}.json`), JSON.stringify({
    pid,
    procStart: procStartOf(pid) ?? '1',
    pidDomain: localPidDomain(),
    sessionId: `sess-${pid}`,
    kind: 'interactive',
    status: 'idle',
    statusUpdatedAt: Date.now(),
    cwd: '/tmp/project',
    name: `session-${pid}`,
    ...patch,
  }));
}
