#!/usr/bin/env bun
/**
 * Boot script for hermit autonomous sessions.
 *
 * Reads .claude-code-hermit/config.json and starts Claude Code
 * in a tmux session with the configured channels and options.
 *
 * Usage:
 *     bun scripts/hermit-start.ts              # from project root
 *     bun scripts/hermit-start.ts --no-tmux    # run in current terminal
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireLock, releaseLock } from './lib/lockfile';
import { writeRuntimeJson, readRuntimeJson, STATE_DIR, RUNTIME_JSON, RUNTIME_TMP, LIFECYCLE_LOCK } from './lib/runtime';
import { localISOStamp } from './lib/time';
import { tmuxSessionAlive, getSessionName } from './lib/tmux';

type Json = any;

const CONFIG_PATH = '.claude-code-hermit/config.json';
const PROFILE_LEVELS: Record<string, number> = { minimal: 0, standard: 1, strict: 2 };

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

const DEFAULT_CONFIG: Json = {
  _hermit_versions: {},
  agent_name: null,
  language: null,
  timezone: null,
  escalation: 'balanced',
  sign_off: null,
  channels: {},
  remote: true,
  model: 'sonnet',
  permission_mode: 'auto',
  tmux_session_name: 'hermit-{project_name}',
  auto_session: true,
  always_on: false,
  chrome: false,
  push_notifications: true,
  ask_gate: true,
  idle_behavior: 'discover',
  routines: [
    { id: 'heartbeat-restart', schedule: '0 4 * * *', skill: 'claude-code-hermit:heartbeat start', run_during_waiting: true, enabled: true },
    { id: 'reflect', schedule: '0 9 * * *', skill: 'claude-code-hermit:reflect', enabled: true },
    { id: 'scheduled-checks', schedule: '5 9 * * *', skill: 'claude-code-hermit:reflect --scheduled-checks', run_during_waiting: true, enabled: true },
    { id: 'weekly-review', schedule: '0 23 * * 0', skill: 'claude-code-hermit:weekly-review', enabled: true },
    { id: 'daily-auto-close', schedule: '0 0 * * *', skill: 'claude-code-hermit:session-close --scheduled', model: 'haiku', run_during_waiting: true, enabled: true },
    { id: 'doctor', schedule: '10 9 * * 1', skill: 'claude-code-hermit:hermit-doctor', model: 'haiku', run_during_waiting: true, enabled: true },
  ],
  monitors: [],
  env: {
    AGENT_HOOK_PROFILE: 'standard',
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '65',
    MAX_THINKING_TOKENS: '10000',
  },
  boot_skill: null,
  shutdown_skill: null,
  scheduled_checks: [],
  docker: {
    packages: [],
    recommended_plugins: [],
  },
  compact: {
    monitoring_threshold: 30,
    monitoring_keep: 20,
    summary_threshold: 30,
    summary_keep: 15,
  },
  heartbeat: {
    enabled: true,
    every: '2h',
    active_hours: {
      start: '08:00',
      end: '23:00',
    },
    stale_threshold: '2h',
    waiting_timeout: null,
    clean_recheck_cooldown: '6h',
    model: 'haiku',
  },
  quality_gate: {
    tier: 'budget',
  },
  knowledge: {
    raw_retention_days: 14,
    compiled_budget_chars: 2500,
    working_set_warn: 20,
    archive_retention_days: null,
    channel_log_enabled: true,
    channel_log_retention_days: 90,
  },
  watchdog: {
    enabled: false,
    stale_factor: 2,
    escalate_after: 3,
    operator_grace: '15m',
    context_clear_tokens: 700000,
  },
  budget: {
    daily_usd: null,
    weekly_usd: null,
    monthly_usd: null,
    action: 'alert',
  },
  telemetry_export: {
    _note: 'Operator-directed health/cost export to your own webhook. Inert until you set destination.url. Never sent to plugin authors.',
    enabled: false,
    destination: { type: 'webhook', url: null, bearer_env: 'HERMIT_TELEMETRY_TOKEN' },
    interval_hours: 24,
    redact_operator_text: true,
  },
  artifacts: {
    dashboard: true,
    proposals: true,
    weekly_review: true,
    publish_authorized: null,
  },
  context_hygiene: {
    compact: {
      enabled: true,
      min_context_tokens: 150000,
      min_interval: '4h',
    },
  },
  reflection: {
    graduation_min_sessions: 1,
  },
  routine_wake_lint: {
    max_windows: 6,
  },
  doctor: {
    routine_cost_floor_usd: 2,
  },
  storage_drift: {
    ignore: [],
  },
  post_close_clear: true,
};

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/** Python-style truthiness: empty arrays/objects/strings are falsy. */
function pyTruthy(v: Json): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

function isDict(v: Json): boolean {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Python shlex.quote: safe chars pass through, everything else single-quoted. */
function shlexQuote(s: string): string {
  if (s === '') return "''";
  if (!/[^A-Za-z0-9_@%+=:,./-]/.test(s)) return s;
  return "'" + s.replaceAll("'", "'\"'\"'") + "'";
}

/** Join args into a shell-safe string using shlexQuote. */
function shlexJoin(args: string[]): string {
  return args.map(shlexQuote).join(' ');
}

/** Load config.json or return defaults. */
function loadConfig(): Json {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`[hermit] No config found at ${CONFIG_PATH}`);
    console.log('[hermit] Run /claude-code-hermit:hatch inside Claude Code first.');
    process.exit(1);
  }

  const config: Json = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

  // Merge with defaults — shallow for top-level, deep for nested dicts.
  // Values in config may be null (JSON null), so fall back to {} for spreading.
  const merged: Json = { ...DEFAULT_CONFIG, ...config };
  for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
    if (isDict(def)) {
      merged[key] = { ...(def as Json), ...(config[key] || {}) };
    }
  }
  // One more level for heartbeat.active_hours
  if ('active_hours' in (DEFAULT_CONFIG.heartbeat ?? {})) {
    const mergedHb = merged.heartbeat ?? {};
    mergedHb.active_hours = {
      ...DEFAULT_CONFIG.heartbeat.active_hours,
      ...((config.heartbeat || {}).active_hours || {}),
    };
    merged.heartbeat = mergedHb;
  }
  return merged;
}

// One-way ratchet: an always-on boot upgrades a template-default weekly doctor
// schedule to daily. Only touches the entry if it's still at a KNOWN default —
// a custom schedule the operator set is left alone. Does not downgrade back to
// weekly on stop; a box that reverts to interactive keeps daily doctor, which
// is harmless.
//
// The set has three entries, not one, because it must recognize schedules from
// every prior template generation: '0 10 * * 1' is the pre-clustering weekly
// default, '10 9 * * 1' is the current (clustered) weekly default, and
// '0 10 * * *' is what THIS ratchet itself already wrote for any hermit that
// went always-on before clustering shipped — those live fleet hermits are the
// primary reason for the entry, since without it they'd read as "custom" and
// never pick up the clustered daily schedule (the CHANGELOG's evolve-time
// migration is the primary path for already-installed hermits; this ratchet is
// the deterministic backstop for installs that skip that step, or that switch
// from interactive to always-on later).
const KNOWN_DEFAULT_SCHEDULES = ['0 10 * * 1', '10 9 * * 1', '0 10 * * *'];
const DOCTOR_DAILY_SCHEDULE = '10 9 * * *';

function applyAlwaysOnDoctorSchedule(config: Json): void {
  const routine = Array.isArray(config.routines)
    ? config.routines.find((r: Json) => r?.id === 'doctor')
    : null;
  if (routine && KNOWN_DEFAULT_SCHEDULES.includes(routine.schedule)) {
    routine.schedule = DOCTOR_DAILY_SCHEDULE;
  }
}

/** Print a notice if the plugin version is newer than config version. */
function checkForUpgrade(config: Json): void {
  const pluginJson = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
  try {
    const pluginVer = JSON.parse(fs.readFileSync(pluginJson, 'utf-8')).version ?? '0.0.0';
    const configVer = (config._hermit_versions ?? {})['claude-code-hermit'] ?? '0.0.0';
    if (pluginVer !== configVer) {
      console.log(`[hermit] Upgrade available: v${configVer} -> v${pluginVer}`);
      console.log('[hermit] Run /claude-code-hermit:hermit-evolve inside Claude Code');
    }
  } catch {}
}

/** Parse up to the first three dot-separated version parts as integers (null on garbage). */
function parseVersionTuple(v: string): number[] | null {
  const nums: number[] = [];
  for (const p of v.split('.').slice(0, 3)) {
    if (!/^\d+$/.test(p.trim())) return null; // Python int() would raise ValueError
    nums.push(parseInt(p, 10));
  }
  return nums;
}

/** Python tuple comparison: element-wise, shorter prefix sorts first. */
function versionLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/** Check that required tools are available. */
function checkPrerequisites(): Json {
  const errors: string[] = [];

  // Claude Code
  if (!Bun.which('claude')) {
    errors.push('claude: Claude Code CLI not found. Install from https://claude.ai/download');
  }

  // tmux (optional but recommended)
  const hasTmux = Bun.which('tmux') !== null;

  // bun (required runtime for hooks/scripts since the bun migration)
  const hasBun = Bun.which('bun') !== null;
  if (!hasBun) {
    errors.push('bun: required runtime not found. Install: curl -fsSL https://bun.sh/install | bash');
  } else {
    // Already running under bun, so Bun.version is a free in-process probe.
    const bunVersion = Bun.version.trim();
    let required = '1.3.0';
    try {
      const metaPath = path.join(PLUGIN_ROOT, '.claude-plugin', 'hermit-meta.json');
      const declared = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).required_bun_version;
      if (pyTruthy(declared)) required = String(declared).replace(/^[>=]+/, '').trim();
    } catch {} // unreadable meta — fall back to the baseline floor
    const cur = parseVersionTuple(bunVersion);
    const req = parseVersionTuple(required);
    // unparseable version — don't block boot on the probe itself
    if (cur && req && versionLess(cur, req)) {
      errors.push(`bun: version ${bunVersion} below required ${required}. Upgrade: bun upgrade`);
    }
  }

  if (errors.length) {
    for (const err of errors) console.log(`[hermit] ERROR: ${err}`);
    process.exit(1);
  }

  return { tmux: hasTmux, bun: hasBun };
}

/** Detect if running inside a container (Docker, Podman, LXC). */
function isContainer(): boolean {
  return (
    fs.existsSync('/.dockerenv') ||
    fs.existsSync('/run/.containerenv') ||
    process.env.container === 'docker'
  );
}

/**
 * Return true if the effective sandbox.enabled state is true.
 *
 * Respects Claude Code's merge order: settings.local.json overrides settings.json.
 * The last file that explicitly declares sandbox.enabled wins. Non-bool values
 * (e.g., the string "false") are treated as undeclared, not coerced via Boolean().
 */
function isSandboxEnabled(): boolean {
  let result: boolean | null = null;
  for (const p of ['.claude/settings.json', '.claude/settings.local.json']) {
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!isDict(s)) continue;
      const sandbox = s.sandbox || {};
      if (!isDict(sandbox)) continue;
      if ('enabled' in sandbox && typeof sandbox.enabled === 'boolean') {
        result = sandbox.enabled;
      }
    } catch {}
  }
  return result === true;
}

/** Python str(float) for st_mtime: integral floats render with a trailing '.0'. */
function pyFloatStr(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  return String(x);
}

/** Python str(os.path.getmtime(p)): st_mtime is computed as sec + 1e-9 * nsec. */
function getmtimeStr(p: string): string {
  const ns = fs.statSync(p, { bigint: true }).mtimeNs;
  const sec = Number(ns / 1_000_000_000n);
  const nsec = Number(ns % 1_000_000_000n);
  return pyFloatStr(sec + 1e-9 * nsec);
}

/** Run sandbox-probe.ts (via bun); cache result keyed on a system fingerprint. */
function sandboxProbeCached(): Json | null {
  const probeCache = path.join(STATE_DIR, 'sandbox-probe.json');
  const probeScript = path.join(PLUGIN_ROOT, 'scripts', 'sandbox-probe.ts');
  if (!fs.existsSync(probeScript)) return null;

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
  const fingerprint = createHash('sha1').update(fpRaw).digest('hex').slice(0, 16);

  try {
    const cached = JSON.parse(fs.readFileSync(probeCache, 'utf-8'));
    if (cached.fingerprint === fingerprint) {
      const cachedResult = cached.result;
      if (isDict(cachedResult)) return cachedResult;
      // Corrupted cache (non-dict result) — fall through to re-probe.
    }
  } catch {}

  let result: Json;
  try {
    const out = spawnSync('bun', [probeScript], { timeout: 10_000, encoding: 'utf-8' });
    if (out.status !== 0) return null;
    result = JSON.parse(out.stdout);
    if (!isDict(result)) return null;
  } catch {
    return null;
  }

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(probeCache, JSON.stringify({ fingerprint, result }));
  } catch {}

  return result;
}

/**
 * Warn to stdout if sandbox is enabled but deps are unavailable.
 *
 * Skipped inside containers: the container is the isolation boundary, so there is
 * nothing to warn about (and probing would always fail in unprivileged containers).
 */
function checkSandboxCapability(): void {
  if (!isSandboxEnabled()) return;
  if (isContainer()) return;
  const probe = sandboxProbeCached();
  if (!pyTruthy(probe) || probe.status === 'pass') return;
  const msg = 'message' in probe ? probe.message : 'Sandbox may not start.';
  console.log(`[hermit] Warning: sandbox enabled but: ${msg}`);
  const hint = probe.install_hint;
  if (pyTruthy(hint)) console.log(`[hermit] Fix: ${hint}`);
}

/** Check for stale runtime state from a previous run and warn. */
function checkStaleRuntime(config: Json, sessionName: string): void {
  const runtime = readRuntimeJson();
  if (runtime === null) return;

  const state = runtime.session_state;
  const mode = runtime.runtime_mode;
  const shutdownCompleted = runtime.shutdown_completed_at;

  if (['in_progress', 'waiting', 'suspect_process'].includes(state)) {
    if (mode === 'tmux' || mode === 'docker') {
      // Check if the tmux session from the previous run still exists
      const prevTmux = 'tmux_session' in runtime ? runtime.tmux_session : '';
      if (!tmuxSessionAlive(prevTmux)) {
        console.log(
          `[hermit] Warning: Previous session crashed (runtime.json says ${state}, tmux session "${prevTmux}" is gone).`,
        );
        console.log('[hermit] /session-start will offer recovery.');
        runtime.last_error = 'unclean_shutdown';
        writeRuntimeJson(runtime);
      }
    } else if (mode === 'interactive' && !pyTruthy(shutdownCompleted)) {
      console.log('[hermit] Warning: Previous interactive session did not close cleanly.');
      console.log('[hermit] /session-start will offer recovery.');
      runtime.last_error = 'unclean_shutdown';
      writeRuntimeJson(runtime);
    }
  }

  if (runtime.last_error === 'session_died_on_boot') {
    console.log('[hermit] Note: previous start failed (tmux session died on boot).');
  }

  // Check for interrupted transitions
  const transition = runtime.transition;
  if (pyTruthy(transition)) {
    const target = 'transition_target' in runtime ? runtime.transition_target : 'unknown';
    console.log(`[hermit] Warning: Interrupted transition detected: ${transition} (target: ${target})`);
    console.log('[hermit] /session-start will resume or clean up.');
  }
}

/**
 * Clears shutdown_requested_at/shutdown_completed_at on an existing runtime.json
 * before a fresh hermit-start boot. A deliberate start supersedes any prior
 * shutdown intent — a stamp left over from a non-hermit-stop close (a nightly
 * auto-close reusing /session-close's "Full Shutdown" framing while the always-on
 * process stays alive) otherwise bricks watchdog restart recovery AND
 * context-hygiene compaction/clear forever, since passesLifecycleGuards treats any
 * non-null stamp as "the hermit is stopping". Mutates `existing` in place.
 */
function clearShutdownStampsOnBoot(existing: Json): void {
  existing.shutdown_requested_at = null;
  existing.shutdown_completed_at = null;
}

/**
 * Removes the sessions/.status.json cost cache on an always-on boot. cost-tracker
 * writes the current harness session id there each turn, and the watchdog's idle-phase
 * hygiene fallback (resolveHygieneSessionId) reads it when no S-NNN arc is open. Across
 * a restart the harness session id changes, but the old file survives until the first
 * post-boot turn rewrites it — a stale pointer that would make the watchdog resolve the
 * DEFUNCT prior session's last (possibly bloated) cost entry and fire a spurious /compact
 * or /clear into the fresh, near-empty context. Removing it here makes the fallback
 * return "no session id" (a clean skip) until a real turn re-populates it. cost-tracker
 * treats a missing file as first-run and rebuilds cumulative totals from the index, so
 * nothing is lost.
 *
 * The watchdog also imports this and calls it mid-run at context-reset time (post-close
 * and emergency /clear in hermit-watchdog.ts) for the same reason: once /clear destroys a
 * context, its last cost entry is stale, and the same fallback must not resolve it into a
 * spurious /compact against the fresh context.
 */
function clearStatusCacheOnBoot(): void {
  try { fs.unlinkSync(path.join(STATE_DIR, '..', 'sessions', '.status.json')); } catch {}
}

/**
 * Stamps a fresh per-process nonce at state/.boot-id on every always-on boot.
 * cron-registry.ts (the hermit-routines diff planner) compares this against the
 * boot_id stored in its state/cron-registry.json mirror: a mismatch means the
 * mirror describes a prior process's CronCreates, which durable:false already
 * killed on exit, so the planner treats every enabled routine as CREATE with no
 * matching DELETE (nothing live to tear down). Written unconditionally, before
 * hermit-routines load's first run, so the very first load after boot always
 * sees a mismatch and does a full (and correct) re-registration.
 */
function writeBootId(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, '.boot-id'), randomUUID() + '\n');
  } catch {}
}

/** Acquire exclusive lifecycle lock. Exits on contention. */
function acquireLifecycleLock(): void {
  if (process.platform === 'win32') {
    console.log('[hermit] Always-on mode requires Linux, macOS, or WSL2. See https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/faq.md.');
    process.exit(1);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!acquireLock(LIFECYCLE_LOCK)) {
    console.log('[hermit] Another lifecycle operation in progress. Aborting.');
    process.exit(1);
  }
  // The Python flock released automatically on process death (and on exec,
  // via O_CLOEXEC). The link-based lock needs an explicit unlink — release
  // it on every exit path, including the process.exit() calls sprinkled
  // through boot.
  process.on('exit', () => releaseLock(LIFECYCLE_LOCK));
}

const CHANNEL_PLUGINS: Record<string, string> = {
  discord: 'plugin:discord@claude-plugins-official',
  telegram: 'plugin:telegram@claude-plugins-official',
  imessage: 'plugin:imessage@claude-plugins-official',
};

/**
 * Return registered marketplaces as [{name: string, repo: string|null}, ...].
 *
 * Returns null when the call fails or the output is unrecognized — caller
 * must treat null as "skip pre-flight" (fail-soft). A returned list (even
 * empty) means the check ran and is authoritative.
 */
function fetchRegisteredMarketplaces(): Json[] | null {
  try {
    const result = spawnSync('claude', ['plugin', 'marketplace', 'list', '--json'], {
      timeout: 10_000,
      encoding: 'utf-8',
    });
    if (result.status !== 0) return null;
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data)) return null;
    const entries: Json[] = [];
    for (const item of data) {
      if (isDict(item) && typeof item.name === 'string') {
        entries.push({
          name: item.name,
          repo: typeof item.repo === 'string' ? item.repo : null,
        });
      }
    }
    return entries;
  } catch {
    return null;
  }
}

/** Yield [name, cfg] for channels whose config is a valid dict. */
function* iterChannelConfigs(config: Json): Generator<[string, Json]> {
  const channels = 'channels' in config ? config.channels : {};
  if (!isDict(channels)) return;
  for (const [name, cfg] of Object.entries(channels)) {
    if (isDict(cfg)) yield [name, cfg];
  }
}

/** Return list of enabled channel names. */
function getEnabledChannels(config: Json): string[] {
  const names: string[] = [];
  for (const [name, cfg] of iterChannelConfigs(config)) {
    if (pyTruthy('enabled' in cfg ? cfg.enabled : true)) names.push(name);
  }
  return names;
}

/** Resolve a state_dir path (absolute pass-through, relative against cwd). */
function resolveStateDir(stateDir: string): string {
  return path.isAbsolute(stateDir) ? stateDir : path.join(process.cwd(), stateDir);
}

/** Read one line from stdin (Python input(): prompt to stdout, EOF → ''). */
function inputLine(promptText: string): string {
  process.stdout.write(promptText);
  const buf = Buffer.alloc(1);
  let line = '';
  try {
    while (true) {
      const n = fs.readSync(0, buf, 0, 1, null);
      if (n === 0) break; // EOF
      const ch = buf.toString('utf-8', 0, n);
      if (ch === '\n') break;
      line += ch;
    }
  } catch {
    return ''; // unreadable stdin — Python raises EOFError, caller used ''
  }
  return line;
}

/** Build the claude launch command from config. */
function buildClaudeCommand(config: Json, tools: Json): string[] {
  const cmd = ['claude'];

  let enabledChannels = getEnabledChannels(config);
  if (enabledChannels.length) {
    // Bun is required for all channel plugins.
    if (!pyTruthy(tools.bun)) {
      const names = enabledChannels.join(', ');
      console.log(`[hermit] WARNING: channels skipped (${names}) — bun is not installed.`);
      console.log('[hermit]   Install bun: https://bun.sh');
      console.log('[hermit]   Then run /claude-code-hermit:channel-setup to activate.');
      enabledChannels = [];
    }

    const activeChannels: string[] = [];
    for (const [channel, chCfg] of iterChannelConfigs(config)) {
      if (!enabledChannels.includes(channel)) continue;

      // Warn if the token file is missing — still add the channel so the
      // plugin can surface its own auth error.
      const stateDir = 'state_dir' in chCfg ? chCfg.state_dir : `.claude.local/channels/${channel}`;
      if (!fs.existsSync(path.join(resolveStateDir(stateDir), '.env'))) {
        console.log(`[hermit] WARNING: channel "${channel}" has no token configured.`);
        console.log('[hermit]   Run /claude-code-hermit:channel-setup to add it.');
      }

      activeChannels.push(channel);
    }

    if (activeChannels.length) {
      const channelCfgs: Json = Object.fromEntries(iterChannelConfigs(config));
      const registered = fetchRegisteredMarketplaces(); // null = skip pre-flight
      const registeredNames = new Set((registered ?? []).map((e: Json) => e.name));

      const channelArgs: string[] = [];
      for (const channel of activeChannels) {
        let pluginId: string | undefined = CHANNEL_PLUGINS[channel];
        if (!pluginId) {
          // Fall back to channels.<name>.marketplace for third-party channel
          // plugins (custom marketplaces, forks, operator-built channels).
          const marketplace = (channelCfgs[channel] ?? {}).marketplace;
          if (pyTruthy(marketplace)) {
            pluginId = `plugin:${channel}@${marketplace}`;
          }
        }

        if (pluginId) {
          if (registered !== null) {
            const at = pluginId.indexOf('@');
            const marketplaceName = at !== -1 ? pluginId.slice(at + 1) : '';
            if (at !== -1 && marketplaceName) {
              if (!registeredNames.has(marketplaceName)) {
                const repoMatch = registered.find((e: Json) => e.repo === marketplaceName) ?? null;
                if (repoMatch) {
                  console.log(
                    `[hermit] WARNING: channel "${channel}" — "${marketplaceName}" is a repo path, not a marketplace name.`,
                  );
                  console.log(`[hermit]   That repo IS registered as "${repoMatch.name}".`);
                  console.log(
                    `[hermit]   Fix: set channels.${channel}.marketplace = "${repoMatch.name}" in config.json`,
                  );
                } else {
                  console.log(
                    `[hermit] WARNING: channel "${channel}" — marketplace "${marketplaceName}" is not registered with claude.`,
                  );
                  console.log('[hermit]   Fix: claude plugin marketplace add <repo>');
                }
                console.log(
                  `[hermit]   Dropping "${channel}" from --channels to avoid silent boot with no channels active.`,
                );
                continue;
              }
            }
          }
          channelArgs.push(pluginId);
        } else {
          if (channel.startsWith('-')) {
            console.log(
              `[hermit] WARNING: channel "${channel}" starts with "-" — refusing to pass as a bare arg (looks like a CLI flag).`,
            );
            continue;
          }
          console.log(
            `[hermit] WARNING: unrecognized channel "${channel}" — expected discord, telegram, or imessage (or set channels.${channel}.marketplace in config.json)`,
          );
          channelArgs.push(channel);
        }
      }

      if (channelArgs.length) {
        cmd.push('--channels', ...channelArgs);
      }
    }
  }

  // Add remote control for web/mobile access (with session name)
  if (pyTruthy('remote' in config ? config.remote : false)) {
    const remoteName = config.agent_name || getSessionName(config);
    cmd.push('--remote-control', remoteName);
  }

  if (pyTruthy(config.chrome)) {
    if (isContainer()) {
      console.log('[hermit] WARNING: chrome=true ignored — browser not available in containers.');
    } else {
      cmd.push('--chrome');
    }
  }

  if (pyTruthy(config.model)) {
    cmd.push('--model', config.model);
  }

  const mode = 'permission_mode' in config ? config.permission_mode : 'auto';
  if (mode === 'bypassPermissions') {
    if (!isContainer()) {
      console.log('[hermit] WARNING: bypassPermissions is intended for containers/VMs only.');
      console.log('[hermit] You appear to be running on a host machine.');
      const answer = inputLine('[hermit] Continue anyway? [y/N] ').trim().toLowerCase();
      if (answer !== 'y') {
        console.log('[hermit] Aborted. Change permission_mode in config.json or use a container.');
        process.exit(1);
      }
    }
    cmd.push('--dangerously-skip-permissions');
  } else if (['acceptEdits', 'plan', 'dontAsk', 'auto'].includes(mode)) {
    cmd.push('--permission-mode', mode);
  } else if (mode !== 'default' && mode !== null) {
    console.log(`[hermit] WARNING: unknown permission_mode "${mode}" — skipping (using default)`);
  }

  return cmd;
}

/**
 * Write config env vars to .claude/settings.local.json.
 *
 * Claude Code reads the `env` key from settings.json and exports those
 * values to all subprocesses (hooks, MCP servers, Bash tool calls).
 * This is the canonical way to set env vars per the official docs.
 *
 * Auth vars (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR) are NOT written here —
 * they must be in the shell env before claude launches. OAuth credentials
 * live in .credentials.json (written by `claude /login`).
 */
function writeSettingsEnv(config: Json): void {
  const settingsPath = '.claude/settings.local.json';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  let settings: Json;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    settings = {};
  }

  if (!('env' in settings)) settings.env = {};

  const envVars: Json = { ...('env' in config ? config.env : {}) }; // copy — don't mutate config

  // AGENT_HOOK_PROFILE is process-scoped: forwarded via tmux env file or
  // docker-compose environment block. NOT written to settings.local.json,
  // which is shared between container and host via bind mount.
  let profile = envVars.AGENT_HOOK_PROFILE;
  delete envVars.AGENT_HOOK_PROFILE;
  profile = profile || (process.env.AGENT_HOOK_PROFILE ?? 'standard');
  if (!(profile in PROFILE_LEVELS)) {
    console.log(`[hermit] Warning: invalid AGENT_HOOK_PROFILE=${profile}, defaulting to standard`);
    profile = 'standard';
  }
  if (pyTruthy(config.always_on)) {
    const floor = 'standard'; // non-negotiable minimum for always-on
    if (PROFILE_LEVELS[profile] < PROFILE_LEVELS[floor]) {
      console.log(
        `[hermit] Warning: AGENT_HOOK_PROFILE=${profile} below always-on floor, forcing to ${floor}`,
      );
      profile = floor;
    }
  }
  if (process.env.AGENT_HOOK_PROFILE === undefined) process.env.AGENT_HOOK_PROFILE = profile;

  if (pyTruthy(envVars)) {
    Object.assign(settings.env, envVars);
  }

  // Migration: remove AGENT_HOOK_PROFILE from settings.local.json if present
  // (older versions wrote it there, causing host/container leak)
  delete settings.env.AGENT_HOOK_PROFILE;

  // MCP servers (channel plugins) are separate processes that inherit OS env —
  // they don't read settings.local.json directly. Without *_STATE_DIR the
  // plugin defaults to ~/.claude/channels/<plugin>/, which is lost on Docker
  // container restart.
  for (const [chName, chCfg] of iterChannelConfigs(config)) {
    const stateDir = chCfg.state_dir;
    if (pyTruthy(stateDir)) {
      // Relative paths resolved against project root (cwd at boot).
      // In Docker, compose sets *_STATE_DIR via ${PWD} (host-side);
      // this expansion covers the non-Docker (tmux) boot path.
      settings.env[`${chName.toUpperCase()}_STATE_DIR`] = resolveStateDir(stateDir);
    }
  }

  // Remove channel bot tokens — they must only live in
  // .claude.local/channels/<plugin>/.env. A stale token here
  // overrides the file via process.env and fails silently.
  const staleKeys = Object.keys(settings.env).filter((k) => k.endsWith('_BOT_TOKEN'));
  for (const key of staleKeys) delete settings.env[key];
  if (staleKeys.length) {
    console.log(`[hermit] Cleaned stale token vars from settings.local.json: ${staleKeys.join(', ')}`);
  }

  // hermit-start does not own sandbox.enabled — that's a hatch/operator decision;
  // hermit-evolve migrates existing installs. Here we only strip the obsolete
  // enableWeakerNestedSandbox key that older versions wrote on container boot.
  let sandbox = settings.sandbox || {};
  if (!isDict(sandbox)) sandbox = {};
  delete sandbox.enableWeakerNestedSandbox;
  if (pyTruthy(sandbox)) {
    settings.sandbox = sandbox;
  } else {
    delete settings.sandbox;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  if (pyTruthy(envVars)) {
    console.log(`[hermit] Env: ${Object.keys(envVars).length} vars written to .claude/settings.local.json`);
  }
}

/**
 * Boot-time artifact publish grant. Runs pre-launch in the operator's shell —
 * outside any Claude session, so the auto-mode classifier is not in play. This
 * is the out-of-session executor for the decision a channel reply recorded in
 * config.artifacts.publish_authorized (a channel reply may only flip hermit
 * config, never permissions — this is where the permission write happens).
 * Idempotent and self-healing: sealed set-merges, re-ensured every boot.
 */
function applyArtifactGrant(config: Json): void {
  const artifacts = isDict(config.artifacts) ? config.artifacts : {};
  const anyPage = ['dashboard', 'proposals', 'weekly_review'].some((k) => pyTruthy(artifacts[k]));
  if (!anyPage || artifacts.publish_authorized !== true) return;
  const script = path.join(PLUGIN_ROOT, 'scripts', 'apply-settings.ts');
  for (const op of ['artifact-allow', 'automode-seed']) {
    const r = spawnSync('bun', [script, '.claude/settings.local.json', op], { stdio: 'pipe', encoding: 'utf-8' });
    if (r.status !== 0) {
      console.log(`[hermit] WARNING: boot grant '${op}' failed: ${(r.stderr || '').trim()} — continuing boot.`);
      return;
    }
  }
  console.log('[hermit] Artifact publish grant ensured (permissions.allow + autoMode seed in .claude/settings.local.json)');
}

/**
 * os.execvp replacement: Bun cannot replace the process image, so spawn the
 * command with inherited stdio and exit with its status. The lifecycle lock
 * is released first — Python's flock fd was O_CLOEXEC and released on exec.
 */
function execvp(cmd: string[]): never {
  releaseLock(LIFECYCLE_LOCK);
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

async function main(): Promise<void> {
  const noTmuxFlag = process.argv.includes('--no-tmux');

  const config = loadConfig();
  acquireLifecycleLock();
  checkForUpgrade(config);
  const tools = checkPrerequisites();
  checkSandboxCapability();
  const cmd = buildClaudeCommand(config, tools);
  const sessionName = getSessionName(config);

  // Setup-mode gate: docker-setup touches this marker before first boot so channel
  // pairing commands land on an idle REPL prompt rather than racing the bootstrap turn.
  // Consumed (deleted) here — one-shot, so a crashed setup doesn't suppress bootstrap permanently.
  const setupMarker = path.join(STATE_DIR, '.setup-mode');
  const setupMode = fs.existsSync(setupMarker);
  if (setupMode) {
    try {
      fs.unlinkSync(setupMarker);
    } catch {}
    console.log('[hermit] Setup mode — skipping bootstrap prompt (one-shot)');
  }

  // send-keys races the TUI init on slow boots — argv does not.
  const hb = 'heartbeat' in config ? config.heartbeat : {};
  const autoSession = pyTruthy('auto_session' in config ? config.auto_session : true);
  const hbEnabled = pyTruthy('enabled' in hb ? hb.enabled : false);
  const hasRoutines = pyTruthy(config.routines);
  // Domain hermits (e.g. homeassistant-hermit) declare a boot_skill that
  // wraps /claude-code-hermit:session-start plus their own domain setup.
  // When set, it replaces the core session skill in the bootstrap — the
  // domain skill is responsible for calling session-start itself.
  const bootSkill = config.boot_skill || '/claude-code-hermit:session';

  const steps: string[] = [];
  if (hbEnabled) steps.push('/claude-code-hermit:heartbeat start');
  if (hasRoutines) steps.push('/claude-code-hermit:hermit-routines load');
  if (autoSession) steps.push(bootSkill);

  // Bootstrap fires only in always-on mode; interactive runs are operator-driven.
  const isAlwaysOn = !noTmuxFlag && pyTruthy(tools.tmux);
  if (steps.length && !setupMode && isAlwaysOn) {
    let bootstrap: string;
    if (steps.length === 1) {
      bootstrap = steps[0];
    } else {
      const numbered = steps.map((s, i) => `(${i + 1}) ${s}`).join(', ');
      bootstrap = `Always-on bootstrap. Invoke these skills in order: ${numbered}.`;
    }
    cmd.push(bootstrap);
  }

  checkStaleRuntime(config, sessionName);

  // Print launch info
  const agentName = config.agent_name;
  const language = config.language;
  const timezone = config.timezone;
  if (pyTruthy(agentName)) {
    const identityParts = [agentName];
    if (pyTruthy(language)) identityParts.push(language);
    if (pyTruthy(timezone)) identityParts.push(timezone);
    console.log(`[hermit] Agent: ${identityParts.join(', ')}`);
  } else {
    console.log('[hermit] Agent: (unnamed)');
  }
  console.log(`[hermit] Project: ${path.basename(process.cwd())}`);
  console.log(`[hermit] Model: ${config.model || 'default'}`);
  console.log(`[hermit] Channels: ${getEnabledChannels(config).join(', ') || 'none'}`);
  console.log(`[hermit] Remote: ${pyTruthy(config.remote) ? 'enabled' : 'disabled'}`);
  console.log(`[hermit] Chrome: ${pyTruthy(config.chrome) ? 'enabled' : 'disabled'}`);
  console.log(`[hermit] Permissions: ${config.permission_mode || 'auto'}`);

  writeSettingsEnv(config);
  applyArtifactGrant(config);

  if (noTmuxFlag || !pyTruthy(tools.tmux)) {
    if (!noTmuxFlag && !pyTruthy(tools.tmux)) {
      console.log('[hermit] tmux not found — running in current terminal.');
      console.log('[hermit] Install tmux for persistent sessions.');
    }
    // Create or update runtime.json for interactive mode
    const existing = readRuntimeJson();
    if (existing === null) {
      writeRuntimeJson({
        version: 1,
        session_state: 'idle',
        session_id: null,
        created_at: localISOStamp(),
        runtime_mode: 'interactive',
        tmux_session: null,
        transition: null,
        transition_target: null,
        transition_started_at: null,
        shutdown_requested_at: null,
        shutdown_completed_at: null,
        last_error: null,
        last_shell_snapshot_at: null,
      });
    } else {
      // Preserve lifecycle fields for session-start recovery.
      existing.version = 1;
      existing.runtime_mode = 'interactive';
      existing.tmux_session = null;
      clearShutdownStampsOnBoot(existing);
      writeRuntimeJson(existing);
    }
    console.log(`[hermit] Running: ${shlexJoin(cmd)}`);
    execvp(cmd);
  }

  // Start tmux session (handles "already exists" as a graceful exit)
  //
  // tmux starts a new shell that does NOT inherit the caller's environment.
  // Auth vars must be in shell env before claude launches.
  // *_STATE_DIR vars must be OS env because MCP servers (channel plugins)
  // inherit shell env but don't read settings.local.json.
  const forwardVars = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'AGENT_HOOK_PROFILE'];
  // *_STATE_DIR vars must reach MCP servers via OS env — see writeSettingsEnv.
  for (const [chName, chCfg] of iterChannelConfigs(config)) {
    if (pyTruthy(chCfg.state_dir)) {
      forwardVars.push(`${chName.toUpperCase()}_STATE_DIR`);
    }
  }
  const envFile = path.join('/tmp', `.hermit-env-${sessionName}`);
  // CLAUDE_PLUGIN_ROOT is not injected into the tmux shell by the harness;
  // set it explicitly so Bash tool calls in skills work in cron-triggered sessions.
  let envContent = `export CLAUDE_PLUGIN_ROOT=${shlexQuote(PLUGIN_ROOT)}\n`;
  // HERMIT_MANAGED marks this as THE unattended managed session — the one path
  // ask-gate.ts denies AskUserQuestion on. It rides the process-scoped env-file
  // only (sourced then rm'd by the tmux shell below), never settings.local.json
  // or the docker-compose env block, so a hand-launched `claude` in the same
  // always_on project — or a `docker exec` maintenance shell — never inherits it
  // and is correctly treated as attended.
  envContent += `export HERMIT_MANAGED=1\n`;
  for (const v of forwardVars) {
    const val = process.env[v];
    if (val !== undefined) {
      envContent += `export ${v}=${shlexQuote(val)}\n`;
    }
  }
  fs.writeFileSync(envFile, envContent);
  fs.chmodSync(envFile, 0o600);

  const shellCmd = `. ${shlexQuote(envFile)} && rm -f ${shlexQuote(envFile)} && ${shlexJoin(cmd)}`;
  const result = spawnSync('tmux', ['new-session', '-d', '-s', sessionName, shellCmd], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    const stderrMsg = result.stderr ? result.stderr.trim() : '';
    if (stderrMsg.includes('duplicate session')) {
      console.log(`[hermit] Session "${sessionName}" already running (always-on).`);
      console.log(`[hermit] Attach: .claude-code-hermit/bin/hermit-attach  (or: tmux attach -t ${sessionName})`);
      console.log('[hermit] Send tasks via channel, or run hermit-stop to shut down.');
      process.exit(0);
    } else {
      console.log('[hermit] ERROR: tmux new-session failed.');
      if (stderrMsg) console.log(`[hermit]   tmux: ${stderrMsg}`);
      process.exit(1);
    }
  }

  console.log(`[hermit] Started tmux session: ${sessionName}`);

  // Detect runtime mode
  const runtimeMode = isContainer() ? 'docker' : 'tmux';

  // The prior process's harness session is over — drop its stale cost cache so the
  // watchdog's idle-phase hygiene fallback can't resolve a defunct session (see helper).
  clearStatusCacheOnBoot();
  // Fresh boot marker for hermit-routines' cron-registry diff (see helper).
  writeBootId();

  // Create or update runtime.json as the single source of lifecycle truth
  const existing = readRuntimeJson();
  if (existing === null) {
    writeRuntimeJson({
      version: 1,
      session_state: 'idle',
      session_id: null,
      created_at: localISOStamp(),
      runtime_mode: runtimeMode,
      tmux_session: sessionName,
      transition: null,
      transition_target: null,
      transition_started_at: null,
      shutdown_requested_at: null,
      shutdown_completed_at: null,
      last_error: null,
      last_shell_snapshot_at: null,
    });
  } else {
    // Preserve lifecycle fields for session-start recovery.
    existing.version = 1;
    existing.runtime_mode = runtimeMode;
    existing.tmux_session = sessionName;
    clearShutdownStampsOnBoot(existing);
    writeRuntimeJson(existing);
  }

  // Mark as always-on mode in config
  config.always_on = true;
  applyAlwaysOnDoctorSchedule(config);
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  } catch {}

  // Verify the session survived the boot period
  await sleep(3); // Wait for Claude to boot — increase if on slow hardware
  if (!tmuxSessionAlive(sessionName)) {
    console.log(`[hermit] ERROR: tmux session "${sessionName}" died after creation.`);
    console.log('[hermit] The shell command inside tmux likely failed.');
    console.log('[hermit] Common causes: `claude` not in PATH, missing ANTHROPIC_API_KEY.');
    console.log('[hermit] To debug: tmux new-session -s hermit-debug then run `claude` manually.');
    console.log('[hermit] Falling back to interactive mode...');
    const stale = readRuntimeJson();
    stale.runtime_mode = 'interactive';
    stale.tmux_session = null;
    stale.last_error = 'session_died_on_boot';
    writeRuntimeJson(stale);
    execvp(cmd);
  }

  if (hbEnabled) {
    const every = 'every' in hb ? hb.every : '30m';
    console.log(`[hermit] Bootstrap: /claude-code-hermit:heartbeat start queued (every ${every})`);
  } else {
    console.log('[hermit] Heartbeat: disabled');
  }
  if (hasRoutines) {
    console.log('[hermit] Bootstrap: /claude-code-hermit:hermit-routines load queued');
  }
  if (autoSession) {
    console.log(`[hermit] Bootstrap: ${bootSkill} queued`);
  }

  console.log('[hermit] Mode: always-on (session stays open between tasks)');
  console.log(`[hermit] Attach: .claude-code-hermit/bin/hermit-attach  (or: tmux attach -t ${sessionName})`);
  console.log('[hermit] Stop: .claude-code-hermit/bin/hermit-stop');
}

export {
  CONFIG_PATH,
  STATE_DIR,
  RUNTIME_JSON,
  RUNTIME_TMP,
  LIFECYCLE_LOCK,
  PROFILE_LEVELS,
  DEFAULT_CONFIG,
  CHANNEL_PLUGINS,
  loadConfig,
  applyAlwaysOnDoctorSchedule,
  checkForUpgrade,
  checkPrerequisites,
  isContainer,
  isSandboxEnabled,
  sandboxProbeCached,
  checkSandboxCapability,
  writeRuntimeJson,
  readRuntimeJson,
  checkStaleRuntime,
  clearShutdownStampsOnBoot,
  clearStatusCacheOnBoot,
  writeBootId,
  acquireLifecycleLock,
  fetchRegisteredMarketplaces,
  iterChannelConfigs,
  getEnabledChannels,
  resolveStateDir,
  buildClaudeCommand,
  writeSettingsEnv,
  applyArtifactGrant,
  shlexQuote,
  shlexJoin,
  main,
};

if (import.meta.main) {
  await main();
}
