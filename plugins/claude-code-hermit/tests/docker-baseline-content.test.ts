// Content-assertion tests for the Docker baseline templates.
// (bun test port of test-docker-baseline-content.sh)
//
// Guards against accidental removal or layer-splitting of the gh install
// added in v1.0.40 (PROP-028, GH #82). No Docker daemon required — pure
// file inspection.
//
// Usage: bun test tests/docker-baseline-content.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';
import { getSessionName } from '../scripts/lib/tmux';

const dockerfile = fs.readFileSync(
  path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'Dockerfile.hermit.template'), 'utf-8');
const compose = fs.readFileSync(
  path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'docker-compose.hermit.yml.template'), 'utf-8');
const entrypoint = fs.readFileSync(
  path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'docker-entrypoint.hermit.sh.template'), 'utf-8');

const dockerfileLines = dockerfile.split('\n');
const rmLine = dockerfileLines.findIndex((l) => l.includes('rm -rf /var/lib/apt/lists'));

// -------------------------------------------------------
// Dockerfile: gh apt source present
// -------------------------------------------------------
describe('Dockerfile: gh apt source', () => {
  test('Dockerfile: cli.github.com apt source present', () => {
    expect(dockerfile).toContain('cli.github.com/packages');
  });

  test('Dockerfile: githubcli-archive-keyring.gpg fetched', () => {
    expect(dockerfile).toContain('githubcli-archive-keyring.gpg');
  });

  test('Dockerfile: gh installed via apt-get', () => {
    expect(dockerfile).toMatch(/apt-get install.*--no-install-recommends gh/);
  });
});

// -------------------------------------------------------
// Dockerfile: gh install is in the same layer as the cleanup
// (regression guard: no accidental RUN split that produces a
// dangling apt-get update without a matching rm -rf)
// -------------------------------------------------------
describe('Dockerfile: layer integrity', () => {
  test('Dockerfile: exactly one rm -rf /var/lib/apt/lists/ in base section (no layer split)', () => {
    const count = dockerfileLines.filter((l) => l.includes('rm -rf /var/lib/apt/lists')).length;
    expect(count).toBe(1);
  });

  test('Dockerfile: gh line appears before rm -rf (same layer ordering)', () => {
    const ghLine = dockerfileLines.findIndex((l) => /apt-get install.*--no-install-recommends gh/.test(l));
    expect(ghLine).toBeGreaterThanOrEqual(0);
    expect(rmLine).toBeGreaterThanOrEqual(0);
    expect(ghLine).toBeLessThan(rmLine);
  });
});

// -------------------------------------------------------
// Compose: HERMIT_GH_TOKEN mapped to GH_TOKEN
// -------------------------------------------------------
describe('Compose: GH_TOKEN mapping', () => {
  test('Compose: GH_TOKEN env var present', () => {
    expect(compose).toContain('GH_TOKEN=');
  });

  test('Compose: GH_TOKEN uses HERMIT_GH_TOKEN source with empty-safe default', () => {
    expect(compose).toContain('GH_TOKEN=${HERMIT_GH_TOKEN:-}');
  });

  test('Compose: GH_TOKEN entry is in the environment block (indented with spaces)', () => {
    expect(compose).toMatch(/^ {6}- GH_TOKEN=/m);
  });
});

// -------------------------------------------------------
// Dockerfile: sandbox deps (bubblewrap + socat) present
// Added in v1.1.2 — required for Claude Code sandbox inside
// unprivileged containers.
// -------------------------------------------------------
describe('Dockerfile: sandbox deps', () => {
  test('Dockerfile: bubblewrap present in apt-get install', () => {
    expect(dockerfile).toContain('bubblewrap');
  });

  test('Dockerfile: socat present in apt-get install', () => {
    expect(dockerfile).toContain('socat');
  });

  test('Dockerfile: bubblewrap and socat in same RUN layer as cleanup', () => {
    const bwrapLine = dockerfileLines.findIndex((l) => l.includes('bubblewrap'));
    expect(bwrapLine).toBeGreaterThanOrEqual(0);
    expect(rmLine).toBeGreaterThanOrEqual(0);
    expect(bwrapLine).toBeLessThan(rmLine);
  });
});

// -------------------------------------------------------
// Python retired from the Docker layer (bun migration WP9).
// Bun is the hermit runtime; Node/npm stay solely for the
// Claude Code CLI and its self-update path.
// -------------------------------------------------------
describe('Dockerfile: Python retired, bun pinned', () => {
  test('Dockerfile: no python3 packages remain', () => {
    expect(dockerfile).not.toContain('python3');
  });

  test('Dockerfile: bun installed via native installer with BUN_VERSION pin', () => {
    expect(dockerfile).toContain('curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"');
  });

  test('Dockerfile: BUN_VERSION build arg pinned to a concrete version', () => {
    expect(dockerfile).toMatch(/^ARG BUN_VERSION=\d+\.\d+\.\d+$/m);
  });

  test('Dockerfile: .bun/bin on ENV PATH', () => {
    expect(dockerfile).toMatch(/^ENV PATH=\/home\/claude\/\.bun\/bin:\$PATH$/m);
  });

  test('Dockerfile: Node layer kept for the Claude Code CLI', () => {
    expect(dockerfile).toContain('deb.nodesource.com');
    expect(dockerfile).toContain('npm install -g @anthropic-ai/claude-code');
  });
});

describe('Entrypoint: setup-token auth gates', () => {
  // The entrypoint runs BEFORE hermit-start exports CLAUDE_CODE_OAUTH_TOKEN, so
  // a gate keyed only on the env var would never see token mode and would sit
  // there waiting for credentials that are already present. The file on the
  // volume is the only boot-time signal.
  test('entrypoint: defines the token file path and gates on the FILE', () => {
    expect(entrypoint).toContain('SETUP_TOKEN_FILE="${CLAUDE_CONFIG_DIR}/.hermit-setup-token"');
    const gate = entrypoint.slice(entrypoint.indexOf('# --- 0. Wait for auth credentials'));
    const zeroGate = gate.slice(0, gate.indexOf('# --- 0b.'));
    expect(zeroGate).toContain('[ ! -f "$SETUP_TOKEN_FILE" ]');
  });

  test('entrypoint: the credential wait loop also breaks on a minted token', () => {
    expect(entrypoint).toContain('while [ ! -f "$CRED_FILE" ] && [ ! -f "$SETUP_TOKEN_FILE" ]; do');
  });

  // A converted hermit usually still carries the .credentials.json from its
  // original /login, whose expiresAt lapses and is never refreshed again. Before
  // this skip, that stale field false-blocked a perfectly healthy hermit at boot.
  test('entrypoint: §0b expiry gate is skipped entirely in token mode', () => {
    const expiryGate = entrypoint.slice(entrypoint.indexOf('# --- 0b.'));
    const condition = expiryGate.slice(0, expiryGate.indexOf('EXPIRED=$('));
    expect(condition).toContain('[ ! -f "$SETUP_TOKEN_FILE" ]');
    expect(condition).toContain('[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]');
  });

  // §0c parks a stale /login credential when a setup-token is present: interactive
  // sessions prefer .credentials.json over the env token, so an unparked stored
  // login 401s the hermit ~8h after its token lapses. Guards hermits converted
  // before install-time parking shipped.
  test('entrypoint: §0c parks a stale credential in token mode', () => {
    const guard = entrypoint.slice(entrypoint.indexOf('# --- 0c.'));
    const block = guard.slice(0, guard.indexOf('# --- 0d.'));
    expect(block).toContain('[ -f "$SETUP_TOKEN_FILE" ] && [ -f "$CRED_FILE" ]');
    expect(block).toContain('mv -f "$CRED_FILE" "${CRED_FILE}.pre-token.bak"');
  });
});

describe('Entrypoint: placeholder-free session name resolution', () => {
  test('entrypoint: no {{...}} placeholders remain (safe to raw-copy)', () => {
    expect(entrypoint).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test('entrypoint: resolves SESSION_NAME from config.json at runtime', () => {
    expect(entrypoint).toContain('tmux_session_name');
    expect(entrypoint).toContain('hermit-{project_name}');
  });

  // Crux: the resolved name must equal what getSessionName() produces — that is what
  // hermit-start uses to CREATE the session. Both sides must chdir into the same temp
  // dir because getSessionName() reads process.cwd() for {project_name}.
  test.serial('entrypoint: session-name resolution matches lib/tmux.getSessionName — default config', () => {
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-session-name-'));
    try {
      process.chdir(tmpDir);
      const config = {};
      const expected = getSessionName(config);
      const raw = String((config as any).tmux_session_name ?? 'hermit-{project_name}');
      const actual = raw.replaceAll('{project_name}', path.basename(process.cwd()));
      expect(actual).toBe(expected);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('entrypoint: session-name resolution matches lib/tmux.getSessionName — custom tmux_session_name', () => {
    // Custom name has no {project_name} token; no chdir or tmpDir needed.
    const config = { tmux_session_name: 'my-custom-session' };
    const actual = String(config.tmux_session_name ?? 'hermit-{project_name}');
    expect(actual).toBe(getSessionName(config));
  });

  // Execution-based parity: extract the REAL `bun -e` block from the template and run it.
  // The formula tests above only re-implement the logic in TS — they would not catch a wrong
  // process.argv[N] index in the shell snippet. This runs the actual code the container runs.
  test('entrypoint: embedded bun -e snippet resolves the same name the container will use', () => {
    const m = entrypoint.match(/bun -e "\n([\s\S]*?)\n" "\$\{AGENT_DIR\}\/config\.json"/);
    expect(m).not.toBeNull();
    const snippet = m![1];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-snippet-'));
    try {
      const cfgPath = path.join(tmpDir, 'config.json');
      const projectDir = path.join(tmpDir, 'my-proj');

      // Default config: {project_name} expands to basename(projectDir).
      fs.writeFileSync(cfgPath, '{}');
      const out = spawnSync('bun', ['-e', snippet, cfgPath, projectDir], { encoding: 'utf8' });
      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe('hermit-my-proj');

      // Custom name passes through untouched.
      fs.writeFileSync(cfgPath, JSON.stringify({ tmux_session_name: 'custom-x' }));
      const out2 = spawnSync('bun', ['-e', snippet, cfgPath, projectDir], { encoding: 'utf8' });
      expect(out2.stdout.trim()).toBe('custom-x');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// -------------------------------------------------------
// Dockerfile: base image (regression guard — prevent accidental downgrade)
// -------------------------------------------------------
describe('Dockerfile: base image', () => {
  test('Dockerfile: FROM ubuntu:26.04', () => {
    expect(dockerfile).toContain('FROM ubuntu:26.04');
  });
});

describe('Entrypoint: Python retired, PATH covers bun', () => {
  test('entrypoint: no python3 invocations remain', () => {
    expect(entrypoint).not.toContain('python3');
  });

  test('entrypoint: explicit PATH line includes both .npm-global/bin and .bun/bin', () => {
    const pathLine = entrypoint.split('\n').find((l) => l.startsWith('export PATH='));
    expect(pathLine).toBeDefined();
    expect(pathLine).toContain('/home/claude/.npm-global/bin');
    expect(pathLine).toContain('/home/claude/.bun/bin');
  });

  test('entrypoint: npm self-heal for the claude binary kept', () => {
    expect(entrypoint).toContain('npm install -g @anthropic-ai/claude-code');
  });
});

describe('Entrypoint: marketplace registration uses list --json, not dir existence', () => {
  test('entrypoint: marketplace_registered helper present', () => {
    expect(entrypoint).toContain('marketplace_registered()');
    expect(entrypoint).toContain('marketplace list --json');
    expect(entrypoint).toContain('.name == $n');
  });

  test('entrypoint: no [ -d MARKETPLACE_DIR ] registration checks remain', () => {
    expect(entrypoint).not.toMatch(/\[ ! -d "\$\{MARKETPLACE_DIR\}/);
  });

  test('entrypoint: hermit install decoupled from marketplace add', () => {
    expect(entrypoint).toContain("grep -qF 'claude-code-hermit@claude-code-hermit'");
  });

  test('entrypoint: enable failures distinguish benign "already enabled" from genuine', () => {
    // Shared shell helper suppresses only the benign case and warns otherwise.
    expect(entrypoint).toContain('enable_plugin()');
    expect(entrypoint).toContain('already enabled');
    // No enable site silently swallows failures via `|| true` anymore.
    expect(entrypoint).not.toMatch(/plugin enable[^\n]*\|\| true/);
  });
});
