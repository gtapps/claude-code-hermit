// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// PreToolUse hook (matcher "*", every tool) — the binding pause/stop/resume
// gate (PROP-015). Probe-verified (compiled/spike-channel-stop-probe-2026-07-03.md):
// a PreToolUse exit-2 deny is binding within one tool call with zero model
// cooperation. While state/pause.json says paused, every tool call is denied
// except the two shapes a paused hermit still needs to report its own status
// from a phone: any channel plugin's `reply` tool, and PushNotification. Pause
// stops actions, not communication.
//
// Fail-open: any error here (bad stdin, missing/corrupt flag) resolves to
// exit 0 (allow) — a hook must never block Claude Code, and a pause gate that
// fails closed would brick the hermit with no recovery but manual file surgery.

import { hermitDir } from './lib/cc-compat';
import { isPaused } from './lib/pause';
import { runHook } from './lib/hook-input';

// Channel reply tools surface in several shapes across CC versions —
// mcp__discord__reply, plugin_discord_discord_reply, mcp__plugin_discord_discord__reply
// (see channel-hook.ts and the loose hooks.json PostToolUse matcher
// "(discord|telegram|imessage).*reply"). Match all of them, not just one strict
// form: a stricter regex would deny the reply tool in an alternate shape and
// trap a paused hermit with no way to acknowledge the pause.
const REPLY_TOOL_RE = /(discord|telegram|imessage).*reply$/i;

function isExempt(toolName: string): boolean {
  return toolName === 'PushNotification' || REPLY_TOOL_RE.test(toolName);
}

function main(payload: any): void {
  const toolName = payload && typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (!toolName || isExempt(toolName)) return; // allow

  const status = isPaused(hermitDir());
  if (!status.paused) return; // allow

  const untilPhrase = status.until ? `until ${status.until}` : 'until resumed by operator';
  process.stderr.write(`Hermit is paused (${status.reason ?? 'operator'}, ${untilPhrase})\n`);
  process.exit(2);
}

runHook(main);
