import { describe, test, expect } from 'bun:test';
import { persistDmChannelId } from '../scripts/channel-hook';

// The sender allow-list gate (channel-reply-reminder.ts isAllowedSender) and
// validate-config both require channel IDs to be strings. If a channel plugin
// delivers chat_id as a JSON number, persistDmChannelId must coerce it so a
// number never lands in config.json.
describe('persistDmChannelId — dm_channel_id string coercion', () => {
  test('coerces a numeric chat_id to its string form', () => {
    const config: any = { channels: { discord: { dm_channel_id: null } } };
    const changed = persistDmChannelId(config, 'discord', 555);
    expect(changed).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('555');
    expect(typeof config.channels.discord.dm_channel_id).toBe('string');
  });

  test('a numeric chat_id equal to the stored string id is a no-op', () => {
    const config: any = { channels: { discord: { dm_channel_id: '555' } } };
    expect(persistDmChannelId(config, 'discord', 555)).toBe(false);
    expect(persistDmChannelId(config, 'discord', '555')).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('555');
  });

  test('a falsy chatId returns false and leaves the existing id untouched', () => {
    const config: any = { channels: { discord: { dm_channel_id: 'D1' } } };
    expect(persistDmChannelId(config, 'discord', null)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });
});
