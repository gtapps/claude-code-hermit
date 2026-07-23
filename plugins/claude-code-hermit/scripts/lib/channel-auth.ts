// Shared channel `allowed_users` allowlist gating — used by every
// UserPromptSubmit hook that reacts to an inbound <channel> envelope
// (channel-reply-reminder.ts, pause-keyword.ts, channel-status-responder.ts).
// A single copy so the allowlist rule can't drift out of sync between callers.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeChannelSource } from './channel-envelope';

type Json = any;

export function loadConfig(dir: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolves an envelope's (possibly plugin-qualified) source to its configured
 * channel entry via the normalized (bare server name) key — the same key the
 * send path derives from `envelope.sourceKey`, so the auth gate and the reply
 * target can never disagree about which channel config applies. Config keyed by
 * bare server name is the convention (see normalizeChannelSource); this is the
 * one place both gate functions below resolve it, so they can't drift apart.
 */
function channelEntry(config: Json, source: string): Json {
  const channels = config?.channels;
  if (!channels || typeof channels !== 'object') return undefined;
  const key = normalizeChannelSource(source);
  return Object.prototype.hasOwnProperty.call(channels, key) ? channels[key] : undefined;
}

/**
 * Mirrors channel-responder/SKILL.md 1c: absent allowed_users → accept all
 * (backwards compatible); [] → lockdown; otherwise the sender's user id must
 * be present in the list. Callers that can't respond to the operator on
 * failure (hooks) can only choose not to act — never throw or block.
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
 * trusts only the operator's own DM chat (chat_id === channels[source].dm_channel_id),
 * so on a no-allowlist channel a stranger in a group can't freeze the hermit or
 * read its status, while the operator's DM keeps working with zero config.
 *
 * Caveat: if the operator's primary channel IS a group/server channel, its
 * dm_channel_id equals the group chat_id and every member matches — those installs
 * must set allowed_users. (Documented in docs/security.md + the CHANGELOG.)
 */
export function isTrustedController(
  config: Json, source: string, userId: string | null, chatId: string | null,
): boolean {
  const ch = channelEntry(config, source);
  if (Array.isArray(ch?.allowed_users)) {
    return isAllowedSender(config, source, userId); // explicit list (incl. [] lockdown) wins
  }
  const dm = ch?.dm_channel_id; // no list configured -> operator-DM binding
  return dm != null && chatId != null && String(dm) === String(chatId);
}
