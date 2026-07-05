// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// UserPromptSubmit hook — deterministic pause/resume/snooze keyword writer
// (PROP-015). Writes state/pause.json directly from an inbound <channel>
// envelope, before any model involvement, so pause/resume never depends on
// model cooperation or on a tool call the pause-gate itself might deny.
//
// Probe-verified limit (compiled/spike-channel-stop-probe-2026-07-03.md): this
// only fires between turns — a UserPromptSubmit hook never sees a mid-turn
// steering message. Mid-turn "stop" is cooperative text; the binding mid-turn
// interrupt is the watchdog's Escape-to-pane (scripts/hermit-watchdog.ts).
//
// Gated by the same allowed_users allowlist as channel-reply-reminder.ts
// (lib/channel-auth.ts's isAllowedSender, shared by both; also see
// channel-responder/SKILL.md 1c) — an unauthorized sender's message is a
// silent no-op: no state change, no stdout, so the mechanism can't be probed
// by an unauthorized prompt.

import { safeForLLM } from './lib/sanitize';
import { hermitDir } from './lib/cc-compat';
import { setPause, clearPause, parseSnoozeDuration } from './lib/pause';
import { loadConfig, isTrustedController } from './lib/channel-auth';
import { parseChannelEnvelope } from './lib/channel-envelope';

type Json = any;

const MAX_BY_LEN = 64;
const MAX_DURATION_LEN = 32;

function main(raw: string): void {
  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : null;
  if (!prompt) return;

  // Shared envelope parser (also used by channel-reply-reminder/status-responder),
  // so the grammar can't drift. Requires a chat_id — which the DM-binding gate
  // below needs anyway, and every real inbound envelope carries.
  const env = parseChannelEnvelope(prompt);
  if (!env) return;
  const sourceRaw = env.source;
  const userId = env.userId;
  const body = env.body;
  if (!body) return;

  // Exact-match only — no fuzzy matching, so ordinary conversational text
  // ("please pause and think about this") never accidentally triggers a
  // state change.
  const keyword = body.toLowerCase();
  const snoozeMatch = /^snooze\s+(\S+)$/.exec(keyword);

  let action: 'pause' | 'resume' | 'snooze' | null = null;
  let durationRaw: string | null = null;
  if (keyword === 'pause' || keyword === 'stop') action = 'pause';
  else if (keyword === 'resume') action = 'resume';
  else if (snoozeMatch) { action = 'snooze'; durationRaw = snoozeMatch[1]; }
  if (!action) return;

  const dir = hermitDir();
  const config = loadConfig(dir);
  // Stricter gate than a plain reply: pausing is state-mutating, so an unconfigured
  // channel trusts only the operator's DM (chat_id === dm_channel_id), not accept-all.
  if (!isTrustedController(config, sourceRaw, userId, env.chatId)) return; // unauthorized — silent no-op

  const by = safeForLLM((userId ?? sourceRaw ?? 'channel').slice(0, MAX_BY_LEN));

  if (action === 'pause') {
    setPause(dir, { reason: 'operator', by });
    process.stdout.write(
      `[pause] Hermit paused by ${by} (indefinite). Only the channel reply tool works until resumed.\n`
    );
  } else if (action === 'resume') {
    clearPause(dir);
    process.stdout.write(`[pause] Hermit resumed by ${by}. Normal operation restored.\n`);
  } else {
    const durationSafe = safeForLLM((durationRaw ?? '').slice(0, MAX_DURATION_LEN));
    const ms = durationRaw ? parseSnoozeDuration(durationRaw) : null;
    if (ms === null) {
      process.stdout.write(
        `[pause] Could not parse snooze duration "${durationSafe}" — expected e.g. "30m", "2h", "1d". No change made.\n`
      );
      return;
    }
    const until = new Date(Date.now() + ms).toISOString();
    setPause(dir, { reason: 'operator', by, until });
    process.stdout.write(`[pause] Hermit paused by ${by} until ${until}.\n`);
  }
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try { main(buf); } catch { /* fail-open */ }
    process.exit(0);
  });
} catch {
  process.exit(0);
}
