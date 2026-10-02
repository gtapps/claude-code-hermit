// injection-scan.ts — deterministic scan of model-editable scheduled-prompt
// sources (HEARTBEAT.md) for injection markers. Deliberately tiny: three
// high-precision pattern classes, no credential-shaped matching (FP-prone —
// hermit state legitimately discusses TOKEN/deny-pattern work). This is
// defense-in-depth over the PreToolUse chokepoint, not a boundary.
import { INJECTION_TAGS } from './sanitize';

export interface InjectionHit { cls: 'override' | 'context-marker' | 'decode-pipe'; line: number }

const OVERRIDE_RE = /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|context|rules?|messages?)\b/i;
// Fresh non-global regex built from the shared tag list (sanitize.ts's own
// INJECTION_RE is `g`-flagged and stateful under .test()).
const MARKER_RE = new RegExp(`<\\/?(?:${INJECTION_TAGS.join('|')})(\\s[^>]*)?\\/?>`, 'i');
const DECODE_PIPE_RE = /base64\s+(-d|--decode)\b[^|]*\|\s*(sh|bash|zsh)\b/i;

export function scanForInjection(text: string): InjectionHit | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (OVERRIDE_RE.test(l)) return { cls: 'override', line: i + 1 };
    if (MARKER_RE.test(l)) return { cls: 'context-marker', line: i + 1 };
    if (DECODE_PIPE_RE.test(l)) return { cls: 'decode-pipe', line: i + 1 };
  }
  return null;
}
