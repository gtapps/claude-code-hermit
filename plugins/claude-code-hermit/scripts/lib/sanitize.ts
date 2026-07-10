// Replace C0 controls + DEL + C1 controls with `?` so adversarial tool_input
// values can't inject newlines, ANSI escapes, or 8-bit terminal commands into
// hermit's stderr. C1 (U+0080..U+009F) doesn't appear in legitimate file paths
// or chat IDs, so stripping it is safe.
function safe(s: any): string {
  return String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}

// Known XML-like tag names used as Claude/CC context markers. Matching these
// in hook rejection text (routed to Claude via continueOnBlock) would let an
// adversarial config value impersonate system context. We bracket-wrap instead
// of stripping so the tag name stays readable for debugging.
const INJECTION_TAGS = [
  'system-reminder', 'system', 'assistant', 'user',
  'tool_use', 'tool_result', 'thinking', 'function_calls',
];
const INJECTION_RE = new RegExp(
  `<(\\/?)(?:${INJECTION_TAGS.join('|')})(\\s[^>]*)?/?>`,
  'gi'
);

// Like safe(), but also defuses prompt-injection tag patterns so hook rejection
// text can be safely routed to Claude's context via continueOnBlock.
function safeForLLM(s: any): string {
  return safe(s).replace(INJECTION_RE, (match) => '[' + match.slice(1, -1) + ']');
}

export { safe, safeForLLM, INJECTION_TAGS };
