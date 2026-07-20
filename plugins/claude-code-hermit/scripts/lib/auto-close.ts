// Shared 10-minute operator-lull threshold for daily-auto-close: the
// session-archive.ts auto-close-decision verb, the heartbeat-precheck.ts
// pending-close drain, and the hermit-watchdog.ts post-close-clear backoff
// all gate on the same lull. Side-effect-free — safe to import from CLI scripts.
export const AUTO_CLOSE_LULL_MINUTES = 10;
export const AUTO_CLOSE_LULL_MS = AUTO_CLOSE_LULL_MINUTES * 60_000;
