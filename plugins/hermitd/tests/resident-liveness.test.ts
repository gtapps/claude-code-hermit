import { describe, expect, test } from 'bun:test';
import { otherRuntimeLive, residentLiveness } from '../scripts/lib/resident-liveness';

const verdict = (runtime: Parameters<typeof residentLiveness>[0], alive = false, age: number | null = null) =>
  residentLiveness(runtime, 'resident', { tmuxAlive: () => alive, livenessAgeSecs: () => age });

describe('resident liveness', () => {
  test('absent runtime or mode has no resident', () => {
    expect(verdict(null).state).toBe('none');
    expect(verdict({}).state).toBe('none');
  });
  test('live tmux', () => expect(verdict({ runtime_mode: 'tmux' }, true).state).toBe('alive'));
  test('clean stop', () => expect(verdict({ runtime_mode: 'tmux', shutdown_completed_at: 'stamp' }).state).toBe('cleanly-stopped'));
  test('interactive', () => expect(verdict({ runtime_mode: 'interactive' }).state).toBe('interactive'));
  test('orphan', () => expect(verdict({ runtime_mode: 'tmux' }, false, 12).state).toBe('orphan'));
  test('dead', () => expect(verdict({ runtime_mode: 'tmux' }, false, 600).state).toBe('dead'));
  test('fresh activity without a mode is an orphan', () => expect(verdict({}, false, 5).state).toBe('orphan'));
  test('live tmux precedes a clean stamp', () => expect(verdict({ runtime_mode: 'tmux', shutdown_completed_at: 'stamp' }, true).state).toBe('alive'));
  test('clean stamp precedes fresh activity', () => expect(verdict({ runtime_mode: 'tmux', shutdown_completed_at: 'stamp' }, false, 1).state).toBe('cleanly-stopped'));
  test('cross-runtime freshness preserves the exact age', () => {
    expect(otherRuntimeLive(verdict({ runtime_mode: 'docker' }, false, 1.25), 'tmux')).toBe(1.25);
    expect(otherRuntimeLive(verdict({ runtime_mode: 'tmux' }, false, 1), 'tmux')).toBeNull();
    expect(otherRuntimeLive(verdict({ runtime_mode: 'docker' }, false, 600), 'tmux')).toBeNull();
    expect(otherRuntimeLive(verdict({ runtime_mode: 'docker', shutdown_completed_at: 'stamp' }, true, 1), 'tmux')).toBeNull();
  });
});

test('live tmux without runtime mode is alive', () => {
  const result = verdict({}, true);
  expect(result.state).toBe('alive');
  expect(result.evidence.tmuxAlive).toBe(true);
});
