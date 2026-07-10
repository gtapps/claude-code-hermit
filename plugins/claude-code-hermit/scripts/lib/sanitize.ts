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

// Shared by safeForLLM/safeForLLMMultiline: wraps a matched marker tag in
// brackets instead of stripping it, so the tag name stays readable for debugging.
function defuseTags(s: string): string {
  return s.replace(INJECTION_RE, (match) => '[' + match.slice(1, -1) + ']');
}

// Like safe(), but also defuses prompt-injection tag patterns so hook rejection
// text can be safely routed to Claude's context via continueOnBlock.
function safeForLLM(s: any): string {
  return defuseTags(safe(s));
}

// Like safe(), but preserves \n/\r/\t — for multi-paragraph content headed
// into model context (not a terminal), where legitimate newlines must survive
// and only the remaining control bytes are a terminal-escape concern.
function safeMultiline(s: any): string {
  return String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '?');
}

// Like safeForLLM(), but for multi-paragraph content (see safeMultiline()).
function safeForLLMMultiline(s: any): string {
  return defuseTags(safeMultiline(s));
}

// Tight, high-precision markers for content injected into session-start
// context (compiled bodies/stubs, catalog summaries, OPERATOR/SHELL excerpts).
// Deliberately minimal: hermit's own compiled/ security artifacts quote
// injection phrases, so every pattern here must be near-zero-FP on prose
// *about* injection. A hit blocks one injected entry (file stays on disk).
const INJECTION_MARKERS: [RegExp, string][] = [
  [/ignore\s+(?:all\s+)?previous\s+instructions/i, 'injection phrase'],
  [/disregard\s+(?:all\s+)?(?:prior|previous)\s+(?:instructions|context)/i, 'injection phrase'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'credential-shaped string (anthropic key)'],
  [/AKIA[0-9A-Z]{16}/, 'credential-shaped string (aws access key)'],
  [/ghp_[A-Za-z0-9]{36}/, 'credential-shaped string (github token)'],
  [/xox[bap]-[A-Za-z0-9-]{10,}/, 'credential-shaped string (slack token)'],
];

// Returns the block reason for the first marker hit, or null when clean.
function scanInjected(s: any): string | null {
  const text = String(s ?? '');
  for (const [re, reason] of INJECTION_MARKERS) {
    if (re.test(text)) return reason;
  }
  return null;
}

export { safe, safeForLLM, safeMultiline, safeForLLMMultiline, scanInjected };
