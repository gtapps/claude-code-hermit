// Shared <channel ...>body</channel> envelope parser — used by every
// UserPromptSubmit hook that reacts to an inbound channel message
// (channel-reply-reminder.ts, channel-status-responder.ts). A single copy so
// the attribute regex and body-extraction rule can't drift out of sync
// between callers.
//
// Fields are returned raw (unclamped, unsanitized) — callers that display
// them (e.g. in an LLM-facing reminder) are responsible for their own
// sanitize/length-clamp; callers that only compare or log them (auth gates,
// episodic capture) use them as-is, matching pre-extraction behavior.

export interface ChannelEnvelope {
  source: string;
  chatId: string;
  userId: string | null;
  messageId: string | null;
  ts: string | null;
  body: string;
}

/**
 * Parses a prompt that starts with a <channel source="..." chat_id="..." ...>
 * opening tag. Returns null when the prompt doesn't start with such a tag, or
 * when the mandatory chat_id attribute is absent.
 *
 * The attribute regex handles `>` inside quoted attribute values (e.g.
 * adversarial chat_id values containing XML-like tags).
 */
export function parseChannelEnvelope(prompt: string): ChannelEnvelope | null {
  const tagMatch = prompt.match(/^\s*<channel\s+((?:"[^"]*"|[^>])*)\s*>/);
  if (!tagMatch) return null;

  const attrs = tagMatch[1];
  const chatIdMatch = attrs.match(/\bchat_id="([^"]*)"/);
  if (!chatIdMatch) return null;

  const sourceMatch = attrs.match(/\bsource="([^"]*)"/);
  const userMatch = attrs.match(/\buser="([^"]*)"/);
  const messageIdMatch = attrs.match(/\bmessage_id="([^"]*)"/);
  const tsMatch = attrs.match(/\bts="([^"]*)"/);

  let body = prompt.slice(tagMatch[0].length);
  const closeIdx = body.indexOf('</channel>');
  if (closeIdx !== -1) body = body.slice(0, closeIdx);

  return {
    source: sourceMatch ? sourceMatch[1] : '',
    chatId: chatIdMatch[1],
    userId: userMatch ? userMatch[1] : null,
    messageId: messageIdMatch ? messageIdMatch[1] : null,
    ts: tsMatch ? tsMatch[1] : null,
    body: body.trim(),
  };
}
