import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupWorkdir } from './helpers/workdir';
import { lookupChat, lookupGuildRoles } from '../scripts/lib/channel-chats';

test('Discord metadata caches success, errors, and retries errors after 24 hours', async () => {
  const wd = setupWorkdir();
  const dir = path.join(wd.dir, '.claude-code-hermit');
  const tokenDir = path.join(wd.dir, 'discord');
  fs.mkdirSync(tokenDir);
  fs.writeFileSync(path.join(tokenDir, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
  const config = { channels: { discord: { state_dir: tokenDir, bot_user_id: '7' } } };
  const previousStateDir = process.env.DISCORD_STATE_DIR;
  process.env.DISCORD_STATE_DIR = tokenDir;
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(req) {
    expect(req.headers.get('Authorization') === 'Bot test-token').toBe(true);
    const route = new URL(req.url).pathname;
    requests.push(route);
    if (route === '/channels/403') return new Response('', { status: 403 });
    return Response.json(route.includes('/guilds/') ? { roles: ['9'] } : { parent_id: null, guild_id: '2', type: 0 });
  } });
  const prev = process.env.HERMIT_DISCORD_API_URL;
  process.env.HERMIT_DISCORD_API_URL = server.url.toString().replace(/\/$/, '');
  try {
    expect(await lookupChat(dir, config, '1')).toMatchObject({ guild_id: '2', type: 0, parent_id: null });
    await lookupChat(dir, config, '1');
    expect(requests).toEqual(['/channels/1']);
    expect(await lookupChat(dir, config, '403')).toBeNull();
    expect(await lookupChat(dir, config, '403')).toBeNull();
    expect(requests.length).toBe(2);
    const file = path.join(dir, 'state', 'channel-chats.json');
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(cache.discord.chats['403'].error).toBe(403);
    cache.discord.chats['403'].fetched_at = new Date(Date.now() - 86400001).toISOString();
    fs.writeFileSync(file, JSON.stringify(cache));
    await lookupChat(dir, config, '403');
    expect(requests.length).toBe(3);
    expect(await lookupGuildRoles(dir, config, '2')).toMatchObject({ role_ids: ['9'] });
    await lookupGuildRoles(dir, config, '2');
    expect(requests.length).toBe(4);
    expect(requests).toEqual(['/channels/1', '/channels/403', '/channels/403', '/guilds/2/members/7']);
    expect(await lookupGuildRoles(dir, { channels: { discord: { state_dir: tokenDir } } }, '3')).toBeNull();
    expect(requests.length).toBe(4);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).discord.guilds).not.toHaveProperty('3');
    // Roles are mutable, so a cached success expires on the same 24h clock.
    const aged = JSON.parse(fs.readFileSync(file, 'utf8'));
    aged.discord.guilds['2'].fetched_at = new Date(Date.now() - 86400001).toISOString();
    fs.writeFileSync(file, JSON.stringify(aged));
    expect(await lookupGuildRoles(dir, config, '2')).toMatchObject({ role_ids: ['9'] });
    expect(requests.length).toBe(5);
  } finally {
    if (prev === undefined) delete process.env.HERMIT_DISCORD_API_URL;
    else process.env.HERMIT_DISCORD_API_URL = prev;
    if (previousStateDir === undefined) delete process.env.DISCORD_STATE_DIR;
    else process.env.DISCORD_STATE_DIR = previousStateDir;
    server.stop(true);
    wd.cleanup();
  }
});
