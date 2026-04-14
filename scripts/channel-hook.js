'use strict';

const fs = require('fs');
const path = require('path');

/**
 * PostToolUse hook for channel reply tools (Discord, Telegram, etc.).
 *
 * Runs after any channel MCP reply tool call. Handles:
 * - Persisting dm_channel_id from chat_id in tool input (config.json)
 * - Updating last_reply_at timestamp (state/channel-activity.json)
 *
 * Only acts when the channel is already configured in config.json.
 */

const CONFIG_PATH = path.resolve('.claude-code-hermit/config.json');
const ACTIVITY_PATH = path.resolve('.claude-code-hermit/state/channel-activity.json');
const MAX_STDIN = 64 * 1024;

const SERVER_TO_CHANNEL = {
  discord: 'discord',
  telegram: 'telegram',
};

function resolveChannel(toolName) {
  // The hooks.json matcher already filters to channel reply tools.
  // Just extract the channel name from anywhere in the tool name —
  // covers all formats: mcp__discord__reply, plugin_discord_discord_reply,
  // mcp__plugin_discord_discord__reply, etc.
  const match = (toolName || '').match(/(discord|telegram)/);
  if (!match) return null;
  return SERVER_TO_CHANNEL[match[1]] || null;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function persistDmChannelId(config, channelKey, chatId) {
  if (!chatId) return false;

  const channel = config.channels[channelKey];
  if (channel.dm_channel_id === chatId) return false;

  channel.dm_channel_id = chatId;
  process.stderr.write(
    `[channel-hook] saved ${channelKey}.dm_channel_id = ${chatId}\n`
  );
  return true;
}

function updateLastReplyAt(channelKey) {
  try {
    let activity = {};
    try {
      activity = JSON.parse(fs.readFileSync(ACTIVITY_PATH, 'utf8'));
    } catch {}

    if (!activity[channelKey]) activity[channelKey] = {};
    activity[channelKey].last_reply_at = new Date().toISOString();

    fs.writeFileSync(ACTIVITY_PATH, JSON.stringify(activity, null, 2) + '\n');
  } catch {}
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN) process.exit(0);
  });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(raw);
      const toolName = event.tool_name || '';
      const input = event.tool_input || {};

      const channelKey = resolveChannel(toolName);
      if (!channelKey) return;

      const config = readConfig();
      if (!config || !config.channels || !config.channels[channelKey]) return;

      let dirty = false;

      dirty = persistDmChannelId(config, channelKey, input.chat_id) || dirty;
      if (dirty) writeConfig(config);

      updateLastReplyAt(channelKey);
    } catch (e) {
      // Silently ignore errors — don't block the agent
    }
  });
}

main();
