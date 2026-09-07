// Folder-shared Discord chat metadata for passive capture. Best-effort atomic
// writes are last-writer-wins, like channel-health; a lost entry is fetched again.
import fs from 'node:fs';
import path from 'node:path';
import { readChannelToken } from './channel-token';
import { writeFileAtomic } from './md-write';

type Json = any;
export interface Chat {
  parent_id: string | null;
  guild_id: string | null;
  type: number;
  fetched_at: string;
}
export interface GuildRoles {
  role_ids: string[];
  fetched_at: string;
}
type CachedError = { error: number | 'network'; fetched_at: string };
type Entry = Chat | GuildRoles | CachedError;
type Bucket = 'chats' | 'guilds';

function readCache(hermitDir: string): Json {
  try {
    return JSON.parse(fs.readFileSync(path.join(hermitDir, 'state', 'channel-chats.json'), 'utf8'));
  } catch { return {}; }
}

function cachedEntry(hermitDir: string, bucket: Bucket, id: string): Entry | null {
  const entry = readCache(hermitDir)?.discord?.[bucket]?.[id];
  if (!entry || typeof entry !== 'object') return null;
  if ('error' in entry && Date.now() - Date.parse(entry.fetched_at) >= 24 * 60 * 60 * 1000) return null;
  return entry;
}

export function cachedChat(hermitDir: string, chatId: string): Chat | null {
  const entry = cachedEntry(hermitDir, 'chats', chatId);
  return entry && 'type' in entry ? entry as Chat : null;
}

export function cachedGuildRoles(hermitDir: string, guildId: string): GuildRoles | null {
  const entry = cachedEntry(hermitDir, 'guilds', guildId);
  return entry && 'role_ids' in entry ? entry as GuildRoles : null;
}

async function lookup(hermitDir: string, config: Json, bucket: Bucket, id: string): Promise<Entry | null> {
  try {
    const cached = cachedEntry(hermitDir, bucket, id);
    if (cached) return 'error' in cached ? null : cached;
    let entry: Entry;
    const fetched_at = new Date().toISOString();
    try {
      const token = readChannelToken(hermitDir, 'discord', config?.channels?.discord);
      if (!token) throw new Error('missing token');
      const base = process.env.HERMIT_DISCORD_API_URL || 'https://discord.com/api/v10';
      const route = bucket === 'chats' ? `/channels/${id}` : `/guilds/${id}/members/@me`;
      const response = await fetch(`${base}${route}`, {
        headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) entry = { error: response.status, fetched_at };
      else {
        const body = await response.json() as Json;
        entry = bucket === 'chats'
          ? { parent_id: body.parent_id ?? null, guild_id: body.guild_id ?? null, type: body.type, fetched_at }
          : { role_ids: body.roles, fetched_at };
      }
    } catch { entry = { error: 'network', fetched_at }; }
    try {
      const all = readCache(hermitDir);
      all.discord ??= {};
      all.discord.chats ??= {};
      all.discord.guilds ??= {};
      all.discord[bucket][id] = entry;
      const file = path.join(hermitDir, 'state', 'channel-chats.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, JSON.stringify(all, null, 2) + '\n');
    } catch { /* advisory cache; failure does not discard the HTTP result */ }
    return 'error' in entry ? null : entry;
  } catch { return null; }
}

export async function lookupChat(hermitDir: string, config: Json, chatId: string): Promise<Chat | null> {
  return await lookup(hermitDir, config, 'chats', chatId) as Chat | null;
}

export async function lookupGuildRoles(hermitDir: string, config: Json, guildId: string): Promise<GuildRoles | null> {
  return await lookup(hermitDir, config, 'guilds', guildId) as GuildRoles | null;
}
