'use strict';

// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// UserPromptSubmit hook — injects per-prompt context so the model never anchors to stale state.

const fs = require('fs');
const path = require('path');

const AGENT_DIR = process.env.AGENT_DIR || '.claude-code-hermit';

// Drain stdin (fail-open contract — broken pipe if unread)
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});

function main() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.resolve(AGENT_DIR, 'config.json'), 'utf-8'));
  } catch {
    // No config or unreadable — use defaults
  }

  const tz = (typeof config.timezone === 'string' && config.timezone) ? config.timezone : 'UTC';

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
      hour12: false,
    });

    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    const formatted = `${parts.weekday}, ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
    process.stdout.write(`[Now: ${formatted}]\n`);
  } catch {
    // Invalid TZ or Intl unavailable — emit nothing; CC's currentDate remains
  }
}

try {
  main();
} catch {
  // Fail open — never block a prompt
}
process.exit(0);
