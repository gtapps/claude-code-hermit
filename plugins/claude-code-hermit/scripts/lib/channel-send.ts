// channel-send.ts — the first script-owned (non-model) channel send.
//
// Resolves the eligible outbound channel (resolve-outbound-channel.ts's
// {id, chat_id}), reads the bot token from that channel's state_dir/.env
// (nothing else in core reads these tokens today — the MCP channel plugins
// consume them directly from the process env), and POSTs directly to the
// platform API. Plain text only (no parse_mode/markdown — unescaped markdown
// 400s on Telegram). On a confirmed 2xx, appends an outbound row to the
// episodic channel log via lib/channel-log.ts so this new send path doesn't
// open a hole in episodic memory the way model-only outbound logging would.
//
// Never throws — every path returns a SendResult so callers (a fail-open
// hook, a single-shot watchdog tick, a fire-and-forget budget alert) can
// decide what "failed to notify the operator" means for them.

import path from 'node:path';
import { resolve as resolveOutboundChannel, resolveMaintainerTarget } from '../resolve-outbound-channel';
import { logMessage, isLoggingEnabled } from './channel-log';
import { loadConfig } from './channel-auth';
import { readChannelToken } from './channel-token';
import { recordChannelHealth } from './channel-health';
import { appendShellLine } from './md-write';

type Json = any;

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
  // Set by sendOperatorNotice on the maintainer leg: where the tiered
  // resolution actually landed. Absent on a plain sendToChannel call.
  route?: 'client' | 'maintainer_channel' | 'findings';
  // True only when route === 'findings' — the notice was written to SHELL.md
  // Findings instead of crossing a channel.
  suppressed?: boolean;
  // Set by sendOperatorNotice on the maintainer leg: did the notice reach its
  // intended destination — a live chat, OR the intended Findings home
  // (non-technical profile / fallback:'findings' with no maintainer channel)?
  // False when Findings was a *degraded* fallback (a maintainer channel is
  // configured but unreachable): the append succeeded (ok:true) but nobody live
  // saw it. Callers gating a "notified" flag must read `delivered`, not `ok`,
  // so a degraded write still leaves the heartbeat re-announce fallback armed.
  delivered?: boolean;
}

/** Where and how to send. `target` overrides outbound resolution (used to reply
 * to the chat a message arrived on); `timeoutMs` bounds the HTTP round-trip.
 * `sensitive` keeps the message out of the episodic channel log (auth prompts,
 * technical detail); `recordHealth: false` skips the platform health write (used
 * for maintainer-chat sends, whose failures must not mark the client route
 * down). */
export interface SendOptions {
  target?: { id: string; chat_id: string };
  timeoutMs?: number;
  sensitive?: boolean;
  recordHealth?: boolean;
  // An already-loaded config snapshot (sendOperatorNotice passes its own down to
  // each leg) so a multi-leg notice reads config.json once, not per send.
  config?: Json;
}

const REQUEST_TIMEOUT_MS = 10_000;
const TELEGRAM_MAX_LEN = 4096;
const DISCORD_MAX_LEN = 2000;

interface PlatformSendResult extends SendResult {
  sentText?: string;
}

/** Map a fetch rejection to a stable error string (timeouts read as 'request timeout'). */
function fetchError(e: any): string {
  return e?.name === 'TimeoutError' ? 'request timeout' : e?.message || String(e);
}

async function sendTelegram(token: string, chatId: string, text: string, timeoutMs: number): Promise<PlatformSendResult> {
  const base = process.env.HERMIT_TELEGRAM_API_URL || 'https://api.telegram.org';
  const sentText = text.slice(0, TELEGRAM_MAX_LEN);
  try {
    const resp = await fetch(`${base}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: sentText }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) return { ok: true, status: resp.status, sentText };
    let description: string | undefined;
    try { description = ((await resp.json()) as Json)?.description; } catch {}
    return { ok: false, status: resp.status, error: description || `telegram_http_${resp.status}` };
  } catch (e: any) {
    return { ok: false, error: fetchError(e) };
  }
}

async function sendDiscord(token: string, chatId: string, text: string, timeoutMs: number): Promise<PlatformSendResult> {
  const base = process.env.HERMIT_DISCORD_API_URL || 'https://discord.com/api/v10';
  const sentText = text.slice(0, DISCORD_MAX_LEN);
  try {
    const resp = await fetch(`${base}/channels/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
      body: JSON.stringify({ content: sentText }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) return { ok: true, status: resp.status, sentText };
    let message: string | undefined;
    try { message = ((await resp.json()) as Json)?.message; } catch {}
    return { ok: false, status: resp.status, error: message || `discord_http_${resp.status}` };
  } catch (e: any) {
    return { ok: false, error: fetchError(e) };
  }
}

const SENDERS: Record<string, (token: string, chatId: string, text: string, timeoutMs: number) => Promise<PlatformSendResult>> = {
  telegram: sendTelegram,
  discord: sendDiscord,
};

/**
 * POST `text` to a channel and log the send (direction:'out') on success. By
 * default resolves the eligible outbound channel (for unsolicited pushes);
 * pass `opts.target` to reply to a specific channel/chat (e.g. the one an
 * inbound message arrived on). Never throws.
 */
export async function sendToChannel(hermitDir: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
  try {
    const config = opts.config ?? loadConfig(hermitDir);
    if (!config) return { ok: false, error: 'config_read_failed' };

    const target = opts.target ?? resolveOutboundChannel(config.channels);
    if (!target) return { ok: false, error: 'no_reachable_channel' };
    const { id: channelId, chat_id: chatId } = target;

    const send = SENDERS[channelId];
    if (!send) return { ok: false, error: 'unsupported_platform' };

    const token = readChannelToken(hermitDir, channelId, config.channels?.[channelId] || {});
    if (!token) return { ok: false, error: 'missing_token' };

    const result = await send(token, chatId, text, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    // Record reachability for ask-gate's redirect-target check (advisory, never
    // throws). Skipped for maintainer-chat sends: a failure there must not flip
    // the platform-keyed health that ask-gate/permission-denied read for the
    // client route.
    if (opts.recordHealth !== false) recordChannelHealth(hermitDir, channelId, result.ok);
    if (!result.ok) return result;

    // Sensitive sends (auth prompts, technical maintainer detail) never enter the
    // episodic channel log — that corpus is searchable via recall and distilled
    // into weekly knowledge artifacts.
    if (!opts.sensitive && isLoggingEnabled(config)) {
      const logResult = logMessage(hermitDir, {
        source: channelId,
        chat_id: chatId,
        direction: 'out',
        text: result.sentText ?? text,
      });
      if (!logResult.ok) {
        process.stderr.write(`[channel-log] outbound capture failed: ${logResult.error}\n`);
      }
    }

    return { ok: true, status: result.status };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * A two-audience operator notice. `client` is plain, localized copy for the
 * primary chat; `maintainer` carries technical/spend/ops detail whose `fallback`
 * decides where it goes when no `maintainer_channel_id` is configured
 * (`'client'` = the primary chat, today's behavior; `'findings'` = suppressed to
 * SHELL.md, fail-closed on disclosure). `sensitive` keeps the maintainer text
 * out of the episodic channel log.
 */
export interface OperatorNotice {
  client?: string;
  maintainer?: { text: string; fallback: 'client' | 'findings'; sensitive?: boolean };
  timeoutMs?: number;
}

export interface OperatorNoticeResult {
  client?: SendResult;
  maintainer?: SendResult;
}

const FINDINGS_MAX = 300;

function appendMaintainerFindings(hermitDir: string, text: string): string | null {
  return appendShellLine(
    path.join(hermitDir, 'sessions'),
    'Findings',
    `- [maintainer alert suppressed] ${text.slice(0, FINDINGS_MAX)}`,
  );
}

/**
 * Deliver a two-audience notice, owning all audience policy so callers never
 * inspect routing: one config snapshot, client + maintainer target resolution,
 * physical-target dedup (same chat ⇒ maintainer text only), missing/failed
 * maintainer fallback, sensitive-log handling, and Findings append. Never throws.
 */
export async function sendOperatorNotice(hermitDir: string, notice: OperatorNotice): Promise<OperatorNoticeResult> {
  const out: OperatorNoticeResult = {};
  let config: Json = null;
  try { config = loadConfig(hermitDir); } catch { config = null; }
  const channels = config?.channels;
  const clientTarget = channels ? resolveOutboundChannel(channels) : null;
  const maintainerTarget = channels ? resolveMaintainerTarget(channels) : null;
  const nonTechnical = config?.operator_profile === 'non-technical';

  if (notice.maintainer) {
    const m = notice.maintainer;
    // `degraded` = Findings was a fallback because a configured maintainer
    // channel was unreachable (nobody live saw it), vs. Findings being the
    // intended home (non-technical / fallback:'findings'). Only the intended
    // case counts as delivered.
    const toFindings = (degraded: boolean): SendResult => {
      const err = appendMaintainerFindings(hermitDir, m.text);
      return err
        ? { ok: false, error: `findings_append_failed: ${err}`, route: 'findings', suppressed: true, delivered: false }
        : { ok: true, route: 'findings', suppressed: true, delivered: !degraded };
    };
    if (maintainerTarget) {
      const r = await sendToChannel(hermitDir, m.text, {
        target: maintainerTarget, sensitive: m.sensitive, recordHealth: false, timeoutMs: notice.timeoutMs, config,
      });
      // Configured but unreachable → Findings. Configured routing intent wins
      // over the fallback: a bad chat id must never spill technical/spend
      // detail into the client chat.
      out.maintainer = r.ok ? { ...r, route: 'maintainer_channel', delivered: true } : toFindings(true);
    } else if (m.fallback === 'findings' || nonTechnical) {
      out.maintainer = toFindings(false);
    } else {
      // fallback 'client' on a technical profile with no maintainer channel:
      // today's behavior — the message goes to the primary chat.
      const r = await sendToChannel(hermitDir, m.text, {
        target: clientTarget ?? undefined, timeoutMs: notice.timeoutMs, config,
      });
      out.maintainer = { ...r, route: 'client', delivered: r.ok };
    }
  }

  if (notice.client) {
    // Drop the client leg when the maintainer text already landed in the primary
    // chat — either via the 'client' fallback, or because maintainer_channel_id
    // resolves to the same physical chat as the client target.
    const landedInClientChat =
      out.maintainer?.route === 'client' ||
      (out.maintainer?.route === 'maintainer_channel' && !!maintainerTarget && !!clientTarget &&
        maintainerTarget.id === clientTarget.id &&
        String(maintainerTarget.chat_id) === String(clientTarget.chat_id));
    if (!landedInClientChat) {
      out.client = await sendToChannel(hermitDir, notice.client, {
        target: clientTarget ?? undefined, timeoutMs: notice.timeoutMs, config,
      });
    }
  }

  return out;
}
