// Shared channel `allowed_users` allowlist gating — used by every
// UserPromptSubmit hook that reacts to an inbound <channel> envelope
// (channel-reply-reminder.ts, pause-keyword.ts). A single copy so the
// allowlist rule can't drift out of sync between callers.

import fs from 'node:fs';
import path from 'node:path';

type Json = any;

export function loadConfig(dir: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Mirrors channel-responder/SKILL.md 1c: absent allowed_users → accept all
 * (backwards compatible); [] → lockdown; otherwise the sender's user id must
 * be present in the list. Callers that can't respond to the operator on
 * failure (hooks) can only choose not to act — never throw or block.
 */
export function isAllowedSender(config: Json, source: string, userId: string | null): boolean {
  const allowedUsers = config?.channels?.[source]?.allowed_users;
  if (!Array.isArray(allowedUsers)) return true; // absent/malformed -> accept all
  if (userId === null) return false; // can't verify identity against a configured allowlist
  return allowedUsers.includes(userId);
}
