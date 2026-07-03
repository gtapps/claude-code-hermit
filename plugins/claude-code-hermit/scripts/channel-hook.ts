import fs from 'node:fs';
import path from 'node:path';
import { safe } from './lib/sanitize';
import { hermitDir } from './lib/cc-compat';
import { logMessage, isLoggingEnabled } from './lib/channel-log';

type Json = any;

/**
 * PostToolUse hook for channel reply tools (Discord, Telegram, etc.).
 *
 * Runs after any channel MCP reply tool call. Handles:
 * - Episodic capture of the outbound reply text (PROP-010, best-effort — see
 *   scripts/lib/channel-log.ts). Runs before the "channel configured" gate
 *   below so replies on not-yet-configured channels are still captured.
 * - Persisting dm_channel_id from chat_id in tool input (config.json)
 * - Updating last_reply_at timestamp (state/channel-activity.json)
 * - Appending a reply event to state/channel-replies.jsonl (routine-ROI source)
 *
 * The config-persistence steps below only act once the channel is already
 * configured in config.json — episodic capture is the one exception.
 */

const HERMIT_DIR = hermitDir();
const CONFIG_PATH = path.join(HERMIT_DIR, 'config.json');
const ACTIVITY_PATH = path.join(HERMIT_DIR, 'state', 'channel-activity.json');
const REPLIES_PATH = path.join(HERMIT_DIR, 'state', 'channel-replies.jsonl');
const MAX_STDIN = 64 * 1024;

const SERVER_TO_CHANNEL: Record<string, string> = {
  discord: 'discord',
  telegram: 'telegram',
  imessage: 'imessage',
};

function resolveChannel(toolName: string): string | null {
  // The hooks.json matcher already filters to channel reply tools.
  // Just extract the channel name from anywhere in the tool name —
  // covers all formats: mcp__discord__reply, plugin_discord_discord_reply,
  // mcp__plugin_discord_discord__reply, etc.
  const match = (toolName || '').match(/(discord|telegram|imessage)/);
  if (!match) return null;
  return SERVER_TO_CHANNEL[match[1]] || null;
}

function readConfig(): Json | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(config: Json): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function persistDmChannelId(config: Json, channelKey: string, chatId: Json): boolean {
  if (!chatId) return false;

  // Coerce to string (mirrors the log path's String() at the outbound-capture
  // block): a channel plugin delivering a numeric chat_id must not write a
  // number into config.json — the sender allow-list gate compares IDs as
  // strings, and a numeric dm_channel_id also fails validate-config.
  const id = String(chatId);
  const channel = config.channels[channelKey];
  if (channel.dm_channel_id === id) return false;

  channel.dm_channel_id = id;
  process.stderr.write(
    `[channel-hook] saved ${channelKey}.dm_channel_id = ${safe(id)}\n`
  );
  return true;
}

function updateLastReplyAt(channelKey: string, ts: string): void {
  try {
    let activity: Json = {};
    try {
      activity = JSON.parse(fs.readFileSync(ACTIVITY_PATH, 'utf8'));
    } catch {}

    if (!activity[channelKey]) activity[channelKey] = {};
    activity[channelKey].last_reply_at = ts;

    fs.writeFileSync(ACTIVITY_PATH, JSON.stringify(activity, null, 2) + '\n');
  } catch {}
}

function appendReplyEvent(channelKey: string, ts: string): void {
  try {
    const entry = JSON.stringify({ ts, channel: channelKey, event: 'reply' });
    fs.appendFileSync(REPLIES_PATH, entry + '\n', 'utf8');
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

      // Episodic capture (PROP-010) — deliberately before the "channel
      // configured" gate below, so replies on not-yet-configured channels
      // are still captured. Best-effort; never throws past this block.
      try {
        const text = input.text;
        if (isLoggingEnabled(config) && typeof text === 'string' && text) {
          const result = logMessage(HERMIT_DIR, {
            source: channelKey,
            chat_id: input.chat_id != null ? String(input.chat_id) : '',
            direction: 'out',
            text,
          });
          if (!result.ok) {
            process.stderr.write(`[channel-log] outbound capture failed: ${result.error}\n`);
          }
        }
      } catch (e: any) {
        process.stderr.write(`[channel-log] outbound capture failed: ${e?.message || e}\n`);
      }

      if (!config || !config.channels || !config.channels[channelKey]) return;

      let dirty = false;

      dirty = persistDmChannelId(config, channelKey, input.chat_id) || dirty;
      if (dirty) writeConfig(config);

      const ts = new Date().toISOString();
      updateLastReplyAt(channelKey, ts);
      appendReplyEvent(channelKey, ts);
    } catch (e) {
      // Silently ignore errors — don't block the agent
    }
  });
}

// Guard so importing this module (e.g. a unit test of persistDmChannelId)
// doesn't run the hook. Direct execution as a hook keeps import.meta.main true.
if (import.meta.main) main();
