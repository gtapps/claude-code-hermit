/**
 * Guest-session marker — carries the residency verdict from session start to the
 * per-turn hooks.
 *
 * `residentSessionActive` (startup-context.ts) decides resident-vs-guest once, at
 * SessionStart, and the banner it emits only reaches the model. Every state-writing
 * hook still fires in a guest session with no model in the loop, so the verdict has
 * to be readable from a hook: startup-context marks the guest, the hooks stat the
 * marker. Re-deriving it per turn is not an option either — the check spawns tmux,
 * and this sits on the Stop path.
 *
 * Frozen-at-SessionStart is also the semantics we want: if the resident dies
 * mid-session the ex-guest keeps not touching the liveness signal, the file goes
 * stale, and the watchdog restarts the resident.
 *
 * Fail-open throughout: an unknown session id or an fs error reads as "not a guest",
 * which is exactly today's ungated behavior.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A marker older than this belongs to a session that is long gone. */
const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const PREFIX = '.guest-';

// The id lands in a filename, so anything outside this set is dropped rather than
// escaped — a session id is already [A-Za-z0-9-] in practice, and a sanitized-away
// id fails closed to "no marker" instead of writing to a surprising path.
function markerPath(stateDir: string, sessionId: string | null | undefined): string | null {
  if (typeof sessionId !== 'string') return null;
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) return null;
  return path.join(stateDir, PREFIX + safe);
}

/**
 * Record that this session is a guest. Called once, from the SessionStart injection.
 *
 * Deliberately does NOT mkdir the state dir. `isWorktreeProjection` (lib/cc-compat.ts)
 * identifies a worktree's projected `.hermit/` by the absence of `state/`,
 * so a writer that creates it turns a projection the resolvers walk past into a
 * permanent resolution target. A hatched folder always has `state/`; anywhere it is
 * missing, failing to mark is the fail-open outcome we want anyway.
 */
export function markGuest(stateDir: string, sessionId: string | null | undefined): void {
  const file = markerPath(stateDir, sessionId);
  if (!file) return;
  try {
    fs.writeFileSync(file, new Date().toISOString() + '\n', 'utf-8');
  } catch { /* fail-open */ }
}

/**
 * Drop this session's marker. The verdict is frozen for the life of a session, but
 * SessionStart fires again on resume/clear/compact with the SAME session id — and if
 * the resident is gone by then, this session is the resident. Without this the stale
 * marker would keep the now-only session in the folder from signalling liveness.
 */
export function clearGuest(stateDir: string, sessionId: string | null | undefined): void {
  const file = markerPath(stateDir, sessionId);
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* absent or unreadable — nothing to clear */ }
}

/** True only when this session was marked a guest at its start. */
export function isGuest(stateDir: string, sessionId: string | null | undefined): boolean {
  const file = markerPath(stateDir, sessionId);
  if (!file) return false;
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** Drop markers left behind by sessions that ended long ago. */
export function pruneGuestMarkers(stateDir: string): void {
  try {
    const cutoff = Date.now() - MARKER_MAX_AGE_MS;
    for (const name of fs.readdirSync(stateDir)) {
      if (!name.startsWith(PREFIX)) continue;
      const file = path.join(stateDir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* skip this one */ }
    }
  } catch { /* fail-open */ }
}
