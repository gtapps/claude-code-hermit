// Shared <channel ...>body</channel> envelope parser — used by every
// UserPromptSubmit hook that reacts to an inbound channel message
// (channel-reply-reminder.ts, channel-status-responder.ts, pause-keyword.ts).
// A single copy so the attribute regex and body-extraction rule can't drift
// out of sync between callers.
//
// Fields are returned raw (unclamped, unsanitized) — callers that display
// them (e.g. in an LLM-facing reminder) are responsible for their own
// sanitize/length-clamp; callers that only compare or log them (auth gates,
// episodic capture) use them as-is, matching pre-extraction behavior.

export interface ChannelEnvelope {
  source: string;
  /** `source` normalized to the config-key form — see normalizeChannelSource(). */
  sourceKey: string;
  chatId: string;
  userId: string | null;
  messageId: string | null;
  ts: string | null;
  body: string;
}

/**
 * The harness injects channel envelopes with a plugin-qualified source
 * (`plugin:<plugin-name>:<server-name>`, e.g. `plugin:discord:discord`,
 * `plugin:voice:voice` — verified live across every fleet hermit), but
 * `config.json` keys `channels` by the bare server name (what `hatch` writes).
 * Any lookup that indexes `config.channels` by an envelope's raw `source`
 * therefore misses for every real inbound message — the root cause of #634.
 *
 * Returns the captured server name for a two-segment `plugin:` source;
 * anything else (already-bare, or an unrecognized future shape) passes
 * through unchanged, so a caller's own lookup fails closed on unfamiliar
 * input rather than this function guessing.
 *
 * This is the single normalizer for the wire source shape: lib/trigger-source.ts's
 * classifySource calls it too (for cost-attribution bucketing), so config lookup
 * and cost attribution can't drift apart on how they parse a `plugin:` source.
 */
export function normalizeChannelSource(source: string): string {
  const m = /^plugin:[^:]+:([^:]+)$/.exec(source);
  return m ? m[1] : source;
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

  const source = sourceMatch ? sourceMatch[1] : '';

  return {
    source,
    sourceKey: normalizeChannelSource(source),
    chatId: chatIdMatch[1],
    userId: userMatch ? userMatch[1] : null,
    messageId: messageIdMatch ? messageIdMatch[1] : null,
    ts: tsMatch ? tsMatch[1] : null,
    body: body.trim(),
  };
}
