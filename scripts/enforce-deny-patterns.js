'use strict';

const fs = require('fs');
const path = require('path');

/**
 * PreToolUse hook — enforces deny-patterns.json, blocks OPERATOR.md edits,
 * and warns on state-template edits. Consolidates all PreToolUse checks
 * into a single Node process to avoid spawning multiple bash pipelines.
 *
 * Pattern format in deny-patterns.json: "ToolName(glob)" where glob uses * as wildcard.
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

      // --- Check 1: Block OPERATOR.md edits ---
      if ((toolCall.tool === 'Edit' || toolCall.tool === 'Write') &&
          toolCall.content.includes('OPERATOR.md')) {
        process.stderr.write('BLOCKED: OPERATOR.md is human-curated, read-only for agents\n');
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

      const allPatterns = [
        ...(patterns.default || []),
        ...(patterns.always_on || []),
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
