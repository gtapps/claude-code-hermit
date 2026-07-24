import { describe, test, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { pidAlive } from '../scripts/lib/lockfile';
import { paneRootPids, collectTree, terminateSurvivors } from '../scripts/lib/proc';

// These tests spawn real process trees. Two hazards, both handled by polling
// rather than fixed sleeps: (1) under `bun test` load the child can take
// hundreds of ms to actually fork its own children, so we poll until the tree
// materializes instead of guessing a wait; (2) a detached child must be reaped
// as a process GROUP (negative pid) or its sleep grandchildren linger.
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
});

/** Spawn a detached process, record its pid for cleanup, return the pid. */
function spawnProc(cmd: string[]): number {
  const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore' });
  child.unref();
  pids.push(child.pid!);
  return child.pid!;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns true or the timeout elapses. */
async function pollUntil(fn: () => boolean, timeoutMs = 4000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await wait(stepMs);
  }
  return fn();
}

describe('collectTree', () => {
  test('includes descendants of the root', async () => {
    const root = spawnProc(['bash', '-c', 'sleep 5 & sleep 5 & wait']);
    // Wait for the two sleep children to actually fork (parent + 2 = 3).
    await pollUntil(() => collectTree([root]).pids.length >= 3);
    const { pids: tree, capped } = collectTree([root]);
    expect(capped).toBe(false);
    expect(tree).toContain(root);
    expect(tree.length).toBeGreaterThanOrEqual(3);
  });

  test('cap marks the result unverified', async () => {
    const root = spawnProc(['bash', '-c', 'sleep 5 & sleep 5 & wait']);
    await pollUntil(() => collectTree([root]).pids.length >= 3);
    // With children present and cap 1, the traversal must report itself capped.
    expect(collectTree([root], 1).capped).toBe(true);
  });
});

describe('terminateSurvivors', () => {
  test('empty input returns empty', async () => {
    expect(await terminateSurvivors([])).toEqual([]);
  });

  test('already-dead pids return empty', async () => {
    const pid = spawnProc(['sleep', '0.05']);
    await pollUntil(() => !pidAlive(pid)); // wait for natural exit
    expect(await terminateSurvivors([pid])).toEqual([]);
  });

  test('a cooperative process is terminated (not reported as survivor)', async () => {
    process.env.HERMIT_STOP_GRACE_MS = '50';
    process.env.HERMIT_TERM_WAIT_MS = '400';
    const pid = spawnProc(['sleep', '30']);
    await pollUntil(() => pidAlive(pid));
    expect(await terminateSurvivors([pid])).toEqual([]);
  });

  // NOTE: the "SIGTERM-ignoring process is reported as a survivor" case lives in
  // its own file (proc-survivor.test.ts). Spawning a long-lived signal-ignoring
  // process is unreliable late in a spawn-heavy file under `bun test` load, so it
  // gets a clean process to itself.
});

describe('paneRootPids', () => {
  test('empty session name yields no pids', () => {
    expect(paneRootPids('')).toEqual([]);
  });

  test('a non-existent tmux session yields no pids', () => {
    expect(paneRootPids('hermit-does-not-exist-xyz')).toEqual([]);
  });
});
