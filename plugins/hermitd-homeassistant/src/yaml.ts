// WP7 tier 1 — normalization wrapper around Bun.YAML for PyYAML parity.
//
// ALL TypeScript modules in this plugin must go through parseYaml/dumpYaml,
// never Bun.YAML directly. The contract is pinned by the WP7 spike
// (tests/yaml-parity.test.ts): PyYAML implements YAML 1.1, Bun.YAML the 1.2
// core schema, and the spike's gate (c) showed Bun.YAML.stringify emits some
// plain strings that PyYAML re-coerces on read (sexagesimal ints like 10:30,
// ISO dates/datetimes, underscored ints like 1_000). dumpYaml re-quotes those
// so PyYAML/Home Assistant reads Bun's output identically.
//
// parseYaml additionally rejects multi-document streams: every Python call
// site uses yaml.safe_load, which raises ComposerError on a second document,
// while Bun.YAML.parse silently returns an array of documents.

/**
 * Parse a single-document YAML string (PyYAML `safe_load` semantics).
 *
 * Throws on multi-document streams (`---` after content, or content after a
 * `...` end marker) — Bun.YAML.parse would silently return an array of
 * documents, which is indistinguishable from a top-level sequence.
 *
 * Documented YAML 1.2 readings (accepted per the spike): `yes/no/on/off`
 * parse as strings, `10:30` parses as the string "10:30", ISO timestamps
 * parse as ISO strings (not datetime objects), legacy octals parse as
 * decimals.
 */
export function parseYaml(text: string): unknown {
  assertSingleDocument(text);
  return Bun.YAML.parse(text);
}

function assertSingleDocument(text: string): void {
  let sawContent = false;
  let sawDocStart = false;
  let sawDocEnd = false;
  const fail = () => {
    throw new Error(
      'parseYaml: multi-document YAML stream — PyYAML safe_load parity requires a single document',
    );
  };
  for (const line of text.split('\n')) {
    if (/^---(\s|$)/.test(line)) {
      // A document-start marker is only acceptable once, before any content.
      if (sawContent || sawDocStart || sawDocEnd) fail();
      sawDocStart = true;
    } else if (/^\.\.\.(\s|$)/.test(line)) {
      sawDocEnd = true;
    } else if (line.trim() !== '' && !line.trimStart().startsWith('#')) {
      if (sawDocEnd) fail(); // content after `...` starts a second document
      // %YAML/%TAG directives are only legal in the prelude before `---`.
      if (!sawDocStart && !sawContent && line.startsWith('%')) continue;
      sawContent = true;
    }
  }
}

/**
 * Serialize to block-style YAML (2-space indent) that PyYAML reads back
 * identically to the input value.
 *
 * Post-processes Bun.YAML.stringify output to quote plain scalars matching
 * PyYAML 1.1 implicit-resolver patterns that the 1.2 emitter leaves bare
 * (closes the spike's gate-c failures).
 *
 * Throws on JS Date instances anywhere in the tree: Bun.YAML.stringify
 * silently emits `{}` for them (data loss). Timestamps must be passed as ISO
 * strings.
 */
export function dumpYaml(value: unknown): string {
  assertNoDates(value, '$', new Set());
  const text = Bun.YAML.stringify(value, null, 2);
  if (typeof text !== 'string') {
    throw new TypeError(`dumpYaml: Bun.YAML.stringify produced ${text} for the given value`);
  }
  return text.split('\n').map(quoteDivergentScalars).join('\n');
}

function assertNoDates(value: unknown, path: string, seen: Set<object>): void {
  if (value instanceof Date) {
    throw new TypeError(
      `dumpYaml: JS Date at ${path} — Bun.YAML.stringify silently emits {} for Dates (data loss); pass an ISO string instead`,
    );
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertNoDates(v, `${path}[${i}]`, seen));
    } else {
      for (const [k, v] of Object.entries(value)) assertNoDates(v, `${path}.${k}`, seen);
    }
  }
}

// PyYAML 1.1 implicit-resolver patterns that Bun.YAML.stringify emits as
// plain (unquoted) strings. Quoting is always content-preserving for strings,
// so the patterns may over-match strings; they must never match a scalar Bun
// emits for a NUMBER (numbers never stringify with `:`, `-` between digit
// groups, or `_`), or quoting would corrupt number round-trips.
function isPyyaml11Coercible(scalar: string): boolean {
  // Sexagesimal ints/floats: 10:30 -> 630, 1:02:03 -> 3723, 1:02:03.5 -> 3723.5
  if (/^[-+]?\d+(:\d+)+(\.\d*)?$/.test(scalar)) return true;
  // ISO date: 2024-01-01 -> datetime.date (also quotes timestamp-shaped-but-
  // invalid scalars like 2024-13-45, which PyYAML otherwise rejects with
  // ValueError at parse time)
  if (/^\d{4}-\d{2}-\d{2}$/.test(scalar)) return true;
  // ISO datetime (PyYAML timestamp resolver: T/t/space separator, optional
  // fraction, optional Z or +-HH[:MM] offset)
  if (
    /^\d{4}-\d{1,2}-\d{1,2}([Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(\.\d*)?([ \t]*(Z|[-+]\d{1,2}(:\d{2})?))?$/.test(
      scalar,
    )
  ) {
    return true;
  }
  // Underscored ints: 1_000 -> 1000. The underscore is required: a bare
  // "1000" on this line came from a JS number (Bun quotes 1.2-coercible
  // strings) and must stay a plain int.
  if (scalar.includes('_') && /^[-+]?\d[\d_]*$/.test(scalar)) return true;
  return false;
}

const quoteIfDivergent = (scalar: string): string =>
  isPyyaml11Coercible(scalar) ? `"${scalar}"` : scalar;

/**
 * Re-quote divergent plain scalars on one emitted line.
 *
 * Safe to do line-wise because Bun.YAML.stringify (block mode) never emits
 * block scalars (multiline strings become escaped double-quoted scalars on a
 * single line) and never emits comments, so every line is one of:
 *   `<indent>[- ...]key: value` | `<indent>[- ...]key:` | `<indent>[- ...]scalar`
 * Plain keys/scalars cannot contain ": " (Bun quotes them), so the first
 * ": " is always the key/value separator.
 */
function quoteDivergentScalars(line: string): string {
  const match = /^(\s*)(.*)$/.exec(line)!;
  let prefix = match[1]!;
  let rest = match[2]!;
  while (rest.startsWith('- ')) {
    prefix += '- ';
    rest = rest.slice(2);
  }
  if (rest === '') return line;

  if (rest.startsWith('"') || rest.startsWith("'")) {
    // Quoted scalar or quoted key — quoted scalars are already PyYAML-safe;
    // only a plain value after a quoted key still needs processing.
    const close = findClosingQuote(rest);
    if (close === -1) return line;
    const afterKey = rest.slice(close + 1);
    if (!afterKey.startsWith(': ')) return line; // standalone quoted scalar
    return `${prefix}${rest.slice(0, close + 1)}: ${processValue(afterKey.slice(2))}`;
  }

  const sep = rest.indexOf(': ');
  if (sep !== -1) {
    const key = rest.slice(0, sep);
    const value = rest.slice(sep + 2);
    return `${prefix}${quoteIfDivergent(key)}: ${processValue(value)}`;
  }
  if (rest.endsWith(':')) {
    return `${prefix}${quoteIfDivergent(rest.slice(0, -1))}:`;
  }
  return `${prefix}${processValue(rest)}`;
}

function processValue(value: string): string {
  if (value === '') return value;
  const first = value[0]!;
  // Already-quoted scalars are safe; anchors (&), aliases (*) and flow
  // collections ({,[) are structural, not coercible plain scalars.
  if (first === '"' || first === "'" || first === '&' || first === '*') return value;
  return quoteIfDivergent(value);
}

/** Index of the closing quote of a scalar starting at index 0, or -1. */
function findClosingQuote(text: string): number {
  const quote = text[0];
  if (quote === '"') {
    for (let i = 1; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return i;
    }
    return -1;
  }
  // Single-quoted YAML escapes quotes by doubling ('')
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}
