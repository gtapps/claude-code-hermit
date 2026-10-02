// WP7 spike: Bun.YAML vs PyYAML parity over the corpus in fixtures/yaml-corpus/.
//
// Gates per corpus file:
//   (a) PARSE EQUIVALENCE  — Bun.YAML.parse(text) vs Python yaml.safe_load(text)
//   (b) ROUND-TRIP         — Bun.YAML.parse(stringify(parse(text))) vs parse(text)
//   (c) DUMP COMPAT        — Python yaml.safe_load(Bun.YAML.stringify(parsed)) vs parsed
//                            (whatever Bun writes, Python/HA must read identically —
//                             this is the gate that matters for the apply path)
//
// PyYAML implements YAML 1.1; Bun.YAML implements the 1.2 core schema. The
// known 1.1-only scalar coercions (yes/no/on/off bools, sexagesimal ints like
// 10:30, ISO timestamps, legacy octals, underscored ints) are encoded below as
// KNOWN_PARSE_DIVERGENCES / KNOWN_DUMP_DIVERGENCES and asserted EXACTLY — the
// suite stays green while pinning every divergence. Any drift (a Bun upgrade
// changing coercion, a new corpus file diverging unexpectedly) fails the suite.
//
// Comparison is type-tagged, not just JSON-normalized: the prompt-prescribed
// `json.dumps(..., default=str)` normalization HIDES the date divergence
// (str(datetime.date(2024,1,1)) == "2024-01-01" == Bun's string), so Python
// scalars are tagged with their type (bool/int/float/str/datetime/date/null)
// and compared against the same tagging of Bun's output. A dedicated test
// below demonstrates the hiding effect.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CORPUS_DIR = join(import.meta.dir, "fixtures", "yaml-corpus");

// ---------------------------------------------------------------------------
// Python subprocess helpers
// ---------------------------------------------------------------------------

// The prompt-prescribed plain parse (JSON-normalized, default=str).
const PY_PLAIN =
  "import yaml,json,sys; print(json.dumps(yaml.safe_load(sys.stdin.read()), default=str))";

// Type-tagged parse: every scalar becomes {"t": <python type>, "v": <value>}
// so type divergences (bool vs str, int vs str, datetime vs str) are visible.
const PY_TYPED = `
import yaml, json, sys, datetime
def tag(v):
    if isinstance(v, dict): return {k: tag(x) for k, x in v.items()}
    if isinstance(v, list): return [tag(x) for x in v]
    if isinstance(v, bool): return {"t": "bool", "v": v}
    if isinstance(v, datetime.datetime): return {"t": "datetime", "v": v.isoformat()}
    if isinstance(v, datetime.date): return {"t": "date", "v": v.isoformat()}
    if isinstance(v, float):
        if v != v: return {"t": "float", "v": "nan"}
        if v == float("inf"): return {"t": "float", "v": "inf"}
        if v == float("-inf"): return {"t": "float", "v": "-inf"}
        return {"t": "float", "v": v}
    if isinstance(v, int): return {"t": "int", "v": v}
    if isinstance(v, str): return {"t": "str", "v": v}
    if v is None: return {"t": "null", "v": None}
    return {"t": type(v).__name__, "v": str(v)}
try:
    print(json.dumps({"ok": True, "data": tag(yaml.safe_load(sys.stdin.read()))}))
except Exception as e:
    print(json.dumps({"ok": False, "error": type(e).__name__}))
`;

const PY_MULTIDOC = `
import yaml, json, sys
print(json.dumps(list(yaml.safe_load_all(sys.stdin.read()))))
`;

let python = "";

function resolvePython(): string {
  const candidates = [
    process.env.YAML_PARITY_PYTHON,
    join(import.meta.dir, "..", ".venv", "bin", "python"),
    "python3",
    "/usr/bin/python3",
    "python",
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      const r = Bun.spawnSync([c, "-c", "import yaml"]);
      if (r.exitCode === 0) return c;
    } catch {
      // candidate not on PATH
    }
  }
  throw new Error(
    "No Python with PyYAML found (tried YAML_PARITY_PYTHON, plugin .venv, python3, /usr/bin/python3, python)",
  );
}

function runPy(script: string, stdin: string): { exitCode: number; stdout: string } {
  const r = Bun.spawnSync([python, "-c", script], { stdin: Buffer.from(stdin) });
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
}

function pyTyped(text: string): { ok: boolean; data?: unknown; error?: string } {
  return JSON.parse(runPy(PY_TYPED, text).stdout);
}

// ---------------------------------------------------------------------------
// Tagging Bun values into the same {t, v} shape as PY_TYPED
// ---------------------------------------------------------------------------

function tagBun(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tagBun);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, tagBun(x)]),
    );
  }
  if (typeof v === "boolean") return { t: "bool", v };
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { t: "float", v: "nan" };
    if (v === Infinity) return { t: "float", v: "inf" };
    if (v === -Infinity) return { t: "float", v: "-inf" };
    return Number.isInteger(v) ? { t: "int", v } : { t: "float", v };
  }
  if (typeof v === "string") return { t: "str", v };
  if (v === null) return { t: "null", v: null };
  throw new Error(`unexpected Bun.YAML value of type ${typeof v}`);
}

type Path = (string | number)[];

function getPath(obj: unknown, path: Path): unknown {
  let cur: unknown = obj;
  for (const seg of path) cur = (cur as Record<string | number, unknown>)[seg];
  return cur;
}

/** Remove the scalar at `path` (last segment must be an object key or array index whose parent is an object). */
function deletePath(obj: unknown, path: Path): void {
  const parent = getPath(obj, path.slice(0, -1)) as Record<string | number, unknown>;
  delete parent[path[path.length - 1]!];
}

// ---------------------------------------------------------------------------
// Known divergences — the parity contract.
// Category legend:
//   "type-coercion" — YAML 1.1 (PyYAML) coerces the scalar, 1.2 (Bun) does not
//                     (or coerces differently). No data loss; a port must
//                     normalize (or accept the documented 1.2 reading).
// Hard incompatibilities (category iii) found: NONE — anchors, aliases, merge
// keys, block scalars, unicode, empty values all behave identically. The two
// document-level behavioral differences (multi-doc, invalid timestamp) are
// covered by dedicated tests below.
// ---------------------------------------------------------------------------

interface DivergenceCase {
  path: Path;
  /** PyYAML's reading: type tag + value (datetimes/dates as isoformat). */
  py: { t: string; v: unknown };
  /** Bun.YAML's reading (raw JS value). */
  bun: unknown;
}

const KNOWN_PARSE_DIVERGENCES: Record<string, DivergenceCase[]> = {
  // YAML 1.1 bool words. Real HA exposure: `state: on`, `to: off` in automations.
  "adversarial-bools-yaml11.yaml": [
    { path: ["yes_plain"], py: { t: "bool", v: true }, bun: "yes" },
    { path: ["no_plain"], py: { t: "bool", v: false }, bun: "no" },
    { path: ["on_plain"], py: { t: "bool", v: true }, bun: "on" },
    { path: ["off_plain"], py: { t: "bool", v: false }, bun: "off" },
    { path: ["yes_title"], py: { t: "bool", v: true }, bun: "Yes" },
    { path: ["no_upper"], py: { t: "bool", v: false }, bun: "NO" },
  ],
  // ISO timestamps. Real exposure: unquoted `created:` in markdown frontmatter
  // (docs/knowledge-schema.md convention), parsed by markdown.py.
  "adversarial-timestamps.yaml": [
    { path: ["date_plain"], py: { t: "date", v: "2024-01-01" }, bun: "2024-01-01" },
    { path: ["datetime_utc"], py: { t: "datetime", v: "2024-01-01T10:00:00+00:00" }, bun: "2024-01-01T10:00:00Z" },
    { path: ["datetime_offset"], py: { t: "datetime", v: "2026-04-24T09:00:00+00:00" }, bun: "2026-04-24T09:00:00+00:00" },
    { path: ["datetime_space"], py: { t: "datetime", v: "2024-01-01T10:00:00" }, bun: "2024-01-01 10:00:00" },
  ],
  "adversarial-frontmatter-timestamps.yaml": [
    { path: ["created"], py: { t: "datetime", v: "2026-06-11T08:30:00+00:00" }, bun: "2026-06-11T08:30:00+00:00" },
  ],
  // Sexagesimal ints (YAML 1.1 only). Real HA exposure: `at: 7:15` time
  // triggers. Leading-zero forms (07:15:00, 00:00:01) do NOT diverge.
  "adversarial-sexagesimal.yaml": [
    { path: ["hhmm"], py: { t: "int", v: 630 }, bun: "10:30" },
    { path: ["hms"], py: { t: "int", v: 3723 }, bun: "1:02:03" },
    { path: ["negative"], py: { t: "int", v: -630 }, bun: "-10:30" },
    { path: ["big"], py: { t: "int", v: 685230 }, bun: "190:20:30" },
  ],
  // Number formats: 1.1 legacy octal (0777), 1.2 modern octal (0o777),
  // 1.1 underscored ints (1_000), bare-exponent floats (1e3).
  "adversarial-numbers.yaml": [
    { path: ["octal_legacy"], py: { t: "int", v: 511 }, bun: 777 },
    { path: ["octal_legacy_small"], py: { t: "int", v: 24 }, bun: 30 },
    { path: ["octal_modern"], py: { t: "str", v: "0o777" }, bun: 511 },
    { path: ["underscore_int"], py: { t: "int", v: 1000 }, bun: "1_000" },
    { path: ["big_e"], py: { t: "str", v: "1e3" }, bun: 1000 },
  ],
  "adversarial-ha-automation.yaml": [
    { path: ["triggers", 0, "at"], py: { t: "int", v: 435 }, bun: "7:15" },
    { path: ["triggers", 2, "to"], py: { t: "bool", v: true }, bun: "on" },
  ],
};

// Gate (c): PyYAML's reading of Bun's dump, where it differs from Bun's value.
// Root cause: Bun.YAML.stringify does NOT quote strings that PyYAML 1.1
// re-coerces — sexagesimals, ISO dates/datetimes, underscored ints. (It DOES
// quote 1.2-coercible strings, bool words, and leading-zero numerics.)
// It also strips source quoting: a quoted "10:30" or "2024-01-01" in the
// input is re-emitted unquoted.
// Gate (c) relies on Bun.YAML.stringify quoting YAML-1.1 bool words (yes/no/on/off and case
// variants) when they appear as string values; files with no entry here are correct-by-quoting.
// A Bun version that stops quoting these words fails the remainder deep-equal for
// adversarial-bools-yaml11.yaml — that is the (intentionally implicit) pin.
const KNOWN_DUMP_DIVERGENCES: Record<string, DivergenceCase[]> = {
  "adversarial-sexagesimal.yaml": [
    { path: ["hhmm"], py: { t: "int", v: 630 }, bun: "10:30" },
    { path: ["hms"], py: { t: "int", v: 3723 }, bun: "1:02:03" },
    { path: ["big"], py: { t: "int", v: 685230 }, bun: "190:20:30" },
    // quoted in the source — Bun parses "10:30" (string), dumps it UNQUOTED,
    // PyYAML reads 630. The port must re-quote time-like strings on dump.
    { path: ["quoted"], py: { t: "int", v: 630 }, bun: "10:30" },
    // note: "-10:30" survives — Bun quotes leading-dash strings.
  ],
  "adversarial-timestamps.yaml": [
    { path: ["date_plain"], py: { t: "date", v: "2024-01-01" }, bun: "2024-01-01" },
    { path: ["datetime_utc"], py: { t: "datetime", v: "2024-01-01T10:00:00+00:00" }, bun: "2024-01-01T10:00:00Z" },
    { path: ["datetime_offset"], py: { t: "datetime", v: "2026-04-24T09:00:00+00:00" }, bun: "2026-04-24T09:00:00+00:00" },
    { path: ["datetime_space"], py: { t: "datetime", v: "2024-01-01T10:00:00" }, bun: "2024-01-01 10:00:00" },
    // quoted in the source, unquoted in Bun's dump:
    { path: ["date_quoted"], py: { t: "date", v: "2024-01-01" }, bun: "2024-01-01" },
    { path: ["datetime_quoted"], py: { t: "datetime", v: "2024-01-01T10:00:00+00:00" }, bun: "2024-01-01T10:00:00Z" },
  ],
  "adversarial-frontmatter-timestamps.yaml": [
    { path: ["created"], py: { t: "datetime", v: "2026-06-11T08:30:00+00:00" }, bun: "2026-06-11T08:30:00+00:00" },
  ],
  "adversarial-numbers.yaml": [
    { path: ["underscore_int"], py: { t: "int", v: 1000 }, bun: "1_000" },
  ],
  "adversarial-ha-automation.yaml": [
    { path: ["triggers", 0, "at"], py: { t: "int", v: 435 }, bun: "7:15" },
    // triggers[2].to ("on") does NOT diverge on dump: Bun quotes it.
  ],
};

// Files where document-level behavior differs (dedicated tests below).
const SPECIAL_FILES = new Set(["adversarial-multidoc.yaml", "adversarial-invalid-timestamp.yaml"]);

// ---------------------------------------------------------------------------

const corpusFiles = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .sort();

beforeAll(() => {
  python = resolvePython();
});

test("corpus is present", () => {
  expect(corpusFiles.length).toBeGreaterThanOrEqual(24);
  for (const f of Object.keys(KNOWN_PARSE_DIVERGENCES)) expect(corpusFiles).toContain(f);
  for (const f of Object.keys(KNOWN_DUMP_DIVERGENCES)) expect(corpusFiles).toContain(f);
});

/**
 * Assert each known divergence exactly (both sides), then delete those paths
 * from both tagged trees and require the remainder to be deep-equal.
 */
function compareWithKnownDivergences(
  pyTagged: unknown,
  bunParsed: unknown,
  cases: DivergenceCase[],
): void {
  const bunTagged = tagBun(bunParsed);
  for (const c of cases) {
    expect(getPath(pyTagged, c.path)).toEqual(c.py);
    expect(getPath(bunParsed, c.path)).toEqual(c.bun as never);
    deletePath(pyTagged, c.path);
    deletePath(bunTagged, c.path);
  }
  expect(bunTagged).toEqual(pyTagged as never);
}

for (const file of corpusFiles) {
  if (SPECIAL_FILES.has(file)) continue;
  const text = readFileSync(join(CORPUS_DIR, file), "utf8");
  const parseCases = KNOWN_PARSE_DIVERGENCES[file] ?? [];
  const dumpCases = KNOWN_DUMP_DIVERGENCES[file] ?? [];

  describe(file, () => {
    test("(a) parse equivalence vs yaml.safe_load (type-tagged)", () => {
      const py = pyTyped(text);
      expect(py.ok).toBe(true);
      compareWithKnownDivergences(py.data, Bun.YAML.parse(text), parseCases);
    });

    if (parseCases.length === 0 && !text.includes(".nan") && !text.includes(".inf")) {
      // The prompt-prescribed JSON-normalized comparison. Only meaningful for
      // files with no type divergences (default=str hides types) and no
      // non-finite floats (python json.dumps emits invalid bare NaN/Infinity).
      test("(a') parse equivalence, JSON-normalized (default=str)", () => {
        const r = runPy(PY_PLAIN, text);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(JSON.stringify(Bun.YAML.parse(text)))).toEqual(JSON.parse(r.stdout));
      });
    }

    test("(b) round-trip stability within Bun.YAML", () => {
      const parsed = Bun.YAML.parse(text);
      const block = Bun.YAML.parse(Bun.YAML.stringify(parsed, null, 2));
      const flow = Bun.YAML.parse(Bun.YAML.stringify(parsed));
      expect(block as never).toEqual(parsed as never);
      expect(flow as never).toEqual(parsed as never);
    });

    test("(c) dump compat: Python reads Bun's dump identically", () => {
      const parsed = Bun.YAML.parse(text);
      const dumped = Bun.YAML.stringify(parsed, null, 2);
      const py = pyTyped(dumped);
      expect(py.ok).toBe(true);
      compareWithKnownDivergences(py.data, parsed, dumpCases);
    });
  });
}

// ---------------------------------------------------------------------------
// Document-level behavioral divergences
// ---------------------------------------------------------------------------

describe("adversarial-multidoc.yaml", () => {
  const text = readFileSync(join(CORPUS_DIR, "adversarial-multidoc.yaml"), "utf8");

  test("PyYAML safe_load rejects multi-document streams (ComposerError)", () => {
    const py = pyTyped(text);
    expect(py).toEqual({ ok: false, error: "ComposerError" });
  });

  test("Bun.YAML.parse returns an array of documents matching safe_load_all", () => {
    const bun = Bun.YAML.parse(text);
    expect(bun as never).toEqual([
      { alias: "First", trigger: [] },
      { alias: "Second", trigger: [] },
    ] as never);
    const r = runPy(PY_MULTIDOC, text);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(JSON.stringify(bun))).toEqual(JSON.parse(r.stdout));
    // Port requirement: the Python code paths use safe_load (single doc), so a
    // multi-doc artifact is INVALID input today. A Bun port must reject
    // array-of-docs results (or pre-scan for "---") to preserve behavior.
  });
});

describe("adversarial-invalid-timestamp.yaml", () => {
  const text = readFileSync(join(CORPUS_DIR, "adversarial-invalid-timestamp.yaml"), "utf8");

  test("PyYAML rejects timestamp-shaped-but-invalid scalars (ValueError); Bun returns the string", () => {
    const py = pyTyped(text);
    expect(py).toEqual({ ok: false, error: "ValueError" });
    expect(Bun.YAML.parse(text) as never).toEqual({ not_a_date: "2024-13-45" } as never);
  });
});

// ---------------------------------------------------------------------------
// Methodology check: default=str HIDES the date type divergence
// ---------------------------------------------------------------------------

test("json.dumps(default=str) hides the date coercion divergence — typed comparison is required", () => {
  const text = "date_plain: 2024-01-01\n";
  // Plain JSON-normalized comparison says "equal"...
  const plain = runPy(PY_PLAIN, text);
  expect(plain.exitCode).toBe(0);
  expect(JSON.parse(plain.stdout)).toEqual({ date_plain: "2024-01-01" });
  expect(JSON.parse(JSON.stringify(Bun.YAML.parse(text)))).toEqual(JSON.parse(plain.stdout));
  // ...but Python actually produced datetime.date, not str.
  const typed = pyTyped(text);
  expect(typed.data as never).toEqual({ date_plain: { t: "date", v: "2024-01-01" } } as never);
  expect(Bun.YAML.parse(text) as never).toEqual({ date_plain: "2024-01-01" } as never);
});
