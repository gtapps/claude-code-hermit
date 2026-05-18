#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const hermitDir = process.argv[2] || '.claude-code-hermit';
const configPath = path.join(hermitDir, 'config.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  process.stderr.write(`resolve-outbound-channel: cannot read ${configPath}: ${e.message}\n`);
  process.stdout.write(JSON.stringify({ error: 'config_read_failed' }) + '\n');
  process.exit(1);
}

const channels = config.channels || {};

function eligible(ch) {
  if (!ch || typeof ch !== 'object') return false;
  if (ch.enabled === false) return false;
  if (Array.isArray(ch.allowed_users) && ch.allowed_users.length === 0) return false;
  return !!ch.dm_channel_id;
}

const PRIORITY = ['discord', 'telegram', 'imessage'];

function resolve() {
  const primary = typeof channels.primary === 'string' ? channels.primary : null;
  if (primary && eligible(channels[primary])) {
    return { id: primary, chat_id: channels[primary].dm_channel_id };
  }
  for (const id of PRIORITY) {
    if (eligible(channels[id])) {
      return { id, chat_id: channels[id].dm_channel_id };
    }
  }
  return null;
}

const result = resolve();
if (result) {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
} else {
  process.stdout.write(JSON.stringify({ error: 'no_reachable_channel' }) + '\n');
  process.exit(1);
}
