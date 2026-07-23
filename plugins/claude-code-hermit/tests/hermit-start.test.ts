// Unit tests for scripts/hermit-start.ts internals (bun test port of the
// hermit-start classes in run-contracts.py).
//
// The Python suite imported hermit-start.py via importlib and monkeypatched
// module attributes. ESM exports are immutable, so this port uses the
// strategies validated during the hermit-start.ts side-by-side review:
//   - `_fetch_registered_marketplaces` patches → a PATH-stubbed `claude`
//     binary (exit 1 for "fetch failed → null"; prints JSON for a list).
//   - `is_container` patches → `container=docker` env var (read at call
//     time by isContainer()). Tests that need is_container() === false rely
//     on the host genuinely not being a container and are skipped inside
//     real containers (CI runs on VM runners, so they run there).
//   - `sys.exit` / stdout capture → temporary process.exit / console.log
//     overrides (both are mutable harness objects, unlike module exports).
//
// CONFIG_PATH / STATE_DIR are relative string constants resolved against
// process.cwd() at CALL time (fs.* calls, not import-time path.resolve), so
// the Python tempdir-chdir pattern translates to process.chdir in
// beforeEach/afterEach with the original cwd restored.
//
// Usage: bun test tests/hermit-start.test.ts   (from the plugin root)

import { describe, test as bunTest, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  loadConfig,
  getEnabledChannels,
  iterChannelConfigs,
  writeSettingsEnv,
  applyArtifactGrant,
  applyAlwaysOnDoctorSchedule,
  clearShutdownStampsOnBoot,
  clearStatusCacheOnBoot,
  hydrateSetupTokenEnv,
} from '../scripts/hermit-start';
import { TOKEN_ENV_VAR } from '../scripts/lib/setup-token';

// The top-level beforeEach/afterEach below process.chdir()s into a fresh
// tempdir for every test in this file — a process-global mutation two
// concurrently-running tests can't both have. Alias `test` to force the
// whole file to run serially under `bun test --concurrent`.
const test = bunTest.serial;

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');

// Real container detection (mirror of isContainer()) — used to skip the
// tests that require is_container() === false, which can't be faked.
const IN_CONTAINER =
  fs.existsSync('/.dockerenv') ||
  fs.existsSync('/run/.containerenv') ||
  process.env.container === 'docker';

// ---------- tempdir-chdir harness (port of _TempDirTest) ----------

let tmpdir = '';
let origCwd = '';
let origProfile: string | undefined;
let origContainer: string | undefined;
let origPath: string | undefined;

beforeEach(() => {
  origCwd = process.cwd();
  origProfile = process.env.AGENT_HOOK_PROFILE;
  origContainer = process.env.container;
  origPath = process.env.PATH;
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-start-test-'));
  process.chdir(tmpdir);
  fs.mkdirSync('.claude-code-hermit/state', { recursive: true });
  fs.mkdirSync('.claude', { recursive: true });
});

afterEach(() => {
  process.chdir(origCwd);
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {}
  const restore = (key: string, val: string | undefined) => {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  };
  restore('AGENT_HOOK_PROFILE', origProfile);
  restore('container', origContainer);
  restore('PATH', origPath);
});

// ---------- small helpers ----------

// Accessor defeats TS control-flow narrowing after `delete process.env...`.
const profileEnv = (): string | undefined => process.env.AGENT_HOOK_PROFILE;

const writeConfig = (config: any) =>
  fs.writeFileSync('.claude-code-hermit/config.json', JSON.stringify(config));
const writeSettings = (settings: any) =>
  fs.writeFileSync('.claude/settings.local.json', JSON.stringify(settings));
const readSettings = () =>
  JSON.parse(fs.readFileSync('.claude/settings.local.json', 'utf-8'));

/** Capture console.log output around a synchronous call (redirect_stdout port). */
function captureLog<T>(fn: () => T): { result: T; out: string } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: any[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { result: fn(), out: lines.length ? lines.join('\n') + '\n' : '' };
  } finally {
    console.log = orig;
  }
}

/** Flatten a nested object to dot-separated key paths (port of _flatten_keys). */
function flattenKeys(obj: any, prefix = ''): Set<string> {
  const keys = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    keys.add(p);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const s of flattenKeys(v, p)) keys.add(s);
    }
  }
  return keys;
}

/** JSON type class for the type-sync contract. null matches any type. */
function jsonType(v: any): string | null {
  if (v === null) return null;
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'dict';
  return typeof v;
}

function flattenTyped(obj: any, prefix: string, out: Record<string, string | null>): void {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out[p] = jsonType(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenTyped(v, p, out);
  }
}

// ---------- buildClaudeCommand subprocess harness ----------
//
// Replaces @patch.object(hermit_start, '_fetch_registered_marketplaces'):
// fetchRegisteredMarketplaces() spawns `claude plugin marketplace list --json`,
// and Bun resolves the executable from the PATH the *process started with* —
// mutating process.env.PATH in-test does not affect spawnSync resolution
// (verified empirically). So buildClaudeCommand runs in a `bun -e` child whose
// PATH is prepended with a stub-bin dir containing the fake `claude`.

/** fetchRegisteredMarketplaces() → null (the return_value=None patches). */
const CLAUDE_FETCH_FAILS = '#!/bin/sh\nexit 1\n';

/** fetchRegisteredMarketplaces() → the given marketplace list. */
const claudeMarketplaces = (entries: any[]) =>
  `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(entries)}\nEOF\n`;

const HERMIT_START_TS = path.join(PLUGIN_ROOT, 'scripts', 'hermit-start.ts');

/**
 * Run buildClaudeCommand(config, {bun: ...}) in a child bun process rooted at
 * the tempdir, with `claude` stubbed on PATH. console.log is captured inside
 * the child (the redirect_stdout port) and returned alongside the command.
 */
async function runBuildClaudeCommand(
  config: any,
  claudeStubBody: string,
): Promise<{ cmd: string[]; out: string }> {
  const bin = path.join(tmpdir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), claudeStubBody);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);

  const harness = `
    const lines = [];
    console.log = (...a) => lines.push(a.map(String).join(' '));
    const m = await import(${JSON.stringify(HERMIT_START_TS)});
    const cmd = m.buildClaudeCommand(${JSON.stringify(config)}, { bun: '/usr/local/bin/bun' });
    process.stdout.write(JSON.stringify({ cmd, out: lines.length ? lines.join('\\n') + '\\n' : '' }));
  `;
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', harness],
    cwd: tmpdir,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`harness exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout);
}

// ============================================================
// Config contract tests (TestConfigContract)
// ============================================================

describe('config contract: template and DEFAULT_CONFIG must mirror', () => {
  const template = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template'), 'utf-8'),
  );

  // Keys that exist only in template — consumed by scripts that handle
  // their own missing-key logic (not part of loadConfig merge).
  const TEMPLATE_ONLY_KEYS = new Set([
    'idle_behavior', 'routines', 'monitors',
    'compact', 'compact.monitoring_threshold', 'compact.monitoring_keep',
    'compact.summary_threshold', 'compact.summary_keep',
    'docker.recommended_plugins',
    // Read directly by cron-registry.ts (raw config read, own default of 6) — not part of the loadConfig merge.
    'routine_wake_lint', 'routine_wake_lint.max_windows',
    // Read directly by doctor-check.ts's routine-cost check (raw config read, own default of 2) — not part of the loadConfig merge.
    'doctor', 'doctor.routine_cost_floor_usd',
  ]);

  test('key path sync: flattened key paths must match (excluding known template-only keys)', () => {
    const templateKeys = flattenKeys(template);
    const defaultKeys = flattenKeys(DEFAULT_CONFIG);

    // Template keys missing from defaults (besides known exceptions)
    const missingFromDefaults = [...templateKeys].filter(
      (k) => !defaultKeys.has(k) && !TEMPLATE_ONLY_KEYS.has(k),
    );
    expect(missingFromDefaults).toEqual([]);

    // Default keys missing from template
    const missingFromTemplate = [...defaultKeys].filter((k) => !templateKeys.has(k));
    expect(missingFromTemplate).toEqual([]);
  });

  test('type sync: for shared key paths, types must match (null matches any)', () => {
    const templateFlat: Record<string, string | null> = {};
    flattenTyped(template, '', templateFlat);
    const defaultFlat: Record<string, string | null> = {};
    flattenTyped(DEFAULT_CONFIG, '', defaultFlat);

    const shared = Object.keys(templateFlat).filter((k) => k in defaultFlat).sort();
    const mismatches: string[] = [];
    for (const key of shared) {
      const tType = templateFlat[key];
      const dType = defaultFlat[key];
      // null matches any type (it's a valid default)
      if (tType === null || dType === null) continue;
      if (tType !== dType) mismatches.push(`${key}: template=${tType}, default=${dType}`);
    }
    expect(mismatches).toEqual([]);
  });

  test('quality_gate.tier in template + DEFAULT_CONFIG must be in the budget/balanced/quality enum', () => {
    const validTiers = ['budget', 'balanced', 'quality'];
    expect(validTiers).toContain(template.quality_gate?.tier);
    expect(validTiers).toContain(DEFAULT_CONFIG.quality_gate?.tier);
  });
});

// ============================================================
// Boot merge logic (TestConfigMerge)
// ============================================================

describe('loadConfig merge', () => {
  test('sparse config with one key should get all defaults', () => {
    writeConfig({ agent_name: 'Test' });
    const merged = loadConfig();
    const defaultPaths = flattenKeys(DEFAULT_CONFIG);
    const mergedPaths = flattenKeys(merged);
    const missing = [...defaultPaths].filter((k) => !mergedPaths.has(k));
    expect(missing).toEqual([]);
    expect(merged.agent_name).toBe('Test');
  });

  test('user env override does not lose other env keys', () => {
    writeConfig({ env: { AGENT_HOOK_PROFILE: 'minimal' } });
    const merged = loadConfig();
    expect(merged.env.AGENT_HOOK_PROFILE).toBe('minimal');
    expect(merged.env).toContainKey('MAX_THINKING_TOKENS');
    expect(merged.env.MAX_THINKING_TOKENS).toBe('10000');
  });

  test('custom heartbeat.active_hours.start preserves default end', () => {
    writeConfig({ heartbeat: { active_hours: { start: '09:00' } } });
    const merged = loadConfig();
    expect(merged.heartbeat.active_hours.start).toBe('09:00');
    expect(merged.heartbeat.active_hours.end).toBe('23:00');
  });

  test('no config.json should cause exit(1)', () => {
    // loadConfig calls process.exit(1); patch it to throw a sentinel
    // (process.exit is mutable, unlike the module's exports).
    fs.rmSync('.claude-code-hermit/config.json', { force: true });
    const origExit = process.exit;
    let exitCode: number | undefined;
    (process as any).exit = (code?: number) => {
      exitCode = code;
      throw new Error('exit-called');
    };
    try {
      captureLog(() => {
        expect(() => loadConfig()).toThrow('exit-called');
      });
    } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });
});

// ============================================================
// Channel filtering (TestChannelFiltering)
// ============================================================

describe('getEnabledChannels', () => {
  test('mixed channels: only enabled dict channels returned', () => {
    const config = {
      channels: {
        discord: { enabled: true },
        telegram: { enabled: false },
        bad: 'string',
      },
    };
    expect(getEnabledChannels(config)).toEqual(['discord']);
  });

  test('empty channels object returns empty list', () => {
    expect(getEnabledChannels({ channels: {} })).toEqual([]);
  });

  test('non-dict channels value does not crash', () => {
    expect(getEnabledChannels({ channels: 'string' })).toEqual([]);
    expect(getEnabledChannels({ channels: ['list'] })).toEqual([]);
  });
});

// ============================================================
// buildClaudeCommand channel resolution (TestBuildClaudeCommandChannels)
//
// Silent-breakage zone — if this resolves wrong, claude exits at boot
// and the tmux session dies before the operator sees a useful error.
// ============================================================

describe('buildClaudeCommand channel resolution', () => {
  // buildClaudeCommand checks <state_dir>/.env existence and warns if missing.
  // We don't assert on the warning — we only care about the --channels payload.
  function stateDirWithEnv(channel: string): string {
    const d = path.join('.claude.local', 'channels', channel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.env'), 'TOKEN=stub\n');
    return d;
  }

  test('builtin channel resolves via hardcoded dict', async () => {
    const stateDir = stateDirWithEnv('discord');
    const config = { channels: { discord: { enabled: true, state_dir: stateDir } } };
    const { cmd } = await runBuildClaudeCommand(config, CLAUDE_FETCH_FAILS);
    expect(cmd).toContain('--channels');
    expect(cmd).toContain('plugin:discord@claude-plugins-official');
  }, 15000);

  test('third-party channel uses config marketplace', async () => {
    const stateDir = stateDirWithEnv('matrix');
    const config = {
      channels: {
        matrix: { enabled: true, state_dir: stateDir, marketplace: 'someone/matrix-plugin' },
      },
    };
    const { cmd } = await runBuildClaudeCommand(config, CLAUDE_FETCH_FAILS);
    expect(cmd).toContain('--channels');
    expect(cmd).toContain('plugin:matrix@someone/matrix-plugin');
    // Hardcoded official ID must NOT appear for non-built-in channels.
    for (const tok of cmd) {
      expect(
        tok.endsWith('@claude-plugins-official') && tok.startsWith('plugin:matrix@'),
      ).toBe(false);
    }
  }, 15000);

  test('unknown channel without marketplace falls through as bare name', async () => {
    // No CHANNEL_PLUGINS entry, no channels.<name>.marketplace → bare name appended.
    // This preserves prior behaviour (claude will reject it) but is now accompanied
    // by a clearer warning pointing at the marketplace fix.
    const stateDir = stateDirWithEnv('signal');
    const config = { channels: { signal: { enabled: true, state_dir: stateDir } } };
    const { cmd } = await runBuildClaudeCommand(config, CLAUDE_FETCH_FAILS);
    expect(cmd).toContain('--channels');
    expect(cmd).toContain('signal');
    expect(cmd).not.toContain('plugin:signal@claude-plugins-official');
  }, 15000);

  test('registered marketplace passes through', async () => {
    const stateDir = stateDirWithEnv('discord');
    const config = { channels: { discord: { enabled: true, state_dir: stateDir } } };
    const { cmd } = await runBuildClaudeCommand(config, claudeMarketplaces([
      { name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official' },
    ]));
    expect(cmd).toContain('--channels');
    expect(cmd).toContain('plugin:discord@claude-plugins-official');
  }, 15000);

  test('unregistered marketplace warns and drops the channel', async () => {
    const stateDir = stateDirWithEnv('matrix');
    const config = {
      channels: {
        matrix: { enabled: true, state_dir: stateDir, marketplace: 'someone-fork' },
      },
    };
    const { cmd, out } = await runBuildClaudeCommand(config, claudeMarketplaces([
      { name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official' },
    ]));
    expect(cmd).not.toContain('plugin:matrix@someone-fork');
    expect(cmd).not.toContain('--channels');
    expect(out).toContain('matrix');
    expect(out).toContain('someone-fork');
    expect(out).toContain('not registered');
    expect(out).toContain('claude plugin marketplace add');
  }, 15000);

  test('unregistered marketplace with repo match redirects to registered name', async () => {
    const stateDir = stateDirWithEnv('matrix');
    const config = {
      channels: {
        matrix: { enabled: true, state_dir: stateDir, marketplace: 'someone/matrix-plugin' },
      },
    };
    const { cmd, out } = await runBuildClaudeCommand(config, claudeMarketplaces([
      { name: 'matrix-plugin-official', repo: 'someone/matrix-plugin' },
    ]));
    expect(cmd).not.toContain('plugin:matrix@someone/matrix-plugin');
    expect(out).toContain('matrix-plugin-official');
    expect(out.toLowerCase()).toContain('repo');
  }, 15000);

  test('channel starting with dash is dropped (looks like a CLI flag)', async () => {
    const stateDir = stateDirWithEnv('--evil');
    const config = { channels: { '--evil': { enabled: true, state_dir: stateDir } } };
    const { cmd, out } = await runBuildClaudeCommand(config, CLAUDE_FETCH_FAILS);
    expect(cmd).not.toContain('--evil');
    expect(cmd).not.toContain('--channels');
    expect(out).toContain('--evil');
    expect(out).toContain('-');
  }, 15000);
});

// ============================================================
// writeSettingsEnv + sandbox (TestWriteSettingsEnv)
// ============================================================

describe('writeSettingsEnv', () => {
  test('stale BOT_TOKEN vars in settings are cleaned up', () => {
    writeSettings({
      env: { DISCORD_BOT_TOKEN: 'stale-token', TELEGRAM_BOT_TOKEN: 'another-stale' },
    });
    writeConfig({});
    const config = loadConfig();
    captureLog(() => writeSettingsEnv(config));
    const settings = readSettings();
    expect(settings.env).not.toContainKey('DISCORD_BOT_TOKEN');
    expect(settings.env).not.toContainKey('TELEGRAM_BOT_TOKEN');
  });

  test('channel state_dir produces *_STATE_DIR in settings', () => {
    writeConfig({
      channels: { discord: { enabled: true, state_dir: '/tmp/test-discord' } },
    });
    const config = loadConfig();
    captureLog(() => writeSettingsEnv(config));
    expect(readSettings().env.DISCORD_STATE_DIR).toBe('/tmp/test-discord');
  });

  test('relative state_dir is expanded to absolute against cwd', () => {
    writeConfig({
      channels: { discord: { enabled: true, state_dir: '.claude.local/channels/discord' } },
    });
    const config = loadConfig();
    captureLog(() => writeSettingsEnv(config));
    const expected = path.join(process.cwd(), '.claude.local/channels/discord');
    expect(readSettings().env.DISCORD_STATE_DIR).toBe(expected);
  });

  test('invalid AGENT_HOOK_PROFILE defaults to standard in process env', () => {
    writeConfig({ env: { AGENT_HOOK_PROFILE: 'garbage' } });
    const config = loadConfig();
    delete process.env.AGENT_HOOK_PROFILE;
    captureLog(() => writeSettingsEnv(config));
    expect(profileEnv()).toBe('standard');
    expect(readSettings().env ?? {}).not.toContainKey('AGENT_HOOK_PROFILE');
  });

  test('always_on forces minimal profile up to standard in process env', () => {
    writeConfig({ always_on: true, env: { AGENT_HOOK_PROFILE: 'minimal' } });
    const config = loadConfig();
    expect(config.always_on).toBe(true);
    delete process.env.AGENT_HOOK_PROFILE;
    captureLog(() => writeSettingsEnv(config));
    expect(profileEnv()).toBe('standard');
    expect(readSettings().env ?? {}).not.toContainKey('AGENT_HOOK_PROFILE');
  });

  test('always_on does not downgrade strict to standard (floor, not ceiling)', () => {
    writeConfig({ always_on: true, env: { AGENT_HOOK_PROFILE: 'strict' } });
    const config = loadConfig();
    expect(config.always_on).toBe(true);
    delete process.env.AGENT_HOOK_PROFILE;
    captureLog(() => writeSettingsEnv(config));
    expect(profileEnv()).toBe('strict');
    expect(readSettings().env ?? {}).not.toContainKey('AGENT_HOOK_PROFILE');
  });

  test('pre-existing keys in settings.local.json survive write', () => {
    writeSettings({ env: { CUSTOM_VAR: 'keep-me' }, other_key: 'also-keep' });
    writeConfig({});
    const config = loadConfig();
    captureLog(() => writeSettingsEnv(config));
    const settings = readSettings();
    expect(settings.env.CUSTOM_VAR).toBe('keep-me');
    expect(settings.other_key).toBe('also-keep');
  });

  test('AGENT_HOOK_PROFILE is removed from settings.local.json (migration)', () => {
    writeSettings({ env: { AGENT_HOOK_PROFILE: 'strict', OTHER: 'keep' } });
    writeConfig({});
    const config = loadConfig();
    delete process.env.AGENT_HOOK_PROFILE;
    captureLog(() => writeSettingsEnv(config));
    const settings = readSettings();
    expect(settings.env).not.toContainKey('AGENT_HOOK_PROFILE');
    expect(settings.env.OTHER).toBe('keep');
  });
});

describe('applyArtifactGrant', () => {
  test('flag true + a page enabled writes Artifact allow + autoMode entries', () => {
    writeSettings({});
    captureLog(() => applyArtifactGrant({ artifacts: { dashboard: true, proposals: false, weekly_review: false, publish_authorized: true } }));
    const settings = readSettings();
    expect(settings.permissions.allow).toContain('Artifact');
    expect(settings.autoMode.allow[0]).toBe('$defaults');
    expect(settings.autoMode.allow.some((e: string) => e.includes('Operator policy, set at hatch'))).toBe(true);
    expect(settings.autoMode.environment[0]).toBe('$defaults');
  });

  test('flag null does nothing', () => {
    writeSettings({});
    applyArtifactGrant({ artifacts: { dashboard: true, publish_authorized: null } });
    expect(fs.readFileSync('.claude/settings.local.json', 'utf-8')).toBe('{}');
  });

  test('flag false does nothing', () => {
    writeSettings({});
    applyArtifactGrant({ artifacts: { dashboard: true, publish_authorized: false } });
    expect(fs.readFileSync('.claude/settings.local.json', 'utf-8')).toBe('{}');
  });

  test('flag true but all pages disabled does nothing', () => {
    writeSettings({});
    applyArtifactGrant({ artifacts: { dashboard: false, proposals: false, weekly_review: false, publish_authorized: true } });
    expect(fs.readFileSync('.claude/settings.local.json', 'utf-8')).toBe('{}');
  });

  test('is idempotent', () => {
    writeSettings({});
    const config = { artifacts: { dashboard: true, publish_authorized: true } };
    captureLog(() => applyArtifactGrant(config));
    const first = readSettings();
    captureLog(() => applyArtifactGrant(config));
    expect(readSettings()).toEqual(first);
  });

  test('heals after the settings file is wiped', () => {
    writeSettings({});
    const config = { artifacts: { dashboard: true, publish_authorized: true } };
    captureLog(() => applyArtifactGrant(config));
    fs.writeFileSync('.claude/settings.local.json', '{}');
    captureLog(() => applyArtifactGrant(config));
    const settings = readSettings();
    expect(settings.permissions.allow).toContain('Artifact');
    expect(settings.autoMode.allow.length).toBeGreaterThan(0);
  });
});

describe('writeSettingsEnv sandbox overlay', () => {
  test.skipIf(IN_CONTAINER)('`sandbox: null` in settings file does not crash writeSettingsEnv', () => {
    // is_container() must be false: rely on the host genuinely not being a
    // container (the env-var leg is cleared); skipped inside real containers.
    delete process.env.container;
    writeSettings({ sandbox: null });
    writeConfig({});
    const config = loadConfig();
    captureLog(() => writeSettingsEnv(config)); // should not throw
    expect(readSettings()).not.toContainKey('sandbox');
  });

  test('in-container boot strips obsolete enableWeakerNestedSandbox but never touches enabled', () => {
    process.env.container = 'docker';
    writeSettings({ sandbox: { enabled: true, enableWeakerNestedSandbox: true, allowUnsandboxedCommands: true } });
    writeConfig({});
    const config = loadConfig();
    captureLog(() => writeSettingsEnv(config));
    const settings = readSettings();
    expect(settings.sandbox.enabled).toBe(true); // operator/hatch intent untouched
    expect(settings.sandbox).not.toContainKey('enableWeakerNestedSandbox');
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(true); // operator keys preserved
  });

  test('in-container boot leaves an already-off sandbox off without re-adding weaker-nest', () => {
    process.env.container = 'docker';
    writeSettings({ sandbox: { enabled: false } });
    writeConfig({});
    const config = loadConfig();
    writeSettingsEnv(config);
    const settings = readSettings();
    expect(settings.sandbox.enabled).toBe(false);
    expect(settings.sandbox).not.toContainKey('enableWeakerNestedSandbox');
  });

  test.skipIf(IN_CONTAINER)('non-container boot removes enableWeakerNestedSandbox and preserves other sandbox keys', () => {
    delete process.env.container;
    writeSettings({
      sandbox: { enabled: true, allowUnsandboxedCommands: true, enableWeakerNestedSandbox: true },
    });
    writeConfig({});
    const config = loadConfig();
    captureLog(() => writeSettingsEnv(config));
    const settings = readSettings();
    expect(settings.sandbox).not.toContainKey('enableWeakerNestedSandbox');
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(true);
  });

  test.skipIf(IN_CONTAINER)('non-container boot removes the sandbox key entirely when only the managed key was set', () => {
    delete process.env.container;
    writeSettings({ sandbox: { enableWeakerNestedSandbox: true } });
    writeConfig({});
    const config = loadConfig();
    captureLog(() => writeSettingsEnv(config));
    expect(readSettings()).not.toContainKey('sandbox');
  });
});

// ============================================================
// Negative paths (TestNegativePaths)
// ============================================================

describe('negative paths', () => {
  test('invalid JSON in config.json throws', () => {
    fs.writeFileSync('.claude-code-hermit/config.json', '{bad json');
    expect(() => loadConfig()).toThrow(SyntaxError);
  });

  test('non-dict channels does not crash iterChannelConfigs', () => {
    expect([...iterChannelConfigs({ channels: 'string' })]).toEqual([]);
  });
});

// ============================================================
// PROP-018: always-on doctor schedule ratchet
// ============================================================

describe('applyAlwaysOnDoctorSchedule', () => {
  test('old (pre-clustering) weekly default ratchets to the new clustered daily', () => {
    const config = { routines: [{ id: 'doctor', schedule: '0 10 * * 1', enabled: true }] };
    applyAlwaysOnDoctorSchedule(config);
    expect(config.routines[0].schedule).toBe('10 9 * * *');
  });

  test('current (clustered) weekly default ratchets to daily', () => {
    const config = { routines: [{ id: 'doctor', schedule: '10 9 * * 1', enabled: true }] };
    applyAlwaysOnDoctorSchedule(config);
    expect(config.routines[0].schedule).toBe('10 9 * * *');
  });

  test('old (pre-clustering) daily default ratchets to the new clustered daily — fleet migration backstop', () => {
    // Live always-on hermits were already ratcheted to the OLD daily schedule by
    // a prior boot, before clustering existed. Without this case in the known-
    // defaults set, those hermits would read as "custom" and never re-cluster —
    // the primary migration path is the hermit-evolve Upgrade Instructions
    // (exact-match config.json rewrite); this ratchet is the deterministic
    // backstop for installs that skip that step.
    const config = { routines: [{ id: 'doctor', schedule: '0 10 * * *', enabled: true }] };
    applyAlwaysOnDoctorSchedule(config);
    expect(config.routines[0].schedule).toBe('10 9 * * *');
  });

  test('custom schedule is left untouched', () => {
    const config = { routines: [{ id: 'doctor', schedule: '30 6 * * 3', enabled: true }] };
    applyAlwaysOnDoctorSchedule(config);
    expect(config.routines[0].schedule).toBe('30 6 * * 3');
  });

  test('idempotent — running twice keeps daily', () => {
    const config = { routines: [{ id: 'doctor', schedule: '0 10 * * 1', enabled: true }] };
    applyAlwaysOnDoctorSchedule(config);
    applyAlwaysOnDoctorSchedule(config);
    expect(config.routines[0].schedule).toBe('10 9 * * *');
  });

  test('already at the new clustered daily schedule — idempotent no-op', () => {
    const config = { routines: [{ id: 'doctor', schedule: '10 9 * * *', enabled: true }] };
    applyAlwaysOnDoctorSchedule(config);
    expect(config.routines[0].schedule).toBe('10 9 * * *');
  });

  test('no doctor routine present does not throw', () => {
    const config = { routines: [{ id: 'reflect', schedule: '0 9 * * *', enabled: true }] };
    expect(() => applyAlwaysOnDoctorSchedule(config)).not.toThrow();
  });

  test('no routines array does not throw', () => {
    expect(() => applyAlwaysOnDoctorSchedule({})).not.toThrow();
  });
});

// ============================================================
// clearShutdownStampsOnBoot: a fresh hermit-start supersedes any prior
// shutdown intent left in runtime.json (e.g. from a nightly auto-close that
// isn't a real hermit-stop) — both preserve-branches in main() call this
// before writeRuntimeJson so watchdog restart/hygiene aren't bricked forever.
// ============================================================

describe('clearShutdownStampsOnBoot', () => {
  test('nulls both stamps when both were set', () => {
    const runtime = { session_state: 'idle', shutdown_requested_at: '2026-07-03T23:30:00Z', shutdown_completed_at: '2026-07-04T00:30:00Z' };
    clearShutdownStampsOnBoot(runtime);
    expect(runtime.shutdown_requested_at).toBeNull();
    expect(runtime.shutdown_completed_at).toBeNull();
  });

  test('nulls a lone shutdown_completed_at (the fleet pathology: auto-close without a matching request)', () => {
    const runtime = { session_state: 'idle', shutdown_requested_at: null, shutdown_completed_at: '2026-07-04T00:30:00Z' };
    clearShutdownStampsOnBoot(runtime);
    expect(runtime.shutdown_requested_at).toBeNull();
    expect(runtime.shutdown_completed_at).toBeNull();
  });

  test('leaves other fields untouched', () => {
    const runtime = { session_state: 'idle', session_id: 'S-030', shutdown_requested_at: null, shutdown_completed_at: '2026-07-04T00:30:00Z' };
    clearShutdownStampsOnBoot(runtime);
    expect(runtime.session_state).toBe('idle');
    expect(runtime.session_id).toBe('S-030');
  });

  test('no-op when both were already null', () => {
    const runtime = { session_state: 'idle', shutdown_requested_at: null, shutdown_completed_at: null };
    clearShutdownStampsOnBoot(runtime);
    expect(runtime.shutdown_requested_at).toBeNull();
    expect(runtime.shutdown_completed_at).toBeNull();
  });
});

// ============================================================
// clearStatusCacheOnBoot: an always-on boot drops the sessions/.status.json
// cost cache so the watchdog's idle-phase hygiene fallback can't resolve the
// defunct prior process's harness session (whose last cost entry predates the
// restart) and fire a spurious /compact or /clear into the fresh context.
// ============================================================

describe('clearStatusCacheOnBoot', () => {
  let dir: string;
  let origCwd: string;
  const statusPath = path.join('.claude-code-hermit', 'sessions', '.status.json');

  beforeEach(() => {
    origCwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-status-cache-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('removes an existing sessions/.status.json', () => {
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, JSON.stringify({ session_id: 'defunct-harness-uuid' }));
    clearStatusCacheOnBoot();
    expect(fs.existsSync(statusPath)).toBe(false);
  });

  test('no-op (no throw) when the cache does not exist', () => {
    expect(() => clearStatusCacheOnBoot()).not.toThrow();
  });
});

describe('hydrateSetupTokenEnv', () => {
  const VALID = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';
  let dir: string;
  let savedToken: string | undefined;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-token-env-'));
    savedToken = process.env[TOKEN_ENV_VAR];
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env[TOKEN_ENV_VAR];
    process.env.CLAUDE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env[TOKEN_ENV_VAR];
    else process.env[TOKEN_ENV_VAR] = savedToken;
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('exports an installed token into the environment', () => {
    fs.writeFileSync(path.join(dir, '.hermit-setup-token'), `${VALID}\n`, { mode: 0o600 });
    hydrateSetupTokenEnv();
    expect(process.env[TOKEN_ENV_VAR]).toBe(VALID);
  });

  test('no token installed → leaves the environment alone', () => {
    hydrateSetupTokenEnv();
    expect(process.env[TOKEN_ENV_VAR]).toBeUndefined();
  });

  // Matches the CLI's own precedence and lets an operator override the installed
  // token for a single boot without touching the file.
  test('an explicit env var wins over the installed file', () => {
    fs.writeFileSync(path.join(dir, '.hermit-setup-token'), `${VALID}\n`, { mode: 0o600 });
    process.env[TOKEN_ENV_VAR] = 'sk-ant-oat01-explicit-override-value-here';
    hydrateSetupTokenEnv();
    expect(process.env[TOKEN_ENV_VAR]).toBe('sk-ant-oat01-explicit-override-value-here');
  });

  // tmux spawns a shell that does NOT inherit this process's environment, so the
  // token only reaches claude if it is in the forwarded set. Dropping it from
  // that list would leave the token exported here and absent where it is used.
  test('the token var is forwarded into the tmux env-file', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'scripts', 'hermit-start.ts'), 'utf-8');
    const decl = src.slice(src.indexOf('const forwardVars ='));
    expect(decl.slice(0, decl.indexOf('\n'))).toContain('TOKEN_ENV_VAR');
  });
});
