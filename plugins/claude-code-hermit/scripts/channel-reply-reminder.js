'use strict';

// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// UserPromptSubmit hook — when the inbound prompt starts with a <channel>
// envelope, injects an additionalContext reminder naming the exact reply tool
// and chat_id. Operators on Discord/Telegram read the channel, not the
// transcript; this reminder fires right before the model's next turn.

const { safeForLLM } = require('./lib/sanitize.js');

// Known channel sources → exact MCP reply tool name.
// Unknown sources fall back to a generic phrase so future channel plugins
// still benefit from the reminder without a code change.
const REPLY_TOOLS = {
  discord: 'mcp__plugin_discord_discord__reply',
  telegram: 'mcp__plugin_telegram_telegram__reply',
  imessage: 'mcp__plugin_imessage_imessage__reply',
};

const MAX_SOURCE_LEN = 32;
const MAX_CHAT_ID_LEN = 128;

function main(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : null;
  if (!prompt) return;

  // Only fire when the prompt starts with a <channel ...> opening tag.
  // Use a regex that handles > inside quoted attribute values (e.g. adversarial
  // chat_id values containing XML-like tags).
  const tagMatch = prompt.match(/^\s*<channel\s+((?:"[^"]*"|[^>])*)\s*>/);
  if (!tagMatch) return;

  const attrs = tagMatch[1];

  const sourceMatch = attrs.match(/\bsource="([^"]*)"/);
  const chatIdMatch = attrs.match(/\bchat_id="([^"]*)"/);
  if (!chatIdMatch) return;

  const source = safeForLLM(
    (sourceMatch ? sourceMatch[1] : '').slice(0, MAX_SOURCE_LEN)
  );
  const chatId = safeForLLM(chatIdMatch[1].slice(0, MAX_CHAT_ID_LEN));

  const tool = REPLY_TOOLS[source];
  const toolLine = tool
    ? `\`${tool}\` with chat_id="${chatId}"`
    : `the channel's \`reply\` tool with chat_id="${chatId}"`;

  process.stdout.write(
    `[channel reply reminder] Inbound message arrived on the \`${source || 'unknown'}\` channel` +
    ` (chat_id=\`${chatId}\`). Substantive reply must go through ${toolLine}.` +
    ` Transcript/terminal output does not reach the operator.\n`
  );
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
