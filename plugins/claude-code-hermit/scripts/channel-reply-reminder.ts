// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// UserPromptSubmit hook — when the inbound prompt starts with a <channel>
// envelope, injects an additionalContext reminder naming the exact reply tool
// and chat_id. Operators on Discord/Telegram read the channel, not the
// transcript; this reminder fires right before the model's next turn.
//
// Also captures the inbound message into the episodic channel log (PROP-010)
// — see scripts/lib/channel-log.ts. Capture is best-effort and strictly
// secondary to the reminder: it runs after the reminder is written, in its
// own try/catch, and a logging failure never affects the reminder.

import { safeForLLM } from './lib/sanitize';
import { hermitDir } from './lib/cc-compat';
import { logMessage, isLoggingEnabled } from './lib/channel-log';
import { loadConfig, isAllowedSender } from './lib/channel-auth';
import { parseChannelEnvelope } from './lib/channel-envelope';

type Json = any;

// Known channel sources → exact MCP reply tool name.
// Unknown sources fall back to a generic phrase so future channel plugins
// still benefit from the reminder without a code change.
const REPLY_TOOLS: Record<string, string> = {
  discord: 'mcp__plugin_discord_discord__reply',
  telegram: 'mcp__plugin_telegram_telegram__reply',
  imessage: 'mcp__plugin_imessage_imessage__reply',
};

const MAX_SOURCE_LEN = 32;
const MAX_CHAT_ID_LEN = 128;

function main(raw: string): void {
  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : null;
  if (!prompt) return;

  const envelope = parseChannelEnvelope(prompt);
  if (!envelope) return;

  const sourceKey = envelope.sourceKey;
  const chatIdRaw = envelope.chatId;

  const source = safeForLLM(sourceKey.slice(0, MAX_SOURCE_LEN));
  const chatId = safeForLLM(chatIdRaw.slice(0, MAX_CHAT_ID_LEN));

  const tool = REPLY_TOOLS[source];
  const toolLine = tool
    ? `\`${tool}\` with chat_id="${chatId}"`
    : `the channel's \`reply\` tool with chat_id="${chatId}"`;

  process.stdout.write(
    `[channel reply reminder] Inbound message arrived on the \`${source || 'unknown'}\` channel` +
    ` (chat_id=\`${chatId}\`). Substantive reply must go through ${toolLine}.` +
    ` Transcript/terminal output does not reach the operator.\n`
  );

  // Episodic capture — best-effort, never affects the reminder above.
  try {
    if (!envelope.body) return;

    const dir = hermitDir();
    const config = loadConfig(dir);
    if (!isLoggingEnabled(config)) return;

    // Raw source (not sourceKey): channelEntry normalizes it internally, and
    // pause-keyword.ts and channel-status-responder.ts feed the same raw source
    // into this gate — one convention across every caller.
    if (!isAllowedSender(config, envelope.source, envelope.userId)) return;

    const result = logMessage(dir, {
      source: sourceKey,
      chat_id: chatIdRaw,
      direction: 'in',
      sender: envelope.userId,
      message_id: envelope.messageId,
      text: envelope.body,
      ts: envelope.ts ?? undefined,
    });
    if (!result.ok) {
      process.stderr.write(`[channel-log] inbound capture failed: ${result.error}\n`);
    }
  } catch (e: any) {
    process.stderr.write(`[channel-log] inbound capture failed: ${e?.message || e}\n`);
  }
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try { main(buf); } catch { /* fail open */ }
    process.exit(0);
  });
} catch {
  process.exit(0);
}
