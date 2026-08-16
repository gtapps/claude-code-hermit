import fs from 'node:fs';
import path from 'node:path';
import { safe } from './lib/sanitize';
import { hermitDir, transcriptPath, turnPromptText } from './lib/cc-compat';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { logMessage, isLoggingEnabled } from './lib/channel-log';

type Json = any;

/**
 * PostToolUse hook for channel reply tools (Discord, Telegram, etc.).
 *
 * Runs after any channel MCP reply tool call. Handles:
 * - Episodic capture of the outbound reply text (PROP-010, best-effort — see
 *   scripts/lib/channel-log.ts). Runs before the "channel configured" gate
 *   below so replies on not-yet-configured channels are still captured.
 * - Persisting dm_channel_id from chat_id in tool input (config.json) — but
 *   ONLY when the reply was sent during a turn that a matching inbound
 *   envelope actually opened (see isEligibleInboundReply). A proactive send
 *   (routine wake, heartbeat, scheduled brief) carries no inbound envelope at
 *   all, or one from a different chat, and must never be mistaken for the
 *   operator having moved their primary DM.
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
// Tail window for the transcript read below — only the boundary prompt that
// opened the CURRENT turn is needed (mirrors cost-tracker.ts's TAIL_BYTES
// pattern), so this stays far smaller than a whole-session read. 128KB
// comfortably covers a turn's leading envelope/prompt plus some preceding
// tool_result noise without doing O(session-size) I/O on every single reply.
const TAIL_BYTES = 128 * 1024;

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

export function persistDmChannelId(config: Json, channelKey: string, chatId: Json, isInboundReply: boolean): boolean {
  if (!chatId) return false;

  // Coerce to string (mirrors the log path's String() at the outbound-capture
  // block): a channel plugin delivering a numeric chat_id must not write a
  // number into config.json — the sender allow-list gate compares IDs as
  // strings, and a numeric dm_channel_id also fails validate-config.
  const id = String(chatId);
  const channel = config.channels[channelKey];
  if (channel.dm_channel_id === id) return false;

  // A proactive/scheduled send (routine wake, heartbeat, a brief fired on a
  // timer) opens its own turn with no matching inbound envelope — replying
  // there is not evidence the operator moved their primary DM. Generalizes
  // the maintainer_channel_id exemption below: any outbound chat_id reached
  // without a same-chat inbound trigger is a known, deliberate second
  // destination, not a relocation signal. See main()'s isEligibleInboundReply.
  if (!isInboundReply) {
    process.stderr.write(
      `[channel-hook] skipped ${channelKey}.dm_channel_id — ${safe(id)} reply wasn't opened by a matching inbound message\n`
    );
    return false;
  }

  // The maintainer chat is an outbound-only second destination
  // (docs/security.md § tiered disclosure) and must never be adopted as the
  // primary bidirectional chat — dm_channel_id also binds operator trust in
  // lib/channel-auth.ts isTrustedController. Replying into the maintainer
  // chat must not re-learn it as the DM channel.
  const maintainer = channel.maintainer_channel_id;
  if (maintainer != null && String(maintainer) === id) {
    process.stderr.write(
      `[channel-hook] skipped ${channelKey}.dm_channel_id — ${safe(id)} is the maintainer chat\n`
    );
    return false;
  }

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

// Was this reply sent during a turn that a matching inbound envelope actually
// opened? Reads only a tail window of the transcript (TAIL_BYTES) — cheap
// enough to run on every reply, unlike a whole-session read — finds the
// boundary prompt that started the CURRENT turn (mirrors cost-tracker.ts's
// resolveTurnSource/turnPromptText usage), and requires that prompt to be a
// <channel> envelope from the SAME chat this reply is going to. A routine
// wake, heartbeat, or scheduled brief opens its turn on something else
// entirely (or nothing at all within the window) and is correctly ineligible.
export function isEligibleInboundReply(event: Json, channelKey: string, chatId: Json): boolean {
  try {
    const tPath = transcriptPath(event);
    if (!tPath) return false;

    const stat = fs.statSync(tPath);
    const readFrom = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(tPath, 'r');
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);

    const lines = buf.toString('utf-8').split('\n');
    // Drop the first line when mid-file (it's a partial line).
    if (readFrom > 0) lines.shift();

    const prompt = turnPromptText(lines, lines.length);
    if (!prompt.boundaryFound) return false;

    const envelope = parseChannelEnvelope(prompt.text);
    if (!envelope) return false;

    return envelope.sourceKey === channelKey && envelope.chatId === String(chatId ?? '');
  } catch {
    return false;
  }
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

      const isInboundReply = isEligibleInboundReply(event, channelKey, input.chat_id);
      dirty = persistDmChannelId(config, channelKey, input.chat_id, isInboundReply) || dirty;
      if (dirty) writeConfig(config);

      const ts = new Date().toISOString();
      updateLastReplyAt(channelKey, ts);
      appendReplyEvent(channelKey, ts);
    } catch (e) {
      // Silently ignore errors — don't block the agent
    }
  });
}

// Guard so importing this module (e.g. a unit test of persistDmChannelId or
// isEligibleInboundReply) doesn't run the hook. Direct execution as a hook
// keeps import.meta.main true.
if (import.meta.main) main();
