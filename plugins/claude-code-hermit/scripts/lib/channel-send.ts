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

import { resolve as resolveOutboundChannel } from '../resolve-outbound-channel';
import { logMessage, isLoggingEnabled } from './channel-log';
import { loadConfig } from './channel-auth';
import { readChannelToken } from './channel-token';
import { recordChannelHealth } from './channel-health';

type Json = any;

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Where and how to send. `target` overrides outbound resolution (used to reply
 * to the chat a message arrived on); `timeoutMs` bounds the HTTP round-trip. */
export interface SendOptions {
  target?: { id: string; chat_id: string };
  timeoutMs?: number;
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
    const config = loadConfig(hermitDir);
    if (!config) return { ok: false, error: 'config_read_failed' };

    const target = opts.target ?? resolveOutboundChannel(config.channels);
    if (!target) return { ok: false, error: 'no_reachable_channel' };
    const { id: channelId, chat_id: chatId } = target;

    const send = SENDERS[channelId];
    if (!send) return { ok: false, error: 'unsupported_platform' };

    const token = readChannelToken(hermitDir, channelId, config.channels?.[channelId] || {});
    if (!token) return { ok: false, error: 'missing_token' };

    const result = await send(token, chatId, text, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    // Record reachability for ask-gate's redirect-target check (advisory, never throws).
    recordChannelHealth(hermitDir, channelId, result.ok);
    if (!result.ok) return result;

    if (isLoggingEnabled(config)) {
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
