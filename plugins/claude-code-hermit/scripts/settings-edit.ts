/**
 * settings-edit.ts — read-modify-write helper for .claude-code-hermit/config.json scalar/enum edits.
 *
 * Usage: bun settings-edit.ts <config-file> <op> [args...]
 *
 * Operations:
 *   get [dotted.path]        Print the JSON value at path (whole config if path omitted)
 *   set <dotted.path> <val>  Set a nested leaf, creating parent objects as needed
 *   toggle <dotted.path>     Boolean flip (absent → true; errors if current isn't boolean)
 *
 * Value parsing for `set`: 'none'/'clear' → null; otherwise JSON.parse first
 * (so true, 42, "x", {...} work), falling back to the raw string on parse failure.
 *
 * Rules:
 * - Changes only the target leaf; all sibling keys are preserved (read-modify-write).
 * - Refuses to overwrite an existing-but-malformed config.json (never falls through to {}).
 * - Safe under AGENT_HOOK_PROFILE=strict: writes via fs, not the Edit/Write tools.
 * - Zero runtime deps.
 */

import fs from 'node:fs';
import path from 'node:path';

type Json = any;

// Strict read: an existing-but-malformed file must abort, never fall through to {},
// otherwise the write below would clobber the operator's config with our subset.
function readTargetJson(filePath: string): Json {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(
      `Refusing to overwrite ${filePath}: file exists but is not valid JSON ` +
        `(${(err as Error).message}). Fix or remove it, then re-run.`,
    );
    process.exit(1);
  }
}

function writeJson(filePath: string, data: Json): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: a torn config.json would make readTargetJson (strict) exit(1)
  // on every later run, locking the operator out of config edits.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseValue(raw: string): Json {
  if (raw === 'none' || raw === 'clear') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// --- Pure path helpers (exported for unit tests) ---

export function getPath(obj: Json, dotted?: string): Json {
  if (!dotted) return obj;
  let cur = obj;
  for (const key of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function setPath(obj: Json, dotted: string, value: Json): Json {
  const keys = dotted.split('.');
  const leaf = keys.pop()!;
  let cur = obj;
  for (const key of keys) {
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[leaf] = value;
  return obj;
}

export function togglePath(obj: Json, dotted: string): Json {
  const current = getPath(obj, dotted);
  if (current !== undefined && typeof current !== 'boolean') {
    throw new Error(`toggle: value at '${dotted}' is not a boolean (got ${JSON.stringify(current)})`);
  }
  return setPath(obj, dotted, current === undefined ? true : !current);
}

// --- CLI dispatch ---

if (import.meta.main) {
  const [, , targetFile, op, ...rest] = process.argv;

  if (!targetFile || !op) {
    console.error('Usage: settings-edit.ts <config-file> <op> [args...]');
    process.exit(1);
  }

  const config = readTargetJson(targetFile);

  switch (op) {
    case 'get': {
      const value = getPath(config, rest[0]);
      console.log(JSON.stringify(value, null, 2));
      break;
    }

    case 'set': {
      const dotted = rest[0];
      if (!dotted) { console.error('set requires a dotted.path argument'); process.exit(1); }
      if (rest.length < 2) { console.error('set requires a value argument'); process.exit(1); }
      setPath(config, dotted, parseValue(rest[1]));
      writeJson(targetFile, config);
      break;
    }

    case 'toggle': {
      const dotted = rest[0];
      if (!dotted) { console.error('toggle requires a dotted.path argument'); process.exit(1); }
      try {
        togglePath(config, dotted);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      writeJson(targetFile, config);
      break;
    }

    default: {
      console.error(`Unknown operation: ${op}. Valid ops: get, set, toggle`);
      process.exit(1);
    }
  }
}
