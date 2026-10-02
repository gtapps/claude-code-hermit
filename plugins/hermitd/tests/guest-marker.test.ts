// Guest-session marker lib — the residency verdict carried from SessionStart to
// the per-turn hooks.
//
// Usage: bun test tests/guest-marker.test.ts   (from the plugin root)

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { clearGuest, isGuest, markGuest, pruneGuestMarkers } from '../scripts/lib/guest-marker';
import { withDir } from './helpers/workdir';

const stateOf = (dir: string) => path.join(dir, '.hermit', 'state');

describe('guest-marker', () => {
  test('a marked session reads as a guest, an unmarked one does not', withDir(async (dir) => {
    const stateDir = stateOf(dir);
    markGuest(stateDir, 'sess-abc');
    expect(isGuest(stateDir, 'sess-abc')).toBe(true);
    expect(isGuest(stateDir, 'sess-other')).toBe(false);
  }));

  test('an unusable session id writes nothing and never reads as a guest', withDir(async (dir) => {
    const stateDir = stateOf(dir);
    for (const id of [null, undefined, '', '../..', '///']) {
      markGuest(stateDir, id as any);
      expect(isGuest(stateDir, id as any)).toBe(false);
    }
    expect(fs.readdirSync(stateDir).filter(n => n.startsWith('.guest-'))).toEqual([]);
  }));

  // isWorktreeProjection() (lib/cc-compat.ts) reads "no state/ dir" as "this is a
  // worktree projection, walk past it" — creating one here would pin every later
  // resolution to the decoy.
  test('a missing state dir is never created just to mark a guest', withDir(async (dir) => {
    const stateDir = path.join(dir, 'fresh-state');
    markGuest(stateDir, 'sess-abc');
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(isGuest(stateDir, 'sess-abc')).toBe(false);
  }));

  test('clearing drops this session\'s marker and leaves the others alone', withDir(async (dir) => {
    const stateDir = stateOf(dir);
    markGuest(stateDir, 'sess-abc');
    markGuest(stateDir, 'sess-other');

    clearGuest(stateDir, 'sess-abc');

    expect(isGuest(stateDir, 'sess-abc')).toBe(false);
    expect(isGuest(stateDir, 'sess-other')).toBe(true);
    expect(() => clearGuest(stateDir, 'sess-never-marked')).not.toThrow();
  }));

  test('pruning drops aged markers and keeps fresh ones', withDir(async (dir) => {
    const stateDir = stateOf(dir);
    markGuest(stateDir, 'fresh');
    markGuest(stateDir, 'stale');

    const staleFile = path.join(stateDir, '.guest-stale');
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(staleFile, old / 1000, old / 1000);

    pruneGuestMarkers(stateDir);

    expect(isGuest(stateDir, 'fresh')).toBe(true);
    expect(isGuest(stateDir, 'stale')).toBe(false);
  }));

  test('pruning leaves non-marker files alone and tolerates a missing dir', withDir(async (dir) => {
    const stateDir = stateOf(dir);
    const keep = path.join(stateDir, 'runtime.json');
    fs.writeFileSync(keep, '{}');
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(keep, old / 1000, old / 1000);

    pruneGuestMarkers(stateDir);
    expect(fs.existsSync(keep)).toBe(true);

    expect(() => pruneGuestMarkers(path.join(dir, 'nope'))).not.toThrow();
  }));
});
