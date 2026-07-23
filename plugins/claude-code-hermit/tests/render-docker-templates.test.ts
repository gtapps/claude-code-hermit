// End-to-end tests for render-docker-templates.ts — renders the REAL base
// Docker templates into a tmp dir via the CLI and asserts the property contract
// (no golden fixtures; the repo style is property assertions).
//
// Usage: bun test tests/render-docker-templates.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-rdt-');
afterAll(cleanup);

const BASE_INPUT = {
  packages: [] as string[],
  auth: 'oauth-token' as const,
  channels: { envLines: [] as string[], volumeLines: [] as string[] },
  agentHookProfile: 'strict',
  tmuxSessionName: 'hermit-myproj',
  networkMode: 'bridge' as const,
  gitIdentityMount: true,
};

async function render(dir: string, overrides: Record<string, unknown> = {}) {
  const input = { ...BASE_INPUT, ...overrides };
  const r = await runScript('render-docker-templates.ts', { args: [dir], stdin: JSON.stringify(input) });
  return r;
}

const dockerfile = (dir: string) => fs.readFileSync(path.join(dir, 'Dockerfile.hermit'), 'utf8');
const compose = (dir: string) => fs.readFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'utf8');

describe('render-docker-templates.ts', () => {
  test('renders all three files, exit 0, no {{ }} left', async () => {
    const dir = freshDir();
    const r = await render(dir);
    expect(r.exitCode).toBe(0);
    expect(dockerfile(dir)).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    expect(compose(dir)).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    expect(fs.existsSync(path.join(dir, 'docker-entrypoint.hermit.sh'))).toBe(true);
  });

  test('entrypoint is byte-identical to the template (cp, not regenerate)', async () => {
    const dir = freshDir();
    await render(dir);
    const rendered = fs.readFileSync(path.join(dir, 'docker-entrypoint.hermit.sh'));
    const template = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'docker-entrypoint.hermit.sh.template'));
    expect(rendered.equals(template)).toBe(true);
  });

  test('packages land in a Dockerfile RUN apt-get block', async () => {
    const dir = freshDir();
    await render(dir, { packages: ['libsqlite3-dev', 'ffmpeg'] });
    const df = dockerfile(dir);
    expect(df).toContain('# Project-specific packages (from config.json docker.packages)');
    expect(df).toMatch(/RUN apt-get update && apt-get install -y --no-install-recommends \\\n {6}libsqlite3-dev ffmpeg && \\/);
  });

  test('empty packages leaves no project-package RUN block', async () => {
    const dir = freshDir();
    await render(dir, { packages: [] });
    expect(dockerfile(dir)).not.toContain('# Project-specific packages');
  });

  test('network_mode: host is present only for host networking', async () => {
    const bridgeDir = freshDir();
    await render(bridgeDir, { networkMode: 'bridge' });
    expect(compose(bridgeDir)).not.toContain('network_mode: host');

    const hostDir = freshDir();
    await render(hostDir, { networkMode: 'host' });
    expect(compose(hostDir)).toContain('network_mode: host');
  });

  test('api-key auth adds ANTHROPIC_API_KEY env line; oauth does not', async () => {
    const keyDir = freshDir();
    await render(keyDir, { auth: 'api-key' });
    expect(compose(keyDir)).toContain('- ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}');

    const oauthDir = freshDir();
    await render(oauthDir, { auth: 'oauth-token' });
    expect(compose(oauthDir)).not.toContain('ANTHROPIC_API_KEY');
  });

  // The token must never be wired through compose. env_file is applied only at
  // container creation, so a token living there could not be rotated without
  // recreating the container from the host — the exact manual step the
  // channel-relayed renewal exists to remove.
  test('setup-token auth adds no auth env line at all', async () => {
    const dir = freshDir();
    await render(dir, { auth: 'setup-token' });
    const rendered = compose(dir);
    expect(rendered).not.toContain('ANTHROPIC_API_KEY');
    expect(rendered).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  test('git-identity bind-mount is conditional on gitIdentityMount', async () => {
    const withDir = freshDir();
    await render(withDir, { gitIdentityMount: true });
    expect(compose(withDir)).toContain('- ${HOME}/.gitconfig:/home/claude/.gitconfig:ro');

    const withoutDir = freshDir();
    await render(withoutDir, { gitIdentityMount: false });
    expect(compose(withoutDir)).not.toContain('${HOME}/.gitconfig');
  });

  test('channel volume + env lines render at exact 6-space indent', async () => {
    const dir = freshDir();
    await render(dir, {
      channels: {
        envLines: ['DISCORD_STATE_DIR=${PWD}/.claude.local/channels/discord'],
        volumeLines: ['${PWD}/.claude.local/channels/discord:/home/claude/.claude/channels/discord'],
      },
    });
    const c = compose(dir);
    // Exact-indent assertions — YAML breaks silently on wrong indent.
    expect(c).toMatch(/^ {6}- \$\{PWD\}\/\.claude\.local\/channels\/discord:\/home\/claude\/\.claude\/channels\/discord$/m);
    expect(c).toMatch(/^ {6}- DISCORD_STATE_DIR=\$\{PWD\}\/\.claude\.local\/channels\/discord$/m);
  });

  test('no channels leaves no channel state-dir wiring', async () => {
    const dir = freshDir();
    await render(dir, { channels: { envLines: [], volumeLines: [] } });
    expect(compose(dir)).not.toContain('STATE_DIR');
  });

  test('manifestSeed payload carries absolute paths and current plugin version', async () => {
    const dir = freshDir();
    const r = await render(dir);
    const out = JSON.parse(r.stdout);
    expect(out.entrypointCopied).toBe(true);
    expect(out.written).toHaveLength(2);
    for (const w of out.written) expect(path.isAbsolute(w)).toBe(true);

    const pj = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(out.manifestSeed.pluginVersion).toBe(pj.version);

    const byKey = Object.fromEntries(out.manifestSeed.entries.map((e: any) => [e.key, e.file]));
    for (const file of Object.values(byKey)) expect(path.isAbsolute(file as string)).toBe(true);
    // Entrypoint hashes the on-disk rendered file at the project root; the two
    // .template keys hash the upstream templates in the plugin.
    expect(byKey['docker/docker-entrypoint.hermit.sh']).toBe(path.join(dir, 'docker-entrypoint.hermit.sh'));
    expect(byKey['docker/Dockerfile.hermit.template']).toContain('state-templates/docker/Dockerfile.hermit.template');
  });

  test('relative project-root argv is resolved to an absolute path', async () => {
    const dir = freshDir();
    const rel = path.relative(process.cwd(), dir);
    const r = await runScript('render-docker-templates.ts', {
      args: [rel], stdin: JSON.stringify(BASE_INPUT),
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    for (const w of out.written) expect(path.isAbsolute(w)).toBe(true);
  });
});
