import fs from 'node:fs';
import path from 'node:path';

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
const MAX_STDIN = 64 * 1024;

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
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if ((c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      out.push(buf); buf = ''; i++; continue;
    }
    if (c === ';' || c === '|') { out.push(buf); buf = ''; continue; }
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

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN) process.exit(0);
  });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(raw);
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

      const isAlwaysOn = process.env.AGENT_HOOK_PROFILE === 'strict';
      const allPatterns = [
        ...(patterns.default || []),
        ...(isAlwaysOn ? (patterns.always_on || []) : []),
      ];

      for (const pattern of allPatterns) {
        if (matchesPattern(toolCall, pattern)) {
          process.stderr.write(`BLOCKED by deny-patterns: ${pattern}\n`);
          process.exit(2);
        }
      }
    } catch (e) {
      // Silently allow on parse errors
    }
  });
}

main();
