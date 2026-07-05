// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// PreToolUse hook (matcher "AskUserQuestion") — binds the last unbound
// synchronous-ask path on unattended sessions. PROP-017 covers hermit-owned
// skills cooperatively (Step-0 marker + static contract test); this gate
// binds everything else — built-ins, other plugins' skills, spontaneous
// model-initiated questions — the caller surface that grows with every
// plugin the operator installs.
//
// Deny mechanics mirror pause-gate.ts: probe-verified
// (compiled/spike-channel-stop-probe-2026-07-03.md) that a PreToolUse exit-2
// deny is binding within one tool call with zero model cooperation. The
// deny-steering behavior specific to this gate — does the model retry the
// tool or follow the reason into an alternate action — is probe-verified in
// compiled/spike-ask-gate-probe-2026-07-05.md: it does not retry.
//
// Only denies when there's actually somewhere for the question to go:
// always_on AND an eligible outbound channel AND the operator hasn't opted
// out via ask_gate:false. A terminal operator (always_on:false) is never
// touched, even with channels configured — and a deny with no eligible
// channel would strand the question with no redirect target at all.
//
// Fail-open: any error here (bad stdin, missing/corrupt config) resolves to
// exit 0 (allow) — a hook must never block Claude Code.

import { hermitDir } from './lib/cc-compat';
import { loadConfig } from './lib/channel-auth';
import { resolve as resolveOutboundChannel } from './resolve-outbound-channel';

const REDIRECT_REASON =
  'No interactive operator on this surface (always-on channel session). Do not retry ' +
  'AskUserQuestion. Instead: (1) send the question via the channel reply tool; (2) append ' +
  'a pending entry to .claude-code-hermit/state/micro-proposals.json (id: MP-YYYYMMDD-N, ' +
  'tier: 1, status: "pending", follow_up_count: 0, ts, question, and options[] for multiple ' +
  'choice) so the answer survives restart; (3) continue other work — the answer arrives as a ' +
  'channel message.';

function main(raw: string): void {
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed stdin — allow
  }

  const toolName = payload && typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (toolName !== 'AskUserQuestion') return; // allow (defensive; matcher already scopes)

  const dir = hermitDir();
  const config = loadConfig(dir);
  if (!config || typeof config !== 'object') return; // allow, fail-open

  if (config.always_on !== true) return; // interactive/terminal session — untouched
  if (config.ask_gate === false) return; // explicit escape hatch

  const target = resolveOutboundChannel(config.channels);
  if (!target) return; // no redirect target — denying would strand the question

  process.stderr.write(`${REDIRECT_REASON}\n`);
  process.exit(2);
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try { main(buf); } catch { /* fail-open */ }
    process.exit(0);
  });
} catch {
  process.exit(0);
}
