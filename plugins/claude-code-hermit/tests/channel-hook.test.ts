import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, afterEach } from 'bun:test';
import { persistDmChannelId, isEligibleInboundReply } from '../scripts/channel-hook';
import { validate } from '../scripts/validate-config';

// The sender allow-list gate (channel-reply-reminder.ts isAllowedSender) and
// validate-config both require channel IDs to be strings. If a channel plugin
// delivers chat_id as a JSON number, persistDmChannelId must coerce it so a
// number never lands in config.json.
//
// All of these pass isInboundReply: true — they're exercising the coercion
// and maintainer-exclusion logic, which only runs once the new turn-eligibility
// gate (see the 'inbound-turn eligibility' describe block below) has already
// passed.
describe('persistDmChannelId — dm_channel_id string coercion', () => {
  test('coerces a numeric chat_id to its string form', () => {
    const config: any = { channels: { discord: { dm_channel_id: null } } };
    const changed = persistDmChannelId(config, 'discord', 555, true);
    expect(changed).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('555');
    expect(typeof config.channels.discord.dm_channel_id).toBe('string');
  });

  test('a numeric chat_id equal to the stored string id is a no-op', () => {
    const config: any = { channels: { discord: { dm_channel_id: '555' } } };
    expect(persistDmChannelId(config, 'discord', 555, true)).toBe(false);
    expect(persistDmChannelId(config, 'discord', '555', true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('555');
  });

  test('a falsy chatId returns false and leaves the existing id untouched', () => {
    const config: any = { channels: { discord: { dm_channel_id: 'D1' } } };
    expect(persistDmChannelId(config, 'discord', null, true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });
});

// The maintainer chat is an outbound-only second destination
// (docs/security.md § tiered disclosure) and must never be re-learned as
// dm_channel_id — dm_channel_id also binds operator trust in
// lib/channel-auth.ts isTrustedController.
describe('persistDmChannelId — maintainer chat exclusion', () => {
  test('a chatId equal to maintainer_channel_id is refused, dm_channel_id untouched', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'M1', true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });

  test('a chatId equal to maintainer_channel_id is refused even when dm_channel_id is null', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: null, maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'M1', true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe(null);
  });

  test('a numeric chatId matching a string maintainer_channel_id is still refused', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: '555' } },
    };
    expect(persistDmChannelId(config, 'discord', 555, true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });

  test('a chatId different from maintainer_channel_id is still learned normally', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'D2', true)).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('D2');
  });

  // The maintainer exemption must still hold even when the reply DID open on
  // a matching inbound turn — it's defense in depth below the new eligibility
  // gate, not replaced by it.
  test('maintainer exclusion holds even when isInboundReply is true', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'M1', true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });

  // An already-clobbered install (or one configured to the same chat) can't be
  // repaired by the hook — it must be reported so doctor/the operator sees it.
  test('validate-config warns when dm_channel_id already equals maintainer_channel_id', () => {
    const { warnings } = validate({
      channels: { discord: { enabled: true, dm_channel_id: 'M1', maintainer_channel_id: 'M1' } },
    });
    expect(warnings.some(w => w.includes('discord.dm_channel_id equals maintainer_channel_id'))).toBe(true);
  });

  test('validate-config stays quiet when the two ids differ', () => {
    const { warnings } = validate({
      channels: { discord: { enabled: true, dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    });
    expect(warnings.some(w => w.includes('equals maintainer_channel_id'))).toBe(false);
  });
});

// PROP-012: a proactive/scheduled reply (routine wake, heartbeat, a brief
// firing on a timer) must not be mistaken for the operator having relocated
// their primary DM. persistDmChannelId's isInboundReply gate handles the
// "did we even check" half; isEligibleInboundReply below handles "was this
// reply actually opened by a matching inbound message."
describe('persistDmChannelId — inbound-turn eligibility gate', () => {
  test('(regression) isInboundReply: true still learns dm_channel_id as before', () => {
    const config: any = { channels: { discord: { dm_channel_id: 'D1' } } };
    expect(persistDmChannelId(config, 'discord', 'D2', true)).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('D2');
  });

  test('isInboundReply: false refuses the write and leaves dm_channel_id untouched', () => {
    const config: any = { channels: { discord: { dm_channel_id: 'D1' } } };
    expect(persistDmChannelId(config, 'discord', 'D2', false)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });
});

// isEligibleInboundReply reads a tail window of the transcript file named by
// event.transcript_path, finds the boundary prompt that opened the current
// turn, and checks it's a <channel> envelope from the SAME chat as the reply.
describe('isEligibleInboundReply — transcript-derived eligibility', () => {
  let tmpFile: string | null = null;

  afterEach(() => {
    if (tmpFile) {
      try { fs.rmSync(tmpFile, { force: true }); } catch {}
      tmpFile = null;
    }
  });

  function writeTranscript(lines: string[]): string {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'channel-hook-test-')), 'transcript.jsonl');
    fs.writeFileSync(tmpFile, lines.map(l => JSON.stringify({ type: 'user', message: { content: l } })).join('\n') + '\n');
    return tmpFile;
  }

  // (a) regression: a reply during a genuine inbound-triggered turn from the
  // same chat is eligible.
  test('a matching inbound <channel> envelope from the same chat is eligible', () => {
    const t = writeTranscript(['<channel source="plugin:telegram:telegram" chat_id="123">hi there</channel>']);
    expect(isEligibleInboundReply({ transcript_path: t }, 'telegram', '123')).toBe(true);
  });

  // (b) a routine/heartbeat-triggered turn opens on a prompt that isn't a
  // channel envelope at all — not eligible.
  test('a routine/heartbeat-triggered turn (no channel envelope) is not eligible', () => {
    const t = writeTranscript(['[hermit-routine:morning-brief] wake']);
    expect(isEligibleInboundReply({ transcript_path: t }, 'telegram', '123')).toBe(false);
  });

  // (c) an inbound turn from chat A, replying into chat B — chat mismatch —
  // is not eligible.
  test('a reply going to a different chat than the one that opened the turn is not eligible', () => {
    const t = writeTranscript(['<channel source="plugin:telegram:telegram" chat_id="AAA">hi</channel>']);
    expect(isEligibleInboundReply({ transcript_path: t }, 'telegram', 'BBB')).toBe(false);
  });

  test('no transcript_path on the event is not eligible', () => {
    expect(isEligibleInboundReply({}, 'telegram', '123')).toBe(false);
  });

  test('a nonexistent transcript_path fails closed (not eligible)', () => {
    expect(isEligibleInboundReply({ transcript_path: '/nonexistent/path/transcript.jsonl' }, 'telegram', '123')).toBe(false);
  });
});
