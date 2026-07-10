import fs from 'node:fs';
import path from 'node:path';
import { readHookInput, isStrictProfile } from './lib/hook-input';

type Json = any;

/**
 * PreToolUse hook — enforces deny-patterns.json and warns on state-template edits.
 *
 * Deny patterns: "ToolName(glob)" where glob uses * as wildcard.
 * "default" patterns always apply. "always_on" patterns apply only when
 * AGENT_HOOK_PROFILE=strict (set by hermit-start in Docker/tmux).
 * OPERATOR.md Edit/Write is in the always_on set — blocked in always-on mode,
 * allowed in interactive sessions (behavioral rule + permission prompt is the gate).
 * Exit 2 = block the tool call.
 */

const DENY_FILE = path.join(
  process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..'),
  'state-templates',
  'deny-patterns.json'
);

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(toolCall: { tool: string; candidates: string[] }, pattern: string): boolean {
  const m = pattern.match(/^(\w+)\((.+)\)$/);
  if (!m) return false;

  const [, patternTool, patternGlob] = m;
  if (toolCall.tool !== patternTool) return false;

  const rx = globToRegex(patternGlob);
  return toolCall.candidates.some(c => rx.test(c));
}

// Split a command into compound segments on &&, ||, ;, and | — but only when
// the separator sits OUTSIDE single/double quotes. A separator inside a quoted
// string (e.g. `echo "step 1; rm -rf build"`) must not fragment the command,
// or the trailing fragment would spuriously match a leading-anchored deny glob.
function splitSegments(command: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    // Backslash escapes the next char outside single quotes (bash processes no
    // escapes inside single quotes), so an escaped quote (`\'`) can't spuriously
    // open a quoted run and swallow a following separator.
    if (c === '\\' && quote !== "'" && i + 1 < command.length) {
      buf += c + command[i + 1]; i++; continue;
    }
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if ((c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      out.push(buf); buf = ''; i++; continue;
    }
    // Newline separates commands like `;`. (Single `&` is intentionally not a
    // separator here — splitting it would fragment redirects like `2>&1`/`&>`.)
    if (c === ';' || c === '|' || c === '\n') { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}

function buildToolCall(event: Json): { tool: string; content: string; candidates: string[] } {
  const name = event.tool_name || '';
  const input = event.tool_input || {};

  if (name === 'Bash') {
    const command = input.command || '';
    // Match the whole command AND each compound segment, so a deny pattern
    // anchored to a leading command (e.g. `Bash(rm -rf *)`) still fires inside
    // `cd /tmp && rm -rf x`. Splitting is quote-aware (see splitSegments) so a
    // separator inside a quoted string does not fragment the command. Dedup —
    // a non-compound command otherwise appears twice (whole + its one segment).
    const segments = splitSegments(command).map((s: string) => s.trim());
    const candidates = [...new Set([command, ...segments])].filter(Boolean);
    return { tool: 'Bash', content: command, candidates };
  }
  if (name === 'Edit' || name === 'Write') {
    // File paths are never segmented — a `|` in a filename must not fragment it.
    const content = input.file_path || input.path || '';
    return { tool: name, content, candidates: [content] };
  }
  return { tool: name, content: '', candidates: [] };
}

async function run() {
  const event = await readHookInput();
  if (!event) process.exit(0);

  const toolCall = buildToolCall(event);

  // --- Check 1: Warn on state-template edits ---
  if ((toolCall.tool === 'Edit' || toolCall.tool === 'Write') &&
      /state-templates\/.*\.template/.test(toolCall.content)) {
    process.stderr.write('Editing template file — confirm this is intentional\n');
  }

  // --- Check 2: Deny patterns ---
  if (!toolCall.content) process.exit(0);

  let patterns: Json;
  try {
    patterns = JSON.parse(fs.readFileSync(DENY_FILE, 'utf8'));
  } catch {
    process.exit(0); // Missing or invalid deny file — allow
  }

  const allPatterns = [
    ...(patterns.default || []),
    ...(isStrictProfile() ? (patterns.always_on || []) : []),
  ];

  for (const pattern of allPatterns) {
    if (matchesPattern(toolCall, pattern)) {
      process.stderr.write(`BLOCKED by deny-patterns: ${pattern}\n`);
      process.exit(2);
    }
  }
}

async function main() {
  try {
    await run();
  } catch {
    // Silently allow on unexpected errors
  }
}

main();
