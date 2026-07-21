#!/usr/bin/env bun
/**
 * Renders the base Docker scaffolding for /docker-setup Step 7b.6.
 *
 * The skill owns every DECISION (auth, channels, packages, networking, plugin
 * resolution) and hands this script the resolved SEMANTIC inputs on stdin; the
 * script derives the `{{PLACEHOLDER}}` strings, renders `Dockerfile.hermit` and
 * `docker-compose.hermit.yml` from the upstream templates, and copies the
 * entrypoint verbatim (it has no placeholders — the session name is resolved
 * from config.json at container startup, so it must be `cp`-copied, never
 * regenerated). All rendering + validation happens in memory; nothing is
 * written unless every file passes the fail-loud placeholder check.
 *
 * Usage: bun render-docker-templates.ts <project-root>
 *   stdin JSON:
 *     {
 *       "packages": ["libsqlite3-dev", ...],
 *       "auth": "setup-token" | "oauth-token" | "api-key",
 *       "channels": {
 *         "envLines":    ["DISCORD_STATE_DIR=${PWD}/.claude.local/channels/discord", ...],
 *         "volumeLines": ["${PWD}/.claude.local/channels/discord:/home/claude/.claude/channels/discord", ...]
 *       },
 *       "agentHookProfile": "strict",
 *       "tmuxSessionName": "hermit-myproject",
 *       "networkMode": "bridge" | "host",
 *       "gitIdentityMount": true
 *     }
 *   channels.envLines / volumeLines carry the line BODY (the text after
 *   `      - `); this script owns the compose indentation.
 *
 * Prints JSON to stdout:
 *   { "written": ["/abs/Dockerfile.hermit", "/abs/docker-compose.hermit.yml"],
 *     "entrypointCopied": true,
 *     "manifestSeed": { "pluginVersion": "...", "entries": [...] } }
 * The skill pipes `manifestSeed` straight into manifest-seed.ts — this script
 * does NOT hash anything itself (one writer per file).
 *
 * Exit 0 on success. Any validation failure / unsubstituted placeholder →
 * exit 1 with nothing written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { renderTemplate } from './lib/render-template';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const TEMPLATES_DIR = path.join(PLUGIN_ROOT, 'state-templates', 'docker');

const ENV_INDENT = '      - ';

interface Channels {
  envLines?: string[];
  volumeLines?: string[];
}
interface Inputs {
  packages?: string[];
  auth: 'setup-token' | 'oauth-token' | 'api-key';
  channels?: Channels;
  agentHookProfile: string;
  tmuxSessionName: string;
  networkMode: 'bridge' | 'host';
  gitIdentityMount: boolean;
}

function packagesBlock(packages: string[]): string {
  if (packages.length === 0) return '';
  return [
    '# Project-specific packages (from config.json docker.packages)',
    '# To modify: /hermit-settings docker, then rebuild',
    'RUN apt-get update && apt-get install -y --no-install-recommends \\',
    `      ${packages.join(' ')} && \\`,
    '    rm -rf /var/lib/apt/lists/*',
  ].join('\n');
}

function indentedLines(bodies: string[]): string {
  return bodies.map((b) => ENV_INDENT + b).join('\n');
}

/** Build every rendered file in memory. Throws on any unsubstituted placeholder. */
export function render(inputs: Inputs): { dockerfile: string; compose: string } {
  const packages = inputs.packages ?? [];
  const channels = inputs.channels ?? {};
  const envLines = channels.envLines ?? [];
  const volumeLines = channels.volumeLines ?? [];

  const dockerfileTemplate = fs.readFileSync(
    path.join(TEMPLATES_DIR, 'Dockerfile.hermit.template'), 'utf8');
  let composeTemplate = fs.readFileSync(
    path.join(TEMPLATES_DIR, 'docker-compose.hermit.yml.template'), 'utf8');

  // Git identity has no placeholder in the template — it is a fixed bind-mount
  // line the skill removes when the host has no ~/.gitconfig.
  if (!inputs.gitIdentityMount) {
    composeTemplate = composeTemplate.replace(
      '      - ${HOME}/.gitconfig:/home/claude/.gitconfig:ro\n', '');
  }

  const dockerfile = renderTemplate(dockerfileTemplate, {
    PACKAGES_BLOCK: packagesBlock(packages),
  });

  // AUTH_ENV_LINE carries a trailing newline (api-key) so CHANNEL_ENV_LINES,
  // which shares the same template line, starts on a fresh line.
  //
  // Only api-key gets an env line. Both subscription modes read their
  // credential from the claude-config volume — and setup-token specifically
  // must NOT be wired through .env: compose applies env_file at container
  // creation only, so an .env-stored token would need a host-side recreate on
  // every renewal, defeating the point of channel-relayed re-auth. hermit-start
  // exports it from the volume file at process start instead.
  const authEnvLine = inputs.auth === 'api-key'
    ? '      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}\n'
    : '';
  const networkModeLine = inputs.networkMode === 'host'
    ? '    # WARNING: host networking exposes all host-local services to the container.\n    network_mode: host'
    : '';

  const compose = renderTemplate(composeTemplate, {
    AUTH_ENV_LINE: authEnvLine,
    CHANNEL_ENV_LINES: indentedLines(envLines),
    CHANNEL_VOLUME_LINES: indentedLines(volumeLines),
    AGENT_HOOK_PROFILE: inputs.agentHookProfile,
    TMUX_SESSION_NAME: inputs.tmuxSessionName,
    NETWORK_MODE_LINE: networkModeLine,
  });

  return { dockerfile, compose };
}

function pluginVersion(): string {
  const pj = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  return String(pj.version);
}

if (import.meta.main) {
  const projectRoot = path.resolve(process.argv[2] || process.cwd());

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try {
      const inputs = JSON.parse(raw) as Inputs;

      // Render + validate everything before any write. pluginVersion() reads +
      // parses plugin.json; resolve it here too so a missing/corrupt manifest
      // throws BEFORE any file is written (honours the "nothing written" contract).
      const { dockerfile, compose } = render(inputs);
      const entrypointSrc = path.join(TEMPLATES_DIR, 'docker-entrypoint.hermit.sh.template');
      if (!fs.existsSync(entrypointSrc)) throw new Error(`missing entrypoint template: ${entrypointSrc}`);
      const version = pluginVersion();

      const dockerfilePath = path.join(projectRoot, 'Dockerfile.hermit');
      const composePath = path.join(projectRoot, 'docker-compose.hermit.yml');
      const entrypointPath = path.join(projectRoot, 'docker-entrypoint.hermit.sh');

      fs.writeFileSync(dockerfilePath, dockerfile);
      fs.writeFileSync(composePath, compose);
      fs.copyFileSync(entrypointSrc, entrypointPath);

      const manifestSeed = {
        pluginVersion: version,
        entries: [
          { key: 'docker/docker-entrypoint.hermit.sh', file: entrypointPath },
          {
            key: 'docker/docker-compose.hermit.yml.template',
            file: path.join(TEMPLATES_DIR, 'docker-compose.hermit.yml.template'),
          },
          {
            key: 'docker/Dockerfile.hermit.template',
            file: path.join(TEMPLATES_DIR, 'Dockerfile.hermit.template'),
          },
        ],
      };

      console.log(JSON.stringify({
        written: [dockerfilePath, composePath],
        entrypointCopied: true,
        manifestSeed,
      }));
      process.exit(0);
    } catch (e: any) {
      console.error(`render-docker-templates: ${e.message}`);
      process.exit(1);
    }
  });
}
