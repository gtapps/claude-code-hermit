// Shared channel bot-token reader — resolves a channel's state_dir/.env and
// parses `<VAR>=value`. Used by both the outbound send path (lib/channel-send.ts)
// and doctor-check.ts's liveness probe, so the state-dir resolution and .env
// parsing rules can't drift out of sync between them.
//
// Resolution mirrors the original callers: a `<NAME>_STATE_DIR` env override,
// else the channel's configured `state_dir`, else the conventional default;
// relative paths resolve against the project root (hermitDir's parent).

import fs from 'node:fs';
import path from 'node:path';

type Json = any;

/**
 * Read a channel's bot token from its `state_dir/.env`. `varName` defaults to
 * `<NAME>_BOT_TOKEN`. Handles `export `-prefixed lines, `#` comment lines, and
 * single/double-quoted values. Returns null when the file or key is absent.
 */
export function readChannelToken(
  hermitDir: string,
  channelName: string,
  channelCfg: Json,
  varName?: string,
): string | null {
  const stateDirEnv = process.env[`${channelName.toUpperCase()}_STATE_DIR`];
  let stateDir = stateDirEnv || channelCfg?.state_dir || path.join('.claude.local', 'channels', channelName);
  if (!path.isAbsolute(stateDir)) stateDir = path.join(hermitDir, '..', stateDir);
  const envPath = path.join(stateDir, '.env');
  const key = varName || `${channelName.toUpperCase()}_BOT_TOKEN`;

  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return null;
  }
  for (let line of content.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}
