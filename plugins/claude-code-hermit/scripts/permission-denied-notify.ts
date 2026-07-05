// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// PermissionDenied hook (matcher "*") — fires after Claude Code's own auto-mode
// classifier (or the permissions system) has already denied a tool call. This
// hook cannot block and cannot retry the call — it only makes an otherwise
// silent denial visible to the operator on the managed unattended session,
// per CLAUDE-APPEND.md's "Auto-mode denial alert" rule (deterministic
// counterpart to that model-level instruction).
//
// Gating mirrors ask-gate.ts: only the managed unattended session
// (HERMIT_MANAGED, stamped into the tmux env-file by hermit-start) with
// always_on config and a reachable channel gets notified — an attended
// session sees the denial natively in its own transcript.
//
// Fail-open and side-effect-only: every path exits 0. The harness ignores
// this hook's stdout/stderr and its exit code; it never emits
// hookSpecificOutput.retry (auto-retrying a classifier denial is exactly the
// bypass the security model forbids).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hermitDir } from './lib/cc-compat';
import { loadConfig } from './lib/channel-auth';
import { channelLikelyDown } from './lib/channel-health';
import { resolve as resolveOutboundChannel } from './resolve-outbound-channel';
import { sendToChannel } from './lib/channel-send';
import { readAlertState, writeAlertState } from './lib/alert-state';
import { safe } from './lib/sanitize';
import { localISOStamp } from './lib/time';

type Json = any;

const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DETAIL_MAX_LEN = 150;
const MESSAGE_MAX_LEN = 300;

function alertsPath(dir: string): string {
  return path.join(dir, 'state', 'permission-denied-alerts.json');
}

// Reuse lib/alert-state.ts's atomic read/write — the same single-writer
// alert-file pattern cost-tracker.ts and report-export.ts already use for
// budget-alerts.json / telemetry-alert.json, instead of a hand-rolled
// tmp+rename write. This file's shape is a flat hash->timestamp map, so only
// the generic readAlertState/writeAlertState pair applies (not
// mutateOwnedAlerts/readMergedAlerts, which assume the `{alerts: {...}}` shape).
function readAlerts(dir: string): Record<string, string> {
  const read = readAlertState(alertsPath(dir));
  return read.kind === 'ok' ? (read.value as Record<string, string>) : {};
}

function writeAlerts(dir: string, alerts: Record<string, string>): void {
  fs.mkdirSync(path.dirname(alertsPath(dir)), { recursive: true });
  writeAlertState(alertsPath(dir), alerts);
}

function dedupKey(toolName: string, toolInput: Json): string {
  return createHash('sha256').update(`${toolName}:${JSON.stringify(toolInput ?? {})}`).digest('hex');
}

function extractDetail(toolInput: Json): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const value = toolInput.command ?? toolInput.file_path ?? Object.values(toolInput)[0] ?? '';
  return safe(value).slice(0, DETAIL_MAX_LEN);
}

async function main(raw: string): Promise<void> {
  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed stdin
  }
  if (!payload || typeof payload !== 'object') return;

  if (process.env.HERMIT_DENY_NOTIFY === 'off') return; // explicit per-session escape hatch
  if (process.env.HERMIT_MANAGED !== '1') return; // attended session sees the denial natively

  const dir = hermitDir();
  const config = loadConfig(dir);
  if (!config || typeof config !== 'object') return; // fail-open
  if (config.always_on !== true) return;

  const target = resolveOutboundChannel(config.channels);
  if (!target) return; // nowhere to send

  if (channelLikelyDown(dir, target.id)) return; // don't fire into a dead channel

  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown_tool';
  const toolInput = payload.tool_input;
  const reason = typeof payload.reason === 'string' ? safe(payload.reason).slice(0, DETAIL_MAX_LEN) : '';

  const key = dedupKey(toolName, toolInput);
  const now = Date.now();
  const alerts = readAlerts(dir);

  const last = alerts[key] ? Date.parse(alerts[key]) : NaN;
  if (!Number.isNaN(last) && now - last < DEDUP_WINDOW_MS) return; // recent duplicate — suppress

  // Prune stale entries before writing.
  for (const [k, ts] of Object.entries(alerts)) {
    const t = Date.parse(ts);
    if (Number.isNaN(t) || now - t > PRUNE_AGE_MS) delete alerts[k];
  }
  alerts[key] = localISOStamp();
  writeAlerts(dir, alerts);

  const detail = extractDetail(toolInput);
  let text = `Auto-mode denied: ${toolName}`;
  if (detail) text += ` — ${detail}`;
  if (reason) text += ` — ${reason}`;
  text += '. Session continues. If intended: /hermit-settings or handle at the pane.';
  text = text.slice(0, MESSAGE_MAX_LEN);

  await sendToChannel(dir, text, { target });
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    main(buf)
      .catch(() => {})
      .finally(() => process.exit(0));
  });
} catch {
  process.exit(0);
}
