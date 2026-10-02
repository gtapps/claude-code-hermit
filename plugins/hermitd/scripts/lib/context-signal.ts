// Pure prompt-token signal selection shared by the watchdog's hygiene tiers and
// doctor-check's context tripwire. Extracted because the two had drifted: the
// watchdog was moved to last_call_prompt_tokens-first (d9e782f) while doctor's
// deliberate mirror kept preferring the turn-wide max_prompt_tokens — which on a
// turn that compacted mid-flight describes a context CC already threw away.
// Doctor's original reason to duplicate (CWD-relative state paths) does not
// apply here: these functions take a cost-log entry and return numbers, no I/O.

type Json = any;

/** Fallback fixed-surface estimate when no measured value exists yet (fresh
 *  hermit before its first compaction). 50k keeps the compact trigger's
 *  cold-start behavior at the pre-conversation-gate level: threshold 100k +
 *  assumed 50k ≈ the old 150k total-prompt default. */
export const ASSUMED_SURFACE_TOKENS = 50_000;

/** A reading above this is not a context, it is corruption — live logs have carried rows
 *  citing 6.5M prompt tokens (an old estimate fallback multiplying a summed multi-call turn
 *  out). Deliberately far above any real window rather than tracking model context sizes:
 *  it exists to reject garbage, not to encode a model contract. Shared by the watchdog's
 *  poisonedEntrySkip and cost-tracker's surface derivation — a derived surface above a
 *  plausible whole prompt is corruption by the same argument. */
export const MAX_PLAUSIBLE_PROMPT_TOKENS = 2_000_000;

/**
 * Prompt-side token count for a cost-log entry — approximates real context size,
 * not the per-turn billing total. Peak since the turn's last compaction when
 * present (the newest call in the normal case; stays correct across a mid-turn
 * compaction, unlike max_prompt_tokens). Entries logged before those fields
 * existed fall back to the per-call average of the summed total, which is far
 * closer to context size than the raw sum (a multi-call turn's sum is a
 * multiple of its actual context).
 */
export function promptTokensOf(entry: Json): number {
  if (typeof entry.last_call_prompt_tokens === 'number') return entry.last_call_prompt_tokens;
  if (typeof entry.max_prompt_tokens === 'number') return entry.max_prompt_tokens;
  const sum = (entry.input_tokens ?? 0) + (entry.cache_write_tokens ?? 0) + (entry.cache_read_tokens ?? 0);
  return isEstimateOnly(entry) ? Math.round(sum / (entry.api_calls || 1)) : sum;
}

/** True when a cost-log entry lacks the real per-call peak (max_prompt_tokens) and
 *  spans more than one API call — promptTokensOf can only average such an entry,
 *  which is why the destructive /clear tier refuses to act on it (the compact
 *  tier tolerates the estimate: it self-corrects one turn later). */
export function isEstimateOnly(entry: Json): boolean {
  return typeof entry.max_prompt_tokens !== 'number'
    && typeof entry.api_calls === 'number' && entry.api_calls > 1;
}

/**
 * Estimated compactible conversation in the entry's context: total prompt minus
 * the hermit's recorded fixed-surface upper bound (state/context-surface.json),
 * or minus ASSUMED_SURFACE_TOKENS when none is recorded. Because the recorded
 * value is an upper bound (it carries post-boundary wake messages), the result
 * is a lower bound on compactible content — the compact gate therefore fires
 * later than exact, never earlier. Clamped at zero: a prompt smaller than the
 * recorded surface is the normal state right after a /clear or on a fresh
 * session, and the raw negative would reach operator-facing digests and
 * watchdog telemetry as apparent corruption. Both consumers' comparisons are
 * unaffected by the clamp.
 */
export function compactibleTokens(entry: Json, surfaceUpperBound: number | null): number {
  return Math.max(0, promptTokensOf(entry) - (surfaceUpperBound ?? ASSUMED_SURFACE_TOKENS));
}

/**
 * True when a cost-log entry is this session's own main turn.
 *
 * Three clauses, each load-bearing: `cc_session_id` is the harness id of the session that
 * produced the turn, subagent lines carry their own small token count rather than the main
 * turn's context size, and a guest row can only carry the resident's id if it IS the
 * resident, which the marker denies. Rows predating `cc_session_id` never match, which
 * ages out as soon as the session logs a turn under the new cost-row shape.
 *
 * Shared by hermitd-watchdog's hygiene tiers and doctor-check's context tripwire — the
 * same anti-drift reason promptTokensOf lives here (issue #916).
 */
export function isOwnTurn(entry: Json, sessionId: string): boolean {
  return entry?.cc_session_id === sessionId && entry.subagent !== true && entry.guest !== true;
}
