// Claude Code transcript JSONL builders. The schema encoded here is the one
// scripts/lib/cc-compat.ts parses (extractUsage / turnPromptText).
// tests/fixture-helpers.test.ts pins the two together, so a cc-compat field
// rename that isn't mirrored here fails loudly there instead of silently
// zeroing every cost suite. It cannot detect an upstream Claude Code schema
// change on its own — nothing here reads a real transcript.

export function triggerPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

export interface AssistantEntryOpts {
  model?: string;
  timestamp?: string;
  isSidechain?: boolean;
  inputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  outputTokens?: number;
  requestId?: string;
  messageId?: string;
  cacheWrite1h?: number;
}

export function assistantEntry(opts: AssistantEntryOpts = {}): string {
  const {
    model = 'claude-sonnet-4-6',
    timestamp,
    isSidechain,
    inputTokens = 2,
    cacheRead = 0,
    cacheWrite = 0,
    outputTokens = 50,
    requestId,
    messageId,
    cacheWrite1h,
  } = opts;
  return JSON.stringify({
    type: 'assistant',
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(isSidechain !== undefined ? { isSidechain } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    message: {
      ...(messageId !== undefined ? { id: messageId } : {}),
      model,
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: outputTokens,
        ...(cacheWrite1h !== undefined ? {
          cache_creation: {
            ephemeral_5m_input_tokens: cacheWrite - cacheWrite1h,
            ephemeral_1h_input_tokens: cacheWrite1h,
          },
        } : {}),
      },
      content: [{ type: 'text', text: 'ok' }],
    },
  });
}

// Positional form the cost/subagent suites bill against: a model plus plain
// input/output tokens, no cache traffic and no timestamp.
export const assistantEntryFor = (model: string, inputTokens: number, outputTokens: number): string =>
  assistantEntry({ model, inputTokens, outputTokens });
