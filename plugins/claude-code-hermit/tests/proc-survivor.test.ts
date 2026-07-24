import { test, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { terminateSurvivors } from '../scripts/lib/proc';

// Isolated in its own file: a long-lived, signal-ignoring fixture is unreliable
// late in a spawn-heavy file under `bun test`. Here it runs in a clean process.

let child: { pid: number } | null = null;
afterEach(() => {
  if (child) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    child = null;
  }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('terminateSurvivors reports a SIGTERM-ignoring process as a survivor', async () => {
  process.env.HERMIT_STOP_GRACE_MS = '50';
  process.env.HERMIT_TERM_WAIT_MS = '400';

  // `sh` installs the TERM-ignore trap first, then touches the ready marker, then
  // loops forever (the loop stops sh exec-optimizing into the sleep, so sh itself
  // stays alive as the trap owner). We only fire SIGTERM once the marker exists,
  // so the signal never lands during startup where the default action would win.
  const ready = path.join(os.tmpdir(), `proc-survivor-${process.pid}-${Date.now()}`);
  const script = `trap "" TERM; : > "${ready}"; while :; do sleep 1; done`;
  const c = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  c.unref();
  child = { pid: c.pid! };

  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await wait(50);
  expect(fs.existsSync(ready)).toBe(true);
  try { fs.unlinkSync(ready); } catch {}

  const survivors = await terminateSurvivors([c.pid!]);
  expect(survivors).toContain(c.pid!);
});
