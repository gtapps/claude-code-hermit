// Shared per-platform bot-identity probe — one token-authed GET that returns
// the bot's *own* account. Used by doctor-check.ts's liveness check (does the
// token still work?) and channel-bot-id.ts (what is this bot's id?), so the
// endpoints, the env overrides and the response shapes can't drift apart
// between them.
//
// Never log a probe URL or an error message from these fetches: Telegram
// embeds the bot token in the request path.

export type ChannelProbe = { url: string; headers?: Record<string, string> };

/** The bot's own account, as far as a platform will tell us. */
export type BotIdentity = { id: string | null; username: string | null };

/**
 * Platform → probe builder. The env overrides keep their original
 * `HERMIT_DOCTOR_*` names: they predate this lib and are what the doctor's
 * tests and any operator runbook already set.
 */
export const CHANNEL_PROBES: Record<string, (token: string) => ChannelProbe> = {
  telegram: (token) => ({
    url: `${process.env.HERMIT_DOCTOR_TELEGRAM_API || 'https://api.telegram.org'}/bot${token}/getMe`,
  }),
  discord: (token) => ({
    url: `${process.env.HERMIT_DOCTOR_DISCORD_API || 'https://discord.com/api/v10'}/users/@me`,
    headers: { Authorization: `Bot ${token}` },
  }),
};

/**
 * Pulls the bot's own id/username out of a probe response body.
 * Telegram wraps its payload in `result`; Discord returns the user object flat.
 * Anything unrecognized yields nulls — callers treat that as "not captured"
 * rather than guessing.
 */
export function extractBotIdentity(platform: string, body: any): BotIdentity {
  const u = platform === 'telegram' ? body?.result : body;
  const id = u?.id == null ? null : String(u.id);
  const username = typeof u?.username === 'string' && u.username ? u.username : null;
  return { id, username };
}
