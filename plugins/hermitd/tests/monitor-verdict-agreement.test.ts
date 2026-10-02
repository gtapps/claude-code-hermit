import { afterAll, describe, expect, test } from 'bun:test';
import { checkHeartbeat, checkRoutineMonitor } from '../scripts/doctor-check';
import { heartbeatHealth } from '../scripts/lib/heartbeat/monitor-cmd';
import { routineHealth } from '../scripts/lib/routines/arm';
import { monitorFixture, type FixtureOpts } from './helpers/monitor-fixture';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('monitor-verdict-agreement-');
afterAll(cleanup);

// Fallback mode and the no-runtime.json gate are excluded: doctor owns those rules.
const variants: [string, FixtureOpts][] = [
  ['fresh', {}],
  ['stale beyond threshold', { heartbeatStartedAgoSecs: 20000, routineStartedAgoSecs: 20000, heartbeatTickAgoSecs: 10000, routineTickAgoSecs: 10000 }],
  ['within startup grace', { heartbeatStartedAgoSecs: 30, routineStartedAgoSecs: 30, heartbeatTickAgoSecs: null, routineTickAgoSecs: null }],
  ['boot mismatch', { bootId: 'current', heartbeatBootId: 'old', routineBootId: 'old' }],
  ['command drift', { commandDrift: true }],
  ['heartbeat interval drift', { intervalDrift: true }],
  ['heartbeat disabled', { heartbeatEnabled: false }],
  ['heartbeat runtime missing', { omitHeartbeatRuntime: true }],
  ['routine launch drift', { routineLaunchDrift: true }],
  ['liveness absent', { heartbeatTickAgoSecs: null, routineTickAgoSecs: null }],
  ['liveness predates registration', { heartbeatStartedAgoSecs: 4000, routineStartedAgoSecs: 4000, heartbeatTickAgoSecs: 5000, routineTickAgoSecs: 5000 }],
];

for (const [name, opts] of variants) {
  describe(name, () => {
    test('heartbeat agrees', () => {
      const { hermitDir, config, paths } = monitorFixture(freshDir, opts);
      expect(checkHeartbeat(paths).status === 'ok').toBe(heartbeatHealth(hermitDir, config, Date.now()).healthy);
    });
    test('routine monitor agrees', () => {
      const { hermitDir, paths } = monitorFixture(freshDir, opts);
      expect(checkRoutineMonitor(paths).status === 'ok').toBe(routineHealth(hermitDir, Date.now()).healthy);
    });
  });
}
