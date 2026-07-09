// Tests for scripts/cron-registry.ts — the diff-based plan/commit planner behind
// hermit-routines `load`. planCron/commitCron are pure (no fs, no Date.now()), so
// these are in-process unit tests, not subprocess runs — the real boundary
// (reading config.json/the mirror file, writing the mirror) is exercised by the
// CLI wiring, which the hermit-routines content-contract tests below pin at the
// SKILL.md-prose level instead of re-implementing a fs harness here.
//
// Coverage mirrors the acceptance criteria from the audit-driven design: unchanged
// config is a no-op; a metadata/schedule edit forces exactly that routine's
// delete+create; a boot-id mismatch or missing/corrupt mirror treats every enabled
// routine as needing (re-)creation with NO deletes (durable:false crons already
// died with the prior process); an entry aged past the conservative re-register
// threshold is recreated even with unchanged config, so a long-lived process can
// never silently ride a routine past CC's real 7-day auto-expiry cliff.

import { describe, test, expect } from 'bun:test';
import { planCron, commitCron, promptHash, REREGISTER_AGE_MS } from '../scripts/cron-registry';
import { shiftCron } from '../scripts/cron-tz-shift';

const PLUGIN_ROOT = '/plugin';
const BOOT_A = 'boot-aaa';
const T0 = Date.parse('2026-06-01T00:00:00Z');

function r(id: string, overrides: Record<string, any> = {}) {
  return { id, skill: `claude-code-hermit:${id}`, schedule: '0 9 * * *', enabled: true, ...overrides };
}

function seedMirror(routines: any[], schedules: Record<string, string>, registeredAt: number, bootId = BOOT_A) {
  const entries: Record<string, any> = {};
  for (const routine of routines) {
    entries[routine.id] = {
      prompt_hash: promptHash(routine, schedules[routine.id] ?? routine.schedule, PLUGIN_ROOT),
      registered_at: registeredAt,
    };
  }
  return { boot_id: bootId, routines: entries };
}

describe('planCron — unchanged / fresh', () => {
  test('unchanged config, matching boot id, all fresh → KEEP everything, no mutations', () => {
    const routines = [r('a'), r('b')];
    const mirror = seedMirror(routines, {}, T0 - 1000);
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.keepCount).toBe(2);
  });

  test('boot id mismatch → every enabled routine is CREATE, no DELETE', () => {
    const routines = [r('a'), r('b')];
    const mirror = seedMirror(routines, {}, T0 - 1000, 'boot-old');
    const plan = planCron(routines, mirror, 'boot-new', PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(plan.keepCount).toBe(0);
  });

  test('missing/corrupt mirror (boot_id null, empty routines) → all CREATE, no DELETE', () => {
    const routines = [r('a'), r('b')];
    const emptyMirror = { boot_id: null, routines: {} };
    const plan = planCron(routines, emptyMirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(plan.keepCount).toBe(0);
  });

  test('--force (load --reset) → all CREATE, no DELETE, even with a matching fresh mirror', () => {
    const routines = [r('a'), r('b')];
    const mirror = seedMirror(routines, {}, T0 - 1000);
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0, /* forceReset */ true);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(plan.keepCount).toBe(0);
  });
});

describe('planCron — targeted changes', () => {
  test('one routine edited (skill changed) → exactly that id DELETE+CREATE, the other KEEPs', () => {
    const before = [r('a'), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a', { skill: 'claude-code-hermit:a-renamed' }), r('b')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
    expect(plan.keepCount).toBe(1);
  });

  test('routine removed from config → DELETE only, no matching CREATE', () => {
    const before = [r('a'), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['b']);
    expect(plan.creates).toEqual([]);
    expect(plan.keepCount).toBe(1);
  });

  test('routine disabled (enabled:false) → treated same as removed: DELETE only', () => {
    const before = [r('a'), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a'), r('b', { enabled: false })];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['b']);
    expect(plan.creates).toEqual([]);
    expect(plan.keepCount).toBe(1);
  });

  test('routine added to config → CREATE only, others KEEP', () => {
    const before = [r('a')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a'), r('c')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates.map(c => c.id)).toEqual(['c']);
    expect(plan.keepCount).toBe(1);
  });

  test('entry aged past REREGISTER_AGE_MS → DELETE+CREATE even with unchanged config', () => {
    const routines = [r('a'), r('b')];
    const freshMirror = seedMirror(routines, {}, T0 - 1000);
    const staleAt = T0 - REREGISTER_AGE_MS - 1000;
    const mirror = { ...freshMirror, routines: { ...freshMirror.routines, a: { ...freshMirror.routines.a, registered_at: staleAt } } };
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
    expect(plan.keepCount).toBe(1);
  });

  test('entry just under the age threshold → still KEEP', () => {
    const routines = [r('a')];
    const freshEnoughAt = T0 - REREGISTER_AGE_MS + 60_000; // 1 minute inside the window
    const mirror = seedMirror(routines, {}, freshEnoughAt);
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.keepCount).toBe(1);
  });

  test('duplicate enabled ids in config register once, not twice', () => {
    const routines = [r('a'), r('a')]; // config foot-gun — validate-config only warns on dup ids
    const mirror = { boot_id: null, routines: {} };
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.creates.map(c => c.id)).toEqual(['a']); // a single CREATE, not a duplicate live cron
  });

  test('malformed mirror entry (non-finite registered_at) fails safe to re-register, not KEEP', () => {
    const routines = [r('a')];
    const mirror = {
      boot_id: BOOT_A,
      routines: { a: { prompt_hash: promptHash(r('a'), '0 9 * * *', PLUGIN_ROOT), registered_at: NaN } },
    };
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
    expect(plan.keepCount).toBe(0);
  });

  test('DST-driven schedule shift changes the hash → DELETE+CREATE despite a fresh registered_at', () => {
    // Reuses the Europe/Lisbon fixture from cron-tz-shift.test.ts: winter Lisbon=UTC+0
    // (no shift), summer Lisbon=UTC+1 (1h shift) — the same schedule/tz pair produces
    // two different registered crons depending on which instant `load` runs at.
    const winter = Date.parse('2026-01-15T12:00:00Z');
    const summer = Date.parse('2026-07-15T12:00:00Z');
    const routine = r('a', { schedule: '0 4 * * *' });
    const winterShift = shiftCron('0 4 * * *', 'Europe/Lisbon', 'UTC', new Date(winter)).result;
    const summerShift = shiftCron('0 4 * * *', 'Europe/Lisbon', 'UTC', new Date(summer)).result;
    expect(winterShift).not.toBe(summerShift); // sanity: this pair actually shifts across the transition

    const mirror = {
      boot_id: BOOT_A,
      routines: { a: { prompt_hash: promptHash(routine, winterShift, PLUGIN_ROOT), registered_at: summer - 1000 } },
    };
    const plan = planCron([routine], mirror, BOOT_A, PLUGIN_ROOT, 'Europe/Lisbon', 'UTC', summer);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates).toEqual([{ id: 'a', schedule: summerShift, warn: undefined }]);
    expect(plan.keepCount).toBe(0);
  });
});

describe('commitCron', () => {
  test('created ids are stamped with now + the new boot id', () => {
    const routines = [r('a')];
    const mirror = { boot_id: 'boot-old', routines: {} };
    const plan = planCron(routines, mirror, 'boot-new', PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(routines.map(x => [x.id, x]));
    const next = commitCron(mirror, plan, new Set(['a']), routineById, PLUGIN_ROOT, 'boot-new', T0);
    expect(next.boot_id).toBe('boot-new');
    expect(next.routines.a.registered_at).toBe(T0);
    expect(next.routines.a.prompt_hash).toBe(promptHash(routines[0], plan.creates[0].schedule, PLUGIN_ROOT));
  });

  test('KEEP entries carry forward with registered_at unchanged (not restamped)', () => {
    const routines = [r('a'), r('b')];
    const mirror = seedMirror(routines, {}, T0 - 1000);
    const after = [r('a'), r('b', { skill: 'claude-code-hermit:b-renamed' })];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(after.map(x => [x.id, x]));
    const next = commitCron(mirror, plan, new Set(['b']), routineById, PLUGIN_ROOT, BOOT_A, T0);
    expect(next.routines.a).toEqual(mirror.routines.a); // untouched KEEP entry, byte-identical
  });

  test('a plan.creates id absent from createdIds (failed CronCreate) is not recorded', () => {
    const routines = [r('a'), r('b')];
    const mirror = { boot_id: 'boot-old', routines: {} };
    const plan = planCron(routines, mirror, 'boot-new', PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(routines.map(x => [x.id, x]));
    // Only 'a' actually succeeded; 'b's CronCreate threw.
    const next = commitCron(mirror, plan, new Set(['a']), routineById, PLUGIN_ROOT, 'boot-new', T0);
    expect(next.routines.a).toBeDefined();
    expect(next.routines.b).toBeUndefined(); // stays missing → next plan() sees it as CREATE again
  });

  test('boot-mismatch commit drops a prior-boot entry not created this boot (no ghost KEEP)', () => {
    // Prior boot had {a (still enabled), x (disabled/removed while down)}. After a restart
    // the bootMismatch plan CREATEs only the enabled set and issues NO deletes, so commit
    // must not resurrect x — else a later boot-match load would misread x as a live KEEP
    // although its durable:false cron died with the prior process and was never recreated.
    const priorMirror = {
      boot_id: 'boot-old',
      routines: {
        a: { prompt_hash: promptHash(r('a'), '0 9 * * *', PLUGIN_ROOT), registered_at: T0 - 1000 },
        x: { prompt_hash: promptHash(r('x'), '0 9 * * *', PLUGIN_ROOT), registered_at: T0 - 1000 },
      },
    };
    const enabled = [r('a')];
    const plan = planCron(enabled, priorMirror, 'boot-new', PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(enabled.map(x => [x.id, x]));
    const next = commitCron(priorMirror, plan, new Set(['a']), routineById, PLUGIN_ROOT, 'boot-new', T0);
    expect(next.routines.x).toBeUndefined(); // ghost not carried forward
    expect(next.routines.a).toBeDefined();
    expect(next.routines.a.registered_at).toBe(T0); // recreated this boot, freshly stamped
  });

  test('a DELETE id is dropped from the mirror', () => {
    const routines = [r('a'), r('b')];
    const mirror = seedMirror(routines, {}, T0 - 1000);
    const after = [r('a')]; // 'b' removed
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(after.map(x => [x.id, x]));
    const next = commitCron(mirror, plan, new Set([]), routineById, PLUGIN_ROOT, BOOT_A, T0);
    expect(next.routines.b).toBeUndefined();
    expect(next.routines.a).toEqual(mirror.routines.a); // 'a' was an untouched KEEP
  });
});
