// Unit tests for scripts/lib/channel-auth.ts and its normalizeChannelSource
// dependency (scripts/lib/channel-envelope.ts) — the shared config-lookup gate
// behind pause-keyword.ts, channel-reply-reminder.ts, and
// channel-status-responder.ts. Pure exported helpers, tested in-process (not
// via runScript) per the repo convention (see tests/pause-lib.test.ts).
//
// Usage: bun test tests/channel-auth.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import { normalizeChannelSource } from '../scripts/lib/channel-envelope';
import { isAllowedSender, isTrustedController } from '../scripts/lib/channel-auth';

describe('normalizeChannelSource', () => {
  test('plugin-qualified source — returns the server name', () => {
    expect(normalizeChannelSource('plugin:discord:discord')).toBe('discord');
    expect(normalizeChannelSource('plugin:voice:voice')).toBe('voice');
  });

  test('bare source — passes through unchanged', () => {
    expect(normalizeChannelSource('discord')).toBe('discord');
  });

  test('non-plugin colon string — passes through unchanged', () => {
    expect(normalizeChannelSource('foo:bar')).toBe('foo:bar');
  });

  test('more than two segments after plugin: — NOT normalized (unrecognized shape)', () => {
    expect(normalizeChannelSource('plugin:a:b:c')).toBe('plugin:a:b:c');
  });

  test('empty string — passes through unchanged', () => {
    expect(normalizeChannelSource('')).toBe('');
  });
});

describe('isAllowedSender with plugin-qualified sources', () => {
  test('qualified source resolves to bare-keyed config allowlist', () => {
    const config = { channels: { discord: { allowed_users: ['U1'] } } };
    expect(isAllowedSender(config, 'plugin:discord:discord', 'U1')).toBe(true);
    expect(isAllowedSender(config, 'plugin:discord:discord', 'STRANGER')).toBe(false);
  });

  test('no allowlist configured, qualified source — accept-all fallback still applies', () => {
    const config = { channels: { discord: {} } };
    expect(isAllowedSender(config, 'plugin:discord:discord', 'ANYONE')).toBe(true);
  });

  test('qualified source, no matching config entry at all — accept-all fallback (absent allowlist)', () => {
    const config = { channels: {} };
    expect(isAllowedSender(config, 'plugin:discord:discord', 'ANYONE')).toBe(true);
  });
});

describe('isTrustedController with plugin-qualified sources', () => {
  test('DM-binding match on a qualified source, no allowlist configured', () => {
    const config = { channels: { discord: { dm_channel_id: '1' } } };
    expect(isTrustedController(config, 'plugin:discord:discord', 'U1', '1')).toBe(true);
    expect(isTrustedController(config, 'plugin:discord:discord', 'U1', '99')).toBe(false);
  });

  test('explicit allowlist on a qualified source wins over DM binding', () => {
    const config = { channels: { discord: { allowed_users: ['ALLOWED'], dm_channel_id: '1' } } };
    expect(isTrustedController(config, 'plugin:discord:discord', 'ALLOWED', '99')).toBe(true);
    expect(isTrustedController(config, 'plugin:discord:discord', 'STRANGER', '1')).toBe(false);
  });

  test('allowed_users=[] lockdown on a qualified source — nobody trusted', () => {
    const config = { channels: { discord: { allowed_users: [] } } };
    expect(isTrustedController(config, 'plugin:discord:discord', 'ANYONE', '1')).toBe(false);
  });

  test('normalized bare key is authoritative — the send path uses the same key, so auth must too', () => {
    // A config keyed ONLY by the qualified form is off-convention and does not
    // resolve: the send path always looks up the normalized bare name, so if the
    // auth gate honored the qualified key it would pass a sender the send path
    // can't route/token (the #634 auth/send split). The bare key is the one truth.
    const qualifiedOnly = { channels: { 'plugin:discord:discord': { dm_channel_id: '1' } } };
    expect(isTrustedController(qualifiedOnly, 'plugin:discord:discord', 'U1', '1')).toBe(false);

    // When both forms are present, the normalized (bare) key wins.
    const both = {
      channels: {
        'plugin:discord:discord': { dm_channel_id: '1' },
        discord: { dm_channel_id: '99' },
      },
    };
    expect(isTrustedController(both, 'plugin:discord:discord', 'U1', '99')).toBe(true);
    expect(isTrustedController(both, 'plugin:discord:discord', 'U1', '1')).toBe(false);
  });

  test('genericity: an unrecognized custom channel plugin normalizes the same way', () => {
    const config = { channels: { crm: { dm_channel_id: '1' } } };
    expect(isTrustedController(config, 'plugin:acme-crm:crm', 'U1', '1')).toBe(true);
  });

  test('no config entry matches, qualified or normalized — untrusted (fails closed)', () => {
    const config = { channels: {} };
    expect(isTrustedController(config, 'plugin:discord:discord', 'U1', '1')).toBe(false);
  });
});
