'use strict';

const fs = require('fs');
const path = require('path');

/**
 * PreToolUse hook — blocks OPERATOR.md edits, enforces deny-patterns.json,
 * and warns on state-template edits.
 *
 * OPERATOR.md: always blocked if the file already exists (allows creation during hatch).
 * Deny patterns: "ToolName(glob)" where glob uses * as wildcard.
 * "default" patterns always apply. "always_on" patterns apply only when
 * AGENT_HOOK_PROFILE=strict (set by hermit-start in Docker/tmux).
 * Exit 2 = block the tool call.
 */

const DENY_FILE = path.join(
  process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..'),
  'state-templates',
  'deny-patterns.json'
);
const MAX_STDIN = 64 * 1024;

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(toolCall, pattern) {
  const m = pattern.match(/^(\w+)\((.+)\)$/);
  if (!m) return false;

  const [, patternTool, patternGlob] = m;
  if (toolCall.tool !== patternTool) return false;

  return globToRegex(patternGlob).test(toolCall.content);
}

function buildToolCall(event) {
  const name = event.tool_name || '';
  const input = event.tool_input || {};

  if (name === 'Bash') {
    return { tool: 'Bash', content: input.command || '' };
  }
  if (name === 'Edit' || name === 'Write') {
    return { tool: name, content: input.file_path || input.path || '' };
  }
  return { tool: name, content: '' };
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

      // --- Check 1: Block OPERATOR.md edits (allow creation during hatch) ---
      if ((toolCall.tool === 'Edit' || toolCall.tool === 'Write') &&
          toolCall.content.includes('.claude-code-hermit/OPERATOR.md') &&
          fs.existsSync(toolCall.content)) {
        process.stderr.write('BLOCKED: OPERATOR.md is operator-curated — edit it directly, not through the agent\n');
        process.exit(2);
      }

      // --- Check 2: Warn on state-template edits ---
      if ((toolCall.tool === 'Edit' || toolCall.tool === 'Write') &&
          /state-templates\/.*\.template/.test(toolCall.content)) {
        process.stderr.write('Editing template file — confirm this is intentional\n');
      }

      // --- Check 3: Deny patterns ---
      if (!toolCall.content) process.exit(0);

      let patterns;
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
