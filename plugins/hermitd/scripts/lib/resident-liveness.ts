import { LIVENESS_FRESH_SECS, sharedLivenessAgeSecs } from './liveness';
import { tmuxSessionAlive } from './tmux';

export type LivenessState = 'none' | 'alive' | 'cleanly-stopped' | 'interactive' | 'orphan' | 'dead';
export type LivenessDeps = { tmuxAlive(s: string): boolean; livenessAgeSecs(): number | null };
export type LivenessEvidence = { runtimeMode: string | null; tmuxAlive: boolean; livenessAgeSecs: number | null; fresh: boolean; cleanlyStopped: boolean };
export type LivenessVerdict = { state: LivenessState; evidence: LivenessEvidence };

export function residentLiveness(
  runtime: { runtime_mode?: unknown; shutdown_completed_at?: unknown } | null,
  sessionName: string,
  deps: LivenessDeps,
): LivenessVerdict {
  const runtimeMode = typeof runtime?.runtime_mode === 'string' ? runtime.runtime_mode : null;
  const age = deps.livenessAgeSecs();
  const evidence: LivenessEvidence = {
    runtimeMode,
    tmuxAlive: sessionName ? deps.tmuxAlive(sessionName) : false,
    livenessAgeSecs: age,
    fresh: age !== null && age < LIVENESS_FRESH_SECS,
    cleanlyStopped: Boolean(runtime?.shutdown_completed_at),
  };
  // Fresh activity without tmux reads as an orphan even when runtime.json lost its
  // mode: restarting or marking stopped over it would spawn a second claude.
  const state: LivenessState = evidence.tmuxAlive ? 'alive'
    : evidence.cleanlyStopped ? 'cleanly-stopped'
    : runtimeMode === 'interactive' ? 'interactive'
    : evidence.fresh ? 'orphan'
    : !runtimeMode ? 'none' : 'dead';
  return { state, evidence };
}

export function otherRuntimeLive(verdict: LivenessVerdict, mode: string): number | null {
  const evidence = verdict.evidence;
  return evidence.runtimeMode && evidence.runtimeMode !== mode && !evidence.cleanlyStopped && evidence.fresh
    ? evidence.livenessAgeSecs : null;
}

export function REAL_LIVENESS_DEPS(hermitRoot?: string): LivenessDeps {
  return { tmuxAlive: tmuxSessionAlive, livenessAgeSecs: () => sharedLivenessAgeSecs(hermitRoot) };
}
