import { describe, test, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { pidAlive } from '../scripts/lib/lockfile';
import { paneRootPids, collectTree, terminateSurvivors } from '../scripts/lib/proc';

// These tests spawn real process trees. Two hazards, both handled by polling
// rather than fixed sleeps: (1) under `bun test` load the child can take
// hundreds of ms to actually fork its own children, so we poll until the tree
// materializes instead of guessing a wait; (2) a detached child must be reaped
// as a process GROUP (negative pid) or its sleep grandchildren linger.
//
// Every test here is `test.serial` by necessity, not by taste: bunfig.toml's
// `concurrentTestGlob` runs bodies concurrently and then batches the
// `afterEach`es, so one teardown drains `pids` — the LAST module-scope value —
// and SIGKILLs a process another in-flight test is still polling for. Observed
// directly: two tests spawned 1ms apart, then a single afterEach drained both.
// That killed the root of `cap marks the result unverified`, whose poll could
// then never see 3 pids and burned its whole deadline on CI under `--parallel`.
// It also let `a cooperative process is terminated` pass for the wrong reason —
// a SIGKILLed process is not a survivor either. `describe.serial` is silently
// ignored (Bun 1.3.14 and 1.4.0), and the non-spawning tests need it too since
// the shared afterEach fires for them as well. Drop it only after giving each
// test its own pid list.
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

/** Poll `fn` until it returns true, or throw naming the unmet condition. */
async function pollUntil(fn: () => boolean, timeoutMs = 15000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await wait(stepMs);
  }
  if (!fn()) throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

describe('collectTree', () => {
  test.serial('includes descendants of the root', async () => {
    const root = spawnProc(['bash', '-c', 'sleep 30 & sleep 30 & wait']);
    // Wait for the two sleep children to actually fork (parent + 2 = 3).
    await pollUntil(() => collectTree([root]).pids.length >= 3);
    const { pids: tree, capped } = collectTree([root]);
    expect(capped).toBe(false);
    expect(tree).toContain(root);
    expect(tree.length).toBeGreaterThanOrEqual(3);
  }, 30000);

  test.serial('cap marks the result unverified', async () => {
    const root = spawnProc(['bash', '-c', 'sleep 30 & sleep 30 & wait']);
    await pollUntil(() => collectTree([root]).pids.length >= 3);
    // With children present and cap 1, the traversal must report itself capped.
    expect(collectTree([root], 1).capped).toBe(true);
  }, 30000);
});

describe('terminateSurvivors', () => {
  test.serial('empty input returns empty', async () => {
    expect(await terminateSurvivors([])).toEqual([]);
  });

  test.serial('already-dead pids return empty', async () => {
    const pid = spawnProc(['sleep', '0.05']);
    await pollUntil(() => !pidAlive(pid)); // wait for natural exit
    expect(await terminateSurvivors([pid])).toEqual([]);
  }, 30000);

  test.serial('a cooperative process is terminated (not reported as survivor)', async () => {
    process.env.HERMIT_STOP_GRACE_MS = '50';
    process.env.HERMIT_TERM_WAIT_MS = '400';
    const pid = spawnProc(['sleep', '30']);
    await pollUntil(() => pidAlive(pid));
    expect(await terminateSurvivors([pid])).toEqual([]);
  }, 30000);

  // NOTE: the "SIGTERM-ignoring process is reported as a survivor" case lives in
  // its own file (proc-survivor.test.ts). Spawning a long-lived signal-ignoring
  // process is unreliable late in a spawn-heavy file under `bun test` load, so it
  // gets a clean process to itself.
});

describe('paneRootPids', () => {
  test.serial('empty session name yields no pids', () => {
    expect(paneRootPids('')).toEqual([]);
  });

  test.serial('a non-existent tmux session yields no pids', () => {
    expect(paneRootPids('hermit-does-not-exist-xyz')).toEqual([]);
  });
});
