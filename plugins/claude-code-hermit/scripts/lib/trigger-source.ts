// trigger-source.ts — classify a turn's trigger source from its scanned text.
//
// Pure, side-effect-free (no module-level state): both cost-tracker.ts and
// transcript-digest.ts import it, and it must be safe to load in-process from any
// cwd without freezing paths the way cost-tracker's own module init does.
// channel-envelope.ts (the sole import) is likewise pure — a regex normalizer
// with no module-level state — so the load-anywhere guarantee holds.

import { normalizeChannelSource } from './channel-envelope';

type Json = any;

// Classify a turn's trigger source from the text of its triggering entry (or the
// scanned text of its entries). Only the marker-driven sources below are claimed;
// everything else is 'other' (the non-scheduled bucket, typically the largest in
// practice). Routine ids are validated only for presence/uniqueness in config —
// the strict charset here ([A-Za-z0-9._-]+) is the classifier's own gate, and it
// rejects skill-template noise ([hermit-routine:*], <id> placeholders) that
// appears in tool_result entries when routines register.
function classifySource(triggerText: string): string {
  if (!triggerText) return 'other';
  if (triggerText.includes('HEARTBEAT_EVALUATE') ||
      triggerText.includes('/claude-code-hermit:heartbeat run')) {
    return 'heartbeat';
  }
  // Monitor co-fire: a ROUTINE_DUE line naming ≥2 distinct routine ids means one wake turn
  // ran multiple routines. Attribute the shared turn to a synthetic `routine:multi` bucket
  // rather than mis-charging the whole turn to the first id (which would inflate that
  // routine's per-run cost and mask the others in the doctor's routine-cost check).
  // Anchored to the ROUTINE_DUE line — NOT the whole turn — so heartbeat-restart's re-arm,
  // whose `load` step's CronDelete output surfaces [hermit-routine:*] markers, never trips it.
  const routineDue = triggerText.match(/ROUTINE_DUE((?:\s+\[hermit-routine:[A-Za-z0-9._-]+\])+)/);
  if (routineDue) {
    const ids = new Set([...routineDue[1].matchAll(/\[hermit-routine:([A-Za-z0-9._-]+)\]/g)].map((m) => m[1]));
    if (ids.size >= 2) return 'routine:multi';
    if (ids.size === 1) return `routine:${[...ids][0].slice(0, 64)}`;
  }
  // Strict charset — must match a real routine id, never a placeholder or glob
  const routineMatch = triggerText.match(/\[hermit-routine:([A-Za-z0-9._-]+)\]/);
  // Length-cap to 64 chars so ids can't overflow markdown table cells
  if (routineMatch) return `routine:${routineMatch[1].slice(0, 64)}`;
  // log-routine-event.sh fallback: present in tool_result when the skill fires the marker
  const logMatch = triggerText.match(/log-routine-event\.sh\s+([A-Za-z0-9._-]+)/);
  if (logMatch) return `routine:${logMatch[1].slice(0, 64)}`;
  // Inbound-channel envelope (see lib/channel-envelope.ts): source is plugin-qualified
  // on the wire (e.g. `plugin:discord:discord`, `plugin:voice:voice`). Bucket by the
  // bare server name via normalizeChannelSource — the same normalizer the auth/config
  // path uses, so cost attribution and config lookup can't drift apart on the wire
  // shape. Strict charset — like the routine regex above, the value must match the
  // allowed charset to be captured at all (not captured loosely then sanitized), so
  // `<id>`/`*` placeholder noise fails the match entirely rather than surviving as a
  // truncated false positive.
  const channelMatch = triggerText.match(/<channel\b[^>]*\bsource="([A-Za-z0-9._:-]+)"/);
  const channelKind = channelMatch ? normalizeChannelSource(channelMatch[1]) : '';
  // Only a source that normalizes to a clean bare server name is a real channel;
  // anything still containing ':' (a malformed or unrecognized 3+-segment shape)
  // is bucketed as `other` rather than leaking a `channel:plugin:…` garbage bucket
  // — same fail-closed stance normalizeChannelSource takes for config lookup.
  if (channelKind && !channelKind.includes(':')) return `channel:${channelKind.slice(0, 64)}`;
  return 'other';
}

export { classifySource };
