import { expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tick } from '../scripts/hermitd-watchdog';
import { watchdogWorld } from './helpers/watchdog-world';

test('orphan across two ticks sends one notice and never restarts', async () => {
  const f = watchdogWorld();
  try {
    f.signals.alive = false;
    f.signals.age = 10;
    await tick(f.world);
    await tick(f.world);
    expect(f.notices).toHaveLength(1);
    expect(f.restarts).toEqual([]);
  } finally { f.cleanup(); }
});

test('dead session requests one restart', async () => {
  const f = watchdogWorld();
  try {
    f.signals.alive = false;
    await tick(f.world);
    expect(f.restarts).toEqual(['dead-process']);
  } finally { f.cleanup(); }
});

function staleHeartbeat(f: ReturnType<typeof watchdogWorld>) {
  const heartbeat = path.join(f.world.paths.stateDir, '.heartbeat');
  fs.writeFileSync(heartbeat, '');
  const old = new Date(f.now - 24 * 3600000);
  fs.utimesSync(heartbeat, old, old);
  f.put('state/heartbeat-monitor.runtime.json', { started_at: old.toISOString() });
  f.put('state/watchdog-state.json', {
    last_pane_hash: crypto.createHash('sha256').update(f.signals.pane).digest('hex'),
  });
}

test('heartbeat escalation stops the tick after the restart', async () => {
  const f = watchdogWorld();
  try {
    staleHeartbeat(f);
    await tick(f.world);
    expect(f.restarts).toEqual(['pane-frozen']);
    expect(f.signals.checks).toEqual([true]);
    expect(f.keys).toEqual([]);
  } finally { f.cleanup(); }
});

test('env-auth failure stops before heartbeat escalation', async () => {
  const f = watchdogWorld();
  try {
    f.put('state/runtime.json', { runtime_mode: 'tmux', tmux_session: 'resident', env_auth: true });
    f.signals.pane = '401 Invalid authentication credentials';
    staleHeartbeat(f);
    await tick(f.world);
    expect(f.notices).toHaveLength(1);
    expect(f.restarts).toEqual([]);
    expect(f.keys).toEqual([]);
  } finally { f.cleanup(); }
});

test('pending question suppresses heartbeat and monitor keys', async () => {
  const f = watchdogWorld();
  try {
    f.signals.pane = 'Set up something?\n\n❯ Continue\n\nEnter to continue';
    staleHeartbeat(f);
    f.put('state/heartbeat-monitor.runtime.json', { started_at: new Date(f.now - 24 * 3600000).toISOString() });
    await tick(f.world);
    expect(f.notices).toHaveLength(1);
    expect(f.restarts).toEqual([]);
    expect(f.keys).toEqual([]);
  } finally { f.cleanup(); }
});

test('a live session with stale monitor liveness re-arms at the safe boundary', async () => {
  const f = watchdogWorld();
  try {
    staleHeartbeat(f);
    const heartbeat = path.join(f.world.paths.stateDir, '.heartbeat');
    const now = new Date(f.now);
    fs.utimesSync(heartbeat, now, now);
    await tick(f.world);
    expect(f.restarts).toEqual([]);
    expect(f.keys).toEqual(['/hermitd:heartbeat start']);
  } finally { f.cleanup(); }
});
