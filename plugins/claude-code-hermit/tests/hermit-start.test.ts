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
//   - `_sandbox_probe_cached` / `subprocess.run` patches → a pre-seeded
//     state/sandbox-probe.json whose fingerprint is computed exactly the
//     way hermit-start.ts computes it.
//   - `sys.exit` / stdout capture → temporary process.exit / console.log
//     overrides (both are mutable harness objects, unlike module exports).
//
// CONFIG_PATH / STATE_DIR are relative string constants resolved against
// process.cwd() at CALL time (fs.* calls, not import-time path.resolve), so
// the Python tempdir-chdir pattern translates to process.chdir in
// beforeEach/afterEach with the original cwd restored.
//
// Usage: bun test tests/hermit-start.test.ts   (from the plugin root)

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  DEFAULT_CONFIG,
  loadConfig,
  getEnabledChannels,
  iterChannelConfigs,
  writeSettingsEnv,
  isSandboxEnabled,
  sandboxProbeCached,
  checkSandboxCapability,
  applyAlwaysOnDoctorSchedule,
} from '../scripts/hermit-start';

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

// ---------- sandbox-probe cache fingerprint (computed the way hermit-start.ts does) ----------

function pyFloatStr(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  return String(x);
}

function getmtimeStr(p: string): string {
  const ns = fs.statSync(p, { bigint: true }).mtimeNs;
  return pyFloatStr(Number(ns / 1_000_000_000n) + 1e-9 * Number(ns % 1_000_000_000n));
}

function realFingerprint(): string {
  const bwrapPath = Bun.which('bwrap') || '';
  const socatPath = Bun.which('socat') || '';
  let bwrapMtime = '';
  let socatMtime = '';
  try {
    bwrapMtime = bwrapPath ? getmtimeStr(bwrapPath) : '';
    socatMtime = socatPath ? getmtimeStr(socatPath) : '';
  } catch {
    bwrapMtime = socatMtime = '';
  }
  const fpRaw = `${os.release()}|${bwrapPath}|${bwrapMtime}|${socatPath}|${socatMtime}`;
  return createHash('sha1').update(fpRaw).digest('hex').slice(0, 16);
}

const PROBE_CACHE = '.claude-code-hermit/state/sandbox-probe.json';

function seedProbeCache(result: any, fingerprint: string = realFingerprint()): void {
  fs.writeFileSync(PROBE_CACHE, JSON.stringify({ fingerprint, result }));
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
    writeConfig({ env: { COMPACT_THRESHOLD: '100' } });
    const merged = loadConfig();
    expect(merged.env.COMPACT_THRESHOLD).toBe('100');
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

describe('isSandboxEnabled', () => {
  test('settings.local.json enabled=false overrides settings.json enabled=true', () => {
    writeSettings({ sandbox: { enabled: false } });
    fs.writeFileSync('.claude/settings.json', JSON.stringify({ sandbox: { enabled: true } }));
    expect(isSandboxEnabled()).toBe(false);
  });

  test('settings.local.json enabled=true is used when settings.json is absent', () => {
    writeSettings({ sandbox: { enabled: true } });
    expect(isSandboxEnabled()).toBe(true);
  });

  test('`sandbox: null` in settings file does not crash; treated as undeclared', () => {
    writeSettings({ sandbox: null });
    expect(isSandboxEnabled()).toBe(false);
  });

  test('`enabled: "false"` (string) is not coerced — treated as undeclared', () => {
    writeSettings({ sandbox: { enabled: 'false' } });
    expect(isSandboxEnabled()).toBe(false);
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

  test('checkSandboxCapability returns immediately inside a container without probing', () => {
    // mock_probe.assert_not_called() replacement: seed a cache that WOULD
    // produce a warning if the probe path ran (fail status, matching
    // fingerprint). The container short-circuit must produce no output.
    process.env.container = 'docker';
    writeSettings({ sandbox: { enabled: true } });
    writeConfig({});
    seedProbeCache({ status: 'fail', message: 'SHOULD-NOT-PRINT', install_hint: 'X' });
    const { out } = captureLog(() => checkSandboxCapability());
    expect(out).toBe('');
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

describe('sandboxProbeCached', () => {
  test('a cached probe with matching fingerprint short-circuits probe invocation', () => {
    // mock_run.assert_not_called() replacement: the seeded result carries a
    // message ('cached') the real probe never emits, and a cache hit never
    // rewrites the file — so getting it back proves no subprocess ran.
    const before = JSON.stringify({
      fingerprint: realFingerprint(),
      result: { status: 'pass', message: 'cached' },
    });
    fs.writeFileSync(PROBE_CACHE, before);

    const result = sandboxProbeCached();
    expect(result).toEqual({ status: 'pass', message: 'cached' });
    expect(fs.readFileSync(PROBE_CACHE, 'utf-8')).toBe(before);
  });

  test('a missing cache file triggers probe invocation and writes a fresh cache', () => {
    // The Python test faked subprocess.run to return status=pass; here the
    // REAL sandbox-probe.ts runs (it always exits 0 with a JSON dict), so we
    // pin the cache-write contract without pinning the machine's probe verdict.
    expect(fs.existsSync(PROBE_CACHE)).toBe(false);

    const result = sandboxProbeCached();
    expect(result).not.toBeNull();
    expect(typeof result.status).toBe('string');
    expect(['pass', 'warn', 'fail']).toContain(result.status);
    expect(fs.existsSync(PROBE_CACHE)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(PROBE_CACHE, 'utf-8'));
    expect(cached).toContainKey('fingerprint');
    expect(cached.result).toEqual(result);
  }, 15000);

  test('a cache file with a non-dict result is treated as a miss and the probe re-runs', () => {
    seedProbeCache('corrupted-string');

    const result = sandboxProbeCached();
    expect(result).not.toBe('corrupted-string' as any);
    expect(result).not.toBeNull();
    expect(typeof result.status).toBe('string');
    const cached = JSON.parse(fs.readFileSync(PROBE_CACHE, 'utf-8'));
    expect(typeof cached.result).toBe('object');
    expect(cached.result).toEqual(result);
  }, 15000);
});

describe('checkSandboxCapability warnings', () => {
  test.skipIf(IN_CONTAINER)('when sandbox enabled and probe fails, the warning + install hint are printed', () => {
    // _sandbox_probe_cached patch replacement: pre-seed the cache with a
    // matching fingerprint so the fake probe result is served from disk.
    delete process.env.container;
    writeSettings({ sandbox: { enabled: true } });
    seedProbeCache({
      status: 'fail',
      message: 'Missing: bwrap, socat.',
      install_hint: 'apt-get install -y bubblewrap socat',
    });
    const { out } = captureLog(() => checkSandboxCapability());
    expect(out).toContain('Warning: sandbox enabled');
    expect(out).toContain('Missing: bwrap, socat.');
    expect(out).toContain('apt-get install -y bubblewrap socat');
  });

  test('probe warn message references AppArmor for Ubuntu 24.04 (not kernel.userns_restrict)', () => {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'sandbox-probe.ts'), 'utf-8');
    expect(src).toContain('AppArmor');
    expect(src).not.toContain('kernel.userns' + '_restrict');
  });

  test.skipIf(IN_CONTAINER)('a warn-status probe surfaces the message; install_hint may be absent', () => {
    delete process.env.container;
    writeSettings({ sandbox: { enabled: true } });
    seedProbeCache({ status: 'warn', message: 'user-namespaces disabled.', install_hint: null });
    const { out } = captureLog(() => checkSandboxCapability());
    expect(out).toContain('user-namespaces disabled.');
    // No "Fix:" line when install_hint is null.
    expect(out).not.toContain('Fix:');
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
  test('weekly template default ratchets to daily', () => {
    const config = { routines: [{ id: 'doctor', schedule: '0 10 * * 1', enabled: true }] };
    applyAlwaysOnDoctorSchedule(config);
    expect(config.routines[0].schedule).toBe('0 10 * * *');
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
    expect(config.routines[0].schedule).toBe('0 10 * * *');
  });

  test('no doctor routine present does not throw', () => {
    const config = { routines: [{ id: 'reflect', schedule: '0 9 * * *', enabled: true }] };
    expect(() => applyAlwaysOnDoctorSchedule(config)).not.toThrow();
  });

  test('no routines array does not throw', () => {
    expect(() => applyAlwaysOnDoctorSchedule({})).not.toThrow();
  });
});
