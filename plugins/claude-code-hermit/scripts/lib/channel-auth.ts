// Shared channel `allowed_users` allowlist gating — used by every
// UserPromptSubmit hook that reacts to an inbound <channel> envelope
// (the channel-reply-reminder, pause-keyword and channel-status-responder
// stages in lib/prompt-stages/).
// A single copy so the allowlist rule can't drift out of sync between callers.

import { normalizeChannelSource } from './channel-envelope';

type Json = any;

/**
 * Resolves an envelope's (possibly plugin-qualified) source to its configured
 * channel entry via the normalized (bare server name) key — the same key the
 * send path derives from `envelope.sourceKey`, so the auth gate and the reply
 * target can never disagree about which channel config applies. Config keyed by
 * bare server name is the convention (see normalizeChannelSource); this is the
 * one place both gate functions below resolve it, so they can't drift apart.
 */
export function channelEntry(config: Json, source: string): Json {
  const channels = config?.channels;
  if (!channels || typeof channels !== 'object') return undefined;
  const key = normalizeChannelSource(source);
  return Object.prototype.hasOwnProperty.call(channels, key) ? channels[key] : undefined;
}

/** The hermit's own account on a channel. Either field is null when the entry,
 *  the field, or the config itself is missing or malformed. */
export interface ChannelBotIdentity {
  /** `@handle` — Telegram mentions and the `/cmd@handle` suffix carry this. */
  username: string | null;
  /** Numeric platform id — Discord mentions carry this, never the handle. */
  userId: string | null;
}

/**
 * Both halves of the bot's own identity from one entry lookup. Self-mention and
 * `@botname` addressing (channel-slash-address.ts) read them from three prompt
 * stages and the reply reminder reads both together; one accessor keeps "no
 * configured identity" from meaning something different in each.
 */
export function channelBotIdentity(config: Json, source: string): ChannelBotIdentity {
  const entry = channelEntry(config, source);
  return {
    username: typeof entry?.bot_username === 'string' ? entry.bot_username : null,
    userId: entry?.bot_user_id == null ? null : String(entry.bot_user_id),
  };
}

/**
 * Mirrors channel-responder/SKILL.md 1c: absent allowed_users → accept all
 * (backwards compatible); [] → lockdown; otherwise the sender's user id must
 * be present in the list. Callers that can't respond to the operator on
 * failure (hooks) can only choose not to act — never throw or block.
 *
 * `userId` arrives canonicalized by parseChannelEnvelope (the envelope's
 * `user_id` when present, else `user`) — this gate never sees the display name
 * separately, so an allowlist can only ever be matched against the platform id.
 */
export function isAllowedSender(config: Json, source: string, userId: string | null): boolean {
  const allowedUsers = channelEntry(config, source)?.allowed_users;
  if (!Array.isArray(allowedUsers)) return true; // absent/malformed -> accept all
  if (userId === null) return false; // can't verify identity against a configured allowlist
  return allowedUsers.includes(userId);
}

/**
 * Stricter gate for state-mutating (pause/resume/snooze) and disclosure (status)
 * paths. An explicit allowed_users list still wins — but when none is configured
 * this does NOT fall back to accept-all (as isAllowedSender does). Instead it
 * trusts only the operator's pinned home chat (chat_id === default_chat_id, or
 * the learned dm_channel_id until the pin is seeded), so on a no-allowlist
 * channel a stranger in a group can't freeze the hermit or read its status,
 * while the operator's own chat keeps working with zero config.
 *
 * The anchor is the *pinned* home rather than the last-learned DM so control
 * authority can't be acquired by messaging from a new chat: default_chat_id is
 * seeded once by channel-hook and moved only from the terminal. Same fallback
 * chain as resolve-outbound-channel's proactiveChatId (duplicated rather than
 * imported — an auth gate shouldn't depend on the delivery module).
 *
 * Caveat: if the operator's home IS a group/server channel, its chat_id equals
 * the group's and every member matches — those installs must set allowed_users.
 * Pinning closes the acquisition path, not this standing exposure.
 * (Documented in docs/security.md + the CHANGELOG.)
 */
export function isTrustedController(
  config: Json, source: string, userId: string | null, chatId: string | null,
): boolean {
  const ch = channelEntry(config, source);
  if (Array.isArray(ch?.allowed_users)) {
    return isAllowedSender(config, source, userId); // explicit list (incl. [] lockdown) wins
  }
  // `||`, not `??`: an empty-string pin must not mask a working dm_channel_id and
  // lock the operator out of control entirely. Truthiness on both sides so a pair
  // of empty values can never match either.
  const home = ch?.default_chat_id || ch?.dm_channel_id; // no list -> pinned-home binding
  return !!home && !!chatId && String(home) === String(chatId);
}
