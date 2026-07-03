// Hook contract tests for claude-code-hermit (bun test port of run-hooks.sh).
// Tests every script registered in hooks/hooks.json plus their stop-pipeline sub-stages.
//
// These are CONTRACT tests: hooks are exercised as subprocesses (via runScript)
// because that is the boundary Claude Code sees — stdin in, exit code/stdout out,
// fail-open. Only pure exported helpers (getCumulativeCost, cidrOverlap) are
// tested in-process.
//
// Usage: bun test tests/hooks.contract.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, PLUGIN_ROOT, MONOREPO_ROOT } from './helpers/run';
import { setupWorkdir, setupGitWorkdir, fixturesDir, type Workdir } from './helpers/workdir';
import { cidrOverlap, checkHeartbeat } from '../scripts/doctor-check';
import { unconsolidated, dbExists } from '../scripts/lib/channel-log';

// ---------- small local helpers ----------

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

/** Run a test body inside a throwaway workdir, always cleaning up. */
function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

/** Same, but with a git-initialised workdir (needed by session-diff). */
function withGitDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd = setupGitWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const PIPE_ENV = { AGENT_HOOK_PROFILE: 'standard', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };

/** Copy the transcript fixture into the workdir and return the substituted Stop payload. */
function stopHookInput(dir: string): string {
  const transcript = path.join(dir, '.claude', 'transcript.jsonl');
  fs.copyFileSync(path.join(fixturesDir, 'transcript.jsonl'), transcript);
  return fs
    .readFileSync(path.join(fixturesDir, 'stop-hook-input.json'), 'utf-8')
    .replace('__TRANSCRIPT_PATH__', transcript);
}

// Minimal valid config used by the doctor-check cases.
const DOCTOR_CONFIG =
  '{"agent_name":"t","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true},"routines":[]}';

function seedDoctor(dir: string, config: string = DOCTOR_CONFIG): void {
  fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  write(hermit(dir, 'config.json'), config);
}

/** Run doctor-check against the workdir's hermit dir and return the parsed report. */
async function doctorReport(dir: string, env: Record<string, string> = {}) {
  const r = await runScript('doctor-check.ts', {
    args: [hermit(dir)],
    cwd: dir,
    env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
  });
  expect(r.exitCode).toBe(0);
  return readJson(hermit(dir, 'state', 'doctor-report.json'));
}

const checkById = (report: any, id: string) =>
  report.checks.find((c: any) => c.id === id);

/** Scaffold a fake plugins/ tree for checkDependencies cases; returns the fake core root. */
function seedFakePlugins(
  dir: string,
  opts: { sibling?: boolean; meta?: string; coreVersion?: string } = {},
): string {
  const core = path.join(dir, 'plugins', 'claude-code-hermit', '.claude-plugin');
  fs.mkdirSync(core, { recursive: true });
  write(path.join(core, 'plugin.json'),
    `{"name":"claude-code-hermit","version":"${opts.coreVersion ?? '1.0.20'}"}`);
  if (opts.sibling) {
    const sib = path.join(dir, 'plugins', 'example-sibling', '.claude-plugin');
    fs.mkdirSync(sib, { recursive: true });
    write(path.join(sib, 'plugin.json'), '{"name":"example-sibling","version":"0.1.0"}');
    if (opts.meta) write(path.join(sib, 'hermit-meta.json'), opts.meta);
  }
  return path.join(dir, 'plugins', 'claude-code-hermit');
}

/**
 * Scaffold a versioned marketplace cache tree
 * (.claude/plugins/cache/<mp>/<plugin>/<version>/) and return the fake core
 * version-root. `siblingVersions` maps each seeded sibling version dir to its
 * required_core_version range, so a test can prove the newest version is read.
 */
function seedVersionedCache(
  dir: string,
  opts: { coreVersion?: string; siblingVersions?: Record<string, string> } = {},
): string {
  const mp = path.join(dir, '.claude', 'plugins', 'cache', 'hermit-mp');
  const coreVer = opts.coreVersion ?? '1.2.14';
  const coreDir = path.join(mp, 'claude-code-hermit', coreVer, '.claude-plugin');
  fs.mkdirSync(coreDir, { recursive: true });
  write(path.join(coreDir, 'plugin.json'), `{"name":"claude-code-hermit","version":"${coreVer}"}`);
  for (const [ver, range] of Object.entries(opts.siblingVersions ?? {})) {
    const sib = path.join(mp, 'example-sibling', ver, '.claude-plugin');
    fs.mkdirSync(sib, { recursive: true });
    write(path.join(sib, 'plugin.json'), `{"name":"example-sibling","version":"${ver}"}`);
    write(path.join(sib, 'hermit-meta.json'), `{"required_core_version":"${range}"}`);
  }
  return path.join(mp, 'claude-code-hermit', coreVer);
}

const DOCKER_SEC_CONFIG =
  '{"agent_name":"t","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true},"routines":[],"docker":{"security":{"network":{"enabled":true,"subnet":"172.28.0.0/24","gateway":"172.28.0.1","netguard_ip":"172.28.0.2"}}}}';

/** Create a fake `docker` executable on a temp PATH dir. Caller must cleanup(). */
function fakeDocker(scriptBody: string): { bin: string; cleanup(): void } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
  const p = path.join(bin, 'docker');
  fs.writeFileSync(p, scriptBody);
  fs.chmodSync(p, 0o755);
  return { bin, cleanup: () => { try { fs.rmSync(bin, { recursive: true, force: true }); } catch {} } };
}

function seedDockerSecurity(dir: string): void {
  seedDoctor(dir, DOCKER_SEC_CONFIG);
  write(path.join(dir, 'docker-compose.hermit.yml'), '');
  write(path.join(dir, 'docker-compose.security.yml'), '');
}

// Clean up any suggest-compact counter files left in the OS tmpdir.
afterAll(() => {
  const counterDir = path.join(os.tmpdir(), `claude-agent-compact-${process.getuid?.() ?? 'win'}`);
  try {
    for (const f of fs.readdirSync(counterDir)) {
      if (/^counter-test-session-.*\.txt$/.test(f)) {
        fs.rmSync(path.join(counterDir, f), { force: true });
      }
    }
  } catch {}
});

// -------------------------------------------------------
// cost-tracker
// -------------------------------------------------------

describe('cost-tracker', () => {
  test('cost-tracker (empty stdin)', withDir(async (dir) => {
    const r = await runScript('cost-tracker.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));
});

// In-process: getCumulativeCost is a pure-ish exported helper, but cost-tracker.ts
// freezes its CWD-relative state paths (.status.json etc.) at import time. So we
// chdir into ONE shared workdir for the first (and only) import, restore CWD, and
// both cases rewrite .status.json inside that same frozen workdir.
describe('cost-tracker getCumulativeCost (in-process)', () => {
  let wd: Workdir;
  let getCumulativeCost: typeof import('../scripts/cost-tracker').getCumulativeCost;

  beforeAll(async () => {
    wd = setupWorkdir();
    const prev = process.cwd();
    process.chdir(wd.dir);
    try {
      ({ getCumulativeCost } = await import('../scripts/cost-tracker'));
    } finally {
      process.chdir(prev);
    }
  });

  afterAll(() => wd.cleanup());

  test('getCumulativeCost (same session → accumulates)', () => {
    write(hermit(wd.dir, 'sessions', '.status.json'),
      '{"session_id":"S-001","cost_usd":698.78,"tokens":300000000,"operator_turns":0}');
    const r = getCumulativeCost(0.10, 1000, false, 'S-001', undefined);
    expect(r.cost).toBeCloseTo(698.88, 3);
    expect(r.tokens).toBe(300001000);
  });

  test('getCumulativeCost (session change → resets)', () => {
    write(hermit(wd.dir, 'sessions', '.status.json'),
      '{"session_id":"S-001","cost_usd":698.78,"tokens":300000000,"operator_turns":5}');
    const r = getCumulativeCost(0.10, 1000, false, 'S-002', undefined);
    expect(r.cost).toBeCloseTo(0.10, 3);
    expect(r.tokens).toBe(1000);
    expect(r.operatorTurns).toBe(0);
  });
});

// -------------------------------------------------------
// suggest-compact / evaluate-session
// -------------------------------------------------------

describe('suggest-compact', () => {
  test('suggest-compact', withDir(async (dir) => {
    const stdin = fs.readFileSync(path.join(fixturesDir, 'stop-hook-input.json'), 'utf-8');
    const r = await runScript('suggest-compact.ts', { stdin, cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  test('suggest-compact (empty stdin)', withDir(async (dir) => {
    const r = await runScript('suggest-compact.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  // Regression for the removed context_usage branch: a payload claiming 90% context
  // usage must NOT produce a percentage-based suggestion. Only the tool-call counter
  // (COMPACT_THRESHOLD calls in one session) may trigger a suggestion.
  test('suggest-compact (context_usage present but ignored)', withDir(async (dir) => {
    const base = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'stop-hook-input.json'), 'utf-8'));
    const stdin = JSON.stringify({ ...base, session_id: 'test-session-ctxusage', context_usage: 0.9 });
    const r = await runScript('suggest-compact.ts', { stdin, cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('context usage');
    expect(r.stdout.trim()).toBe('');
  }));
});

describe('evaluate-session', () => {
  test('evaluate-session (empty stdin)', withDir(async (dir) => {
    const r = await runScript('evaluate-session.ts', {
      stdin: '', cwd: dir, env: { AGENT_HOOK_PROFILE: 'standard' },
    });
    expect(r.exitCode).toBe(0);
  }));
});

// -------------------------------------------------------
// session-diff (self-gated on AGENT_HOOK_PROFILE)
// -------------------------------------------------------

describe('session-diff', () => {
  test('session-diff', withGitDir(async (dir) => {
    const r = await runScript('session-diff.ts', {
      stdin: '{}', cwd: dir, env: PIPE_ENV,
    });
    expect(r.exitCode).toBe(0);
  }));

  test('session-diff sidecar', withGitDir(async (dir) => {
    const r = await runScript('session-diff.ts', {
      stdin: '{}', cwd: dir, env: PIPE_ENV,
    });
    expect(r.exitCode).toBe(0);
    const sidecar = hermit(dir, 'state', 'session-diff.json');
    expect(fs.existsSync(sidecar)).toBe(true);
    expect(() => readJson(sidecar)).not.toThrow();
  }));

  test('session-diff (empty stdin)', withGitDir(async (dir) => {
    const r = await runScript('session-diff.ts', {
      stdin: '', cwd: dir, env: PIPE_ENV,
    });
    expect(r.exitCode).toBe(0);
  }));
});

// -------------------------------------------------------
// enforce-deny-patterns
// -------------------------------------------------------

describe('enforce-deny-patterns', () => {
  test('enforce-deny-patterns (block rm -rf)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(2);
  }));

  test('enforce-deny-patterns (allow safe)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  }));

  test('enforce-deny-patterns (block OPERATOR.md always-on)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Edit","tool_input":{"file_path":".claude-code-hermit/OPERATOR.md"}}',
      cwd: dir, env: { AGENT_HOOK_PROFILE: 'strict', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(2);
  }));

  test('enforce-deny-patterns (allow OPERATOR.md interactive)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Edit","tool_input":{"file_path":".claude-code-hermit/OPERATOR.md"}}',
      cwd: dir, env: { AGENT_HOOK_PROFILE: 'standard', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  }));

  test('enforce-deny-patterns (block marketplaces path)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Edit","tool_input":{"file_path":"/home/u/.claude/plugins/marketplaces/claude-code-hermit/plugins/claude-code-hermit/scripts/foo.ts"}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(2);
  }));

  test('enforce-deny-patterns (allow normal project path)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Edit","tool_input":{"file_path":"/home/u/project/src/foo.ts"}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  }));

  test('enforce-deny-patterns (empty stdin)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '', cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  }));

  // Compound-command segmentation: a deny pattern anchored to a leading command
  // must still fire when that command hides behind `cd …`, `;`, or a pipe.
  test('enforce-deny-patterns (block rm -rf behind &&)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"cd /tmp && rm -rf x"}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(2);
  }));

  test('enforce-deny-patterns (block chmod 777 behind ;)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"true; chmod 777 /tmp/f"}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(2);
  }));

  test('enforce-deny-patterns (block printenv in a pipe)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"id | printenv"}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(2);
  }));

  test('enforce-deny-patterns (allow safe compound)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"ls -la && echo done"}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  }));

  test('enforce-deny-patterns (allow safe pipeline)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"cat notes.md | grep todo"}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  }));

  test('enforce-deny-patterns (block always-on git push --force behind &&)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"cd repo && git push --force origin x"}}',
      cwd: dir, env: { AGENT_HOOK_PROFILE: 'strict', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(2);
  }));

  test('enforce-deny-patterns (same compound allowed when not strict)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"cd repo && git push --force origin x"}}',
      cwd: dir, env: { AGENT_HOOK_PROFILE: 'standard', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  }));

  // A separator inside a quoted string must NOT fragment the command — a plain
  // echo/commit that merely mentions `rm -rf` after a `;` is not a real bypass.
  test('enforce-deny-patterns (quoted separator does not fragment command)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"echo \\"step 1; rm -rf build\\""}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  }));

  test('enforce-deny-patterns (Edit path containing | is not split)', withDir(async (dir) => {
    const r = await runScript('enforce-deny-patterns.ts', {
      stdin: '{"tool_name":"Edit","tool_input":{"file_path":"/home/u/project/weird|name.ts"}}',
      cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);
  }));
});

// -------------------------------------------------------
// channel-hook
// -------------------------------------------------------

describe('channel-hook', () => {
  test('channel-hook (persist dm_channel_id)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"enabled":true,"dm_channel_id":null}}}');
    const r = await runScript('channel-hook.ts', {
      stdin: '{"tool_name":"mcp__discord__reply","tool_input":{"chat_id":"123456"}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    expect(readJson(hermit(dir, 'config.json')).channels.discord.dm_channel_id).toBe('123456');
  }));

  test('channel-hook (skip unconfigured)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{}}');
    const r = await runScript('channel-hook.ts', {
      stdin: '{"tool_name":"mcp__discord__reply","tool_input":{"chat_id":"123456"}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    expect(readJson(hermit(dir, 'config.json')).channels).not.toHaveProperty('discord');
  }));

  test('channel-hook (activity file)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"enabled":true}}}');
    const r = await runScript('channel-hook.ts', {
      stdin: '{"tool_name":"mcp__discord__reply","tool_input":{"chat_id":"999"}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    const activity = readJson(hermit(dir, 'state', 'channel-activity.json'));
    expect(activity.discord).toHaveProperty('last_reply_at');
  }));

  test('channel-hook (plugin_ prefix)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"enabled":true,"dm_channel_id":null}}}');
    const r = await runScript('channel-hook.ts', {
      stdin: '{"tool_name":"plugin_discord_discord_reply","tool_input":{"chat_id":"789"}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    expect(readJson(hermit(dir, 'config.json')).channels.discord.dm_channel_id).toBe('789');
  }));

  test('channel-hook (empty stdin)', withDir(async (dir) => {
    const r = await runScript('channel-hook.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  test('channel-hook (iMessage persist dm_channel_id)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"imessage":{"enabled":true,"dm_channel_id":null}}}');
    const r = await runScript('channel-hook.ts', {
      stdin: '{"tool_name":"mcp__imessage__reply","tool_input":{"chat_id":"+15550001234"}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    expect(readJson(hermit(dir, 'config.json')).channels.imessage.dm_channel_id).toBe('+15550001234');
  }));

  test('channel-hook (channel-replies.jsonl single entry)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"enabled":true}}}');
    const r = await runScript('channel-hook.ts', {
      stdin: '{"tool_name":"mcp__discord__reply","tool_input":{}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    const lines = fs.readFileSync(hermit(dir, 'state', 'channel-replies.jsonl'), 'utf-8')
      .split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const e = JSON.parse(lines[lines.length - 1]);
    expect(e.event).toBe('reply');
    expect(e.channel).toBe('discord');
    expect(e).toHaveProperty('ts');
  }));

  test('channel-hook (channel-replies.jsonl append)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"enabled":true}}}');
    const stdin = '{"tool_name":"mcp__discord__reply","tool_input":{}}';
    expect((await runScript('channel-hook.ts', { stdin, cwd: dir })).exitCode).toBe(0);
    expect((await runScript('channel-hook.ts', { stdin, cwd: dir })).exitCode).toBe(0);
    const lines = fs.readFileSync(hermit(dir, 'state', 'channel-replies.jsonl'), 'utf-8')
      .split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  }));

  test('channel-hook (channel-replies.jsonl unconfigured skip)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{}}');
    const r = await runScript('channel-hook.ts', {
      stdin: '{"tool_name":"mcp__discord__reply","tool_input":{}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(hermit(dir, 'state', 'channel-replies.jsonl'))).toBe(false);
  }));

  // ---- Episodic capture (PROP-010) ----

  test('channel-hook (capture: outbound text logged even when the channel is not yet configured)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{}}');
    const r = await runScript('channel-hook.ts', {
      stdin: '{"tool_name":"mcp__discord__reply","tool_input":{"chat_id":"999","text":"hi from bot"}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    const rows = unconsolidated(hermit(dir)).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ source: 'discord', chat_id: '999', direction: 'out', text: 'hi from bot' });
  }));

  test('channel-hook (capture: channel_log_enabled:false -> no DB created)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"knowledge":{"channel_log_enabled":false}}');
    await runScript('channel-hook.ts', {
      stdin: '{"tool_name":"mcp__discord__reply","tool_input":{"chat_id":"999","text":"hi"}}', cwd: dir,
    });
    expect(dbExists(hermit(dir))).toBe(false);
  }));

  test('channel-hook (capture: missing text field -> no crash, no capture)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{}}');
    const r = await runScript('channel-hook.ts', {
      stdin: '{"tool_name":"mcp__discord__reply","tool_input":{}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    expect(dbExists(hermit(dir))).toBe(false);
  }));
});

// -------------------------------------------------------
// validate-config
// -------------------------------------------------------

describe('validate-config', () => {
  test('validate-config (valid)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'),
      '{"agent_name":null,"language":null,"timezone":null,"escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true,"active_hours":{"start":"08:00","end":"23:00"}},"routines":[{"id":"test","schedule":"0 4 * * *","skill":"x:y","enabled":true}],"quality_gate":{"tier":"budget"}}\n');
    const r = await runScript('validate-config.ts', {
      stdin: `{"tool_name":"Edit","tool_input":{"file_path":"${hermit(dir, 'config.json')}"}}`,
      cwd: dir,
    });
    expect(r.exitCode).toBe(0);
  }));

  test('validate-config (invalid)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"agent_name":null}');
    const r = await runScript('validate-config.ts', {
      stdin: `{"tool_name":"Edit","tool_input":{"file_path":"${hermit(dir, 'config.json')}"}}`,
      cwd: dir,
    });
    expect(r.exitCode).toBe(2);
  }));

  test('validate-config (skip non-config)', withDir(async (dir) => {
    const r = await runScript('validate-config.ts', {
      stdin: '{"tool_name":"Edit","tool_input":{"file_path":"/some/other/file.js"}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
  }));

  test('validate-config (empty stdin)', withDir(async (dir) => {
    const r = await runScript('validate-config.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));
});

// -------------------------------------------------------
// stop-pipeline
// -------------------------------------------------------

describe('stop-pipeline', () => {
  test('stop-pipeline', withGitDir(async (dir) => {
    const r = await runScript('stop-pipeline.ts', {
      stdin: stopHookInput(dir), cwd: dir, env: PIPE_ENV,
    });
    expect(r.exitCode).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain('cost-tracker');
    expect(combined).toContain('session-eval');
    expect(fs.existsSync(hermit(dir, 'state', '.heartbeat'))).toBe(true);
  }));

  test('stop-pipeline (stdout contract)', withDir(async (dir) => {
    const r = await runScript('stop-pipeline.ts', {
      stdin: stopHookInput(dir), cwd: dir,
      env: { ...PIPE_ENV, COMPACT_THRESHOLD: '1' },
    });
    expect(r.exitCode).toBe(0);
    if (r.stdout.trim()) {
      const parsed = JSON.parse(r.stdout);
      expect(parsed).toHaveProperty('additionalContext');
    }
    expect(r.stdout).not.toContain('cost-tracker');
    expect(r.stdout).not.toContain('session-eval');
    expect(r.stderr).toContain('cost-tracker');
  }));

  test('stop-pipeline (malformed stdin)', withDir(async (dir) => {
    const r = await runScript('stop-pipeline.ts', {
      stdin: '{broken', cwd: dir, env: PIPE_ENV,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toContain('malformed');
  }));
});

// -------------------------------------------------------
// session-diff debounce (via stop-pipeline)
// -------------------------------------------------------

describe('session-diff debounce', () => {
  test('session-diff (debounce skip)', withGitDir(async (dir) => {
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"in_progress"}');
    const sidecar = hermit(dir, 'state', 'session-diff.json');
    write(sidecar, '{"changed_files":[],"captured_at":"2026-01-01T00:00:00Z"}');
    // Backdate by 5s (still within the 60s debounce window) so a rewrite is detectable.
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(sidecar, past, past);
    const before = fs.statSync(sidecar).mtimeMs;
    await runScript('stop-pipeline.ts', { stdin: '{}', cwd: dir, env: PIPE_ENV });
    expect(fs.statSync(sidecar).mtimeMs).toBe(before);
  }));

  test('session-diff (debounce force on idle)', withGitDir(async (dir) => {
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"idle"}');
    const sidecar = hermit(dir, 'state', 'session-diff.json');
    write(sidecar, '{"changed_files":[],"captured_at":"2026-01-01T00:00:00Z"}');
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(sidecar, past, past);
    const before = fs.statSync(sidecar).mtimeMs;
    await runScript('stop-pipeline.ts', { stdin: '{}', cwd: dir, env: PIPE_ENV });
    expect(fs.statSync(sidecar).mtimeMs).not.toBe(before);
  }));

  test('session-diff (debounce expired)', withGitDir(async (dir) => {
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"in_progress"}');
    const sidecar = hermit(dir, 'state', 'session-diff.json');
    write(sidecar, '{"changed_files":[],"captured_at":"2020-01-01T00:00:00Z"}');
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(sidecar, past, past);
    const before = fs.statSync(sidecar).mtimeMs;
    await runScript('stop-pipeline.ts', { stdin: '{}', cwd: dir, env: PIPE_ENV });
    expect(fs.statSync(sidecar).mtimeMs).not.toBe(before);
  }));
});

// -------------------------------------------------------
// startup-context
// -------------------------------------------------------

describe('startup-context', () => {
  const ENV = { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };

  test('startup-context', withDir(async (dir) => {
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('---Active Session---');
  }));

  test('startup-context (large SHELL.md)', withDir(async (dir) => {
    const fixture = fs.readFileSync(path.join(fixturesDir, 'shell-session.md'), 'utf-8');
    const extra = Array.from({ length: 150 },
      (_, i) => `- [10:${String(i).padStart(2, '0')}] Progress entry ${i}`).join('\n');
    write(hermit(dir, 'sessions', 'SHELL.md'),
      fixture.replace('- [10:00] Started test session', extra));
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().length).toBeLessThan(8000);
  }));

  test('startup-context (no session)', withDir(async (dir) => {
    fs.rmSync(hermit(dir, 'sessions', 'SHELL.md'));
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No active session');
  }));

  test('startup-context (section priority)', withDir(async (dir) => {
    write(hermit(dir, 'OPERATOR.md'), '# Operator\n' + ('x'.repeat(80) + '\n').repeat(22));
    const extra = Array.from({ length: 200 },
      (_, i) => `- [10:${String(i).padStart(2, '0')}] Entry ${i}`).join('\n');
    write(hermit(dir, 'sessions', 'SHELL.md'),
      `# Active Session\n\n## Task\nTest\n\n## Progress Log\n${extra}\n\n## Blockers\nNone\n`);
    write(hermit(dir, 'sessions', 'S-001-REPORT.md'),
      '# Session Report: S-001\n\n## Overview\nSHOULD_NOT_APPEAR_IN_OUTPUT_IF_CAP_HIT\n');
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Operator');
    expect(r.stdout.trimEnd().length).toBeLessThan(8000);
  }));

  test('startup-context (injection_stub replaces body)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'compiled', 'context-house-profile-2026-06-01.md'), `---
title: House Profile
created: 2026-06-01T00:00:00+00:00
type: context
tags: [foundational]
injection_stub: STUB_MARKER read compiled/context-house-profile-2026-06-01.md for detail
---
BODY_MARKER this long body should never be injected when a stub is present.
`);
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('STUB_MARKER');
    expect(r.stdout).not.toContain('BODY_MARKER');
    expect(r.stdout).not.toContain('[...]');
  }));

  test('startup-context (schema drift — undeclared type)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'compiled', 'test-artifact.md'),
      '---\ntitle: Test\ntype: undeclared-widget\ncreated: 2025-01-01\n---\nBody.\n');
    write(hermit(dir, 'knowledge-schema.md'),
      '## Work Products\n- known-type: a declared type\n\n## Raw Captures\n');
    const r = await runScript('startup-context.ts', {
      cwd: dir, env: { ...ENV, AGENT_DIR: hermit(dir) },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('---Schema Drift---');
    expect(r.stdout).toContain('undeclared-widget');
  }));

  test('startup-context (schema drift — declared type, no warning)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'compiled', 'test-artifact.md'),
      '---\ntitle: Test\ntype: known-type\ncreated: 2025-01-01\n---\nBody.\n');
    write(hermit(dir, 'knowledge-schema.md'),
      '## Work Products\n- known-type: a declared type\n\n## Raw Captures\n');
    const r = await runScript('startup-context.ts', {
      cwd: dir, env: { ...ENV, AGENT_DIR: hermit(dir) },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('Schema Drift');
  }));

  test('startup-context (catalog: non-foundational gets line, not body)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'compiled', 'note-billing-2026-06-01.md'), `---
title: Billing quirks
created: 2026-06-01T00:00:00+00:00
type: note
tags: [billing]
summary: Stripe webhook retry quirks and how we handle them
---
BODY_MARKER this body must not be injected for non-foundational artifacts.
`);
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('note-billing-2026-06-01 [note] (2026-06-01) #billing');
    expect(r.stdout).toContain('Stripe webhook retry quirks');
    expect(r.stdout).not.toContain('BODY_MARKER');
  }));

  test('startup-context (catalog: multiple foundational same type all pinned)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'compiled', 'topic-alpha.md'),
      '---\ntitle: Alpha\ntype: topic\ncreated: 2026-01-01\ntags: [foundational]\n---\nALPHA_BODY\n');
    write(hermit(dir, 'compiled', 'topic-beta.md'),
      '---\ntitle: Beta\ntype: topic\ncreated: 2026-02-01\ntags: [foundational]\n---\nBETA_BODY\n');
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ALPHA_BODY');
    expect(r.stdout).toContain('BETA_BODY');
  }));

  test('startup-context (catalog: overflow shows +N more)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{"knowledge":{"compiled_budget_chars":500}}');
    for (let i = 0; i < 12; i++) {
      write(hermit(dir, 'compiled', `note-subject-${i}-2026-06-0${(i % 9) + 1}.md`),
        `---\ntitle: Subject ${i}\ntype: note\ncreated: 2026-06-0${(i % 9) + 1}\nsummary: One liner about subject number ${i} for the catalog\n---\nBody ${i}.\n`);
    }
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/\(\+\d+ more\)/);
    expect(r.stdout.trimEnd().length).toBeLessThan(9000);
  }));

  test('startup-context (catalog: unused pinned budget rolls into catalog)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    // Budget 200: without rollover the catalog would get only 120 chars, and the
    // ~150-char entry below would not fit. No foundational pages → full 200 available.
    write(hermit(dir, 'config.json'), '{"knowledge":{"compiled_budget_chars":200}}');
    write(hermit(dir, 'compiled', 'note-rollover-2026-06-01.md'),
      `---\ntitle: Rollover\ntype: note\ncreated: 2026-06-01\nsummary: ${'s'.repeat(90)}\n---\nBody.\n`);
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('note-rollover-2026-06-01');
  }));

  test('startup-context (catalog: procedure-brief excluded)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'compiled', 'procedure-brief-deploy-2026-06-01.md'),
      '---\ntitle: Deploy procedure\ntype: procedure-brief\ncreated: 2026-06-01\n---\nAudit record.\n');
    write(hermit(dir, 'compiled', 'note-visible-2026-06-01.md'),
      '---\ntitle: Visible\ntype: note\ncreated: 2026-06-01\n---\nBody.\n');
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('note-visible-2026-06-01');
    expect(r.stdout).not.toContain('procedure-brief-deploy');
    expect(r.stdout).not.toMatch(/\(\+\d+ more\)/);
  }));

  test('startup-context (catalog: topic page shows updated date)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'compiled', 'topic-rota.md'), `---
title: Support rota
created: 2025-01-01T00:00:00+00:00
updated: 2026-06-10T00:00:00+00:00
type: topic
summary: On-call rotation rules
---
Rota body.
`);
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('topic-rota [topic] (2026-06-10)');
    expect(r.stdout).not.toContain('(2025-01-01)');
  }));

  // ---- PROP-011 compaction pointers: gated on SessionStart source === "compact" ----

  test('startup-context (source=compact, only default SHELL.md → pointers with task only)', withDir(async (dir) => {
    // No runtime.json/micro-proposals.json/config.json — only the default fixture
    // SHELL.md that setupWorkdir seeds. The task line still surfaces on its own.
    const r = await runScript('startup-context.ts', {
      cwd: dir, env: ENV, stdin: JSON.stringify({ source: 'compact', session_id: 'x' }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('---Compaction Pointers---');
    expect(r.stdout).toContain('task: Test task for hook validation');
    expect(r.stdout).not.toContain('session_state:');
    expect(r.stdout).not.toContain('pending micro-proposals:');
    expect(r.stdout).not.toContain('outbound channel:');
  }));

  test('startup-context (source=startup → pointer section never emitted, even with state present)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"waiting","waiting_reason":"operator_input"}');
    const r = await runScript('startup-context.ts', {
      cwd: dir, env: ENV, stdin: JSON.stringify({ source: 'startup', session_id: 'x' }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('---Compaction Pointers---');
  }));

  test('startup-context (no stdin at all → pointer section never emitted)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"waiting"}');
    const r = await runScript('startup-context.ts', { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('---Compaction Pointers---');
  }));

  test('startup-context (source=compact, full state → pointers with runtime/task/MPs/channel)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'runtime.json'),
      '{"session_state":"waiting","waiting_reason":"operator_input"}');
    write(hermit(dir, 'state', 'micro-proposals.json'),
      '{"pending":[{"id":"MP-20260701-0","status":"pending"},{"id":"MP-20260701-1","status":"resolved"}]}');
    write(hermit(dir, 'config.json'),
      '{"channels":{"primary":"discord","discord":{"enabled":true,"dm_channel_id":"999888"}}}');
    const r = await runScript('startup-context.ts', {
      cwd: dir, env: ENV, stdin: JSON.stringify({ source: 'compact', session_id: 'x' }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('---Compaction Pointers---');
    expect(r.stdout).toContain('session_state: waiting (waiting_reason: operator_input)');
    expect(r.stdout).toContain('task: Test task for hook validation');
    // Only the pending entry surfaces — the resolved sibling stays out.
    expect(r.stdout).toContain('pending micro-proposals: MP-20260701-0');
    expect(r.stdout).not.toContain('MP-20260701-1');
    expect(r.stdout).toContain('outbound channel: discord (chat_id: 999888)');
  }));

  test('startup-context (source=compact, malformed runtime/MP/config → fail-open per field)', withDir(async (dir) => {
    // SHELL.md (from setupWorkdir's fixture) is intact, so the task line still
    // surfaces — the other three fields must each fail open independently
    // rather than blanking the whole section.
    write(hermit(dir, 'state', 'runtime.json'), 'not json');
    write(hermit(dir, 'state', 'micro-proposals.json'), '{ broken');
    write(hermit(dir, 'config.json'), 'also not json');
    const r = await runScript('startup-context.ts', {
      cwd: dir, env: ENV, stdin: JSON.stringify({ source: 'compact', session_id: 'x' }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('---Compaction Pointers---');
    expect(r.stdout).toContain('task: Test task for hook validation');
    expect(r.stdout).not.toContain('session_state:');
    expect(r.stdout).not.toContain('pending micro-proposals:');
    expect(r.stdout).not.toContain('outbound channel:');
  }));

  test('startup-context (source=compact, no state at all → total fail-open, no section)', withDir(async (dir) => {
    fs.rmSync(hermit(dir, 'sessions', 'SHELL.md'));
    const r = await runScript('startup-context.ts', {
      cwd: dir, env: ENV, stdin: JSON.stringify({ source: 'compact', session_id: 'x' }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('---Compaction Pointers---');
  }));
});

// -------------------------------------------------------
// generate-summary
// -------------------------------------------------------

describe('generate-summary', () => {
  test('generate-summary (skip non-state)', withDir(async (dir) => {
    const r = await runScript('generate-summary.ts', {
      stdin: '{"tool_name":"Edit","tool_input":{"file_path":"README.md"}}', cwd: dir,
    });
    expect(r.exitCode).toBe(0);
  }));

  test('generate-summary (writes summary)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'),
      '{"alerts":{},"last_digest_date":null,"self_eval":{}}');
    const r = await runScript('generate-summary.ts', {
      stdin: `{"tool_name":"Edit","tool_input":{"file_path":"${hermit(dir, 'state', 'alert-state.json')}"}}`,
      cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(hermit(dir, 'state', 'state-summary.md'))).toBe(true);
  }));

  test('generate-summary (empty stdin)', withDir(async (dir) => {
    const r = await runScript('generate-summary.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));
});

// -------------------------------------------------------
// prompt-context (UserPromptSubmit hook)
// -------------------------------------------------------

describe('prompt-context', () => {
  test('prompt-context (UTC fallback)', withDir(async (dir) => {
    const r = await runScript('prompt-context.ts', {
      stdin: '', cwd: dir, env: { AGENT_DIR: hermit(dir) },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^\[Now: .+ UTC\]/m);
  }));

  test('prompt-context (configured TZ)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"timezone":"America/New_York"}');
    const r = await runScript('prompt-context.ts', {
      stdin: '', cwd: dir, env: { AGENT_DIR: hermit(dir) },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^\[Now: .+ (EST|EDT)\]/m);
  }));

  test('prompt-context (invalid TZ, exits 0)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"timezone":"Bogus/Zone"}');
    const r = await runScript('prompt-context.ts', {
      stdin: '', cwd: dir, env: { AGENT_DIR: hermit(dir) },
    });
    expect(r.exitCode).toBe(0);
  }));

  test('prompt-context (invalid TZ, no [Now:] line)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"timezone":"Bogus/Zone"}');
    const r = await runScript('prompt-context.ts', {
      stdin: '', cwd: dir, env: { AGENT_DIR: hermit(dir) },
    });
    expect(r.stdout.trim()).toBe('');
  }));

  test('prompt-context (malformed config, exits 0)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), 'not json');
    const r = await runScript('prompt-context.ts', {
      stdin: '', cwd: dir, env: { AGENT_DIR: hermit(dir) },
    });
    expect(r.exitCode).toBe(0);
  }));
});

// -------------------------------------------------------
// channel-reply-reminder (UserPromptSubmit hook)
// -------------------------------------------------------

describe('channel-reply-reminder', () => {
  const run = (prompt: string, dir: string) =>
    runScript('channel-reply-reminder.ts', {
      stdin: JSON.stringify({ prompt }), cwd: dir,
    });

  test('channel-reply-reminder (discord)', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="123">hi', dir);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply');
    expect(r.stdout).toContain('123');
  }));

  test('channel-reply-reminder (telegram, reordered attrs)', withDir(async (dir) => {
    const r = await run('<channel source="telegram" message_id="42" chat_id="@user">hi', dir);
    expect(r.stdout).toContain('mcp__plugin_telegram_telegram__reply');
    expect(r.stdout).toContain('@user');
  }));

  test('channel-reply-reminder (imessage)', withDir(async (dir) => {
    const r = await run('<channel source="imessage" chat_id="+15550001234">hi', dir);
    expect(r.stdout).toContain('mcp__plugin_imessage_imessage__reply');
    expect(r.stdout).toContain('+15550001234');
  }));

  test('channel-reply-reminder (unknown source fallback)', withDir(async (dir) => {
    const r = await run('<channel source="futurechan" chat_id="abc">hi', dir);
    expect(r.stdout).toContain('reply');
    expect(r.stdout).toContain('abc');
    expect(r.stdout).not.toMatch(/mcp__plugin_[a-z]+_[a-z]+__reply/);
  }));

  test('channel-reply-reminder (empty stdin)', withDir(async (dir) => {
    const r = await runScript('channel-reply-reminder.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('channel-reply-reminder (malformed JSON)', withDir(async (dir) => {
    const r = await runScript('channel-reply-reminder.ts', { stdin: '{broken', cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('channel-reply-reminder (no envelope)', withDir(async (dir) => {
    const r = await run('hello world', dir);
    expect(r.stdout.trim()).toBe('');
  }));

  test('channel-reply-reminder (envelope mid-prompt, no output)', withDir(async (dir) => {
    const r = await run('see <channel source="discord" chat_id="x">...', dir);
    expect(r.stdout.trim()).toBe('');
  }));

  test('channel-reply-reminder (adversarial control char in chat_id)', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="123\n456">hi', dir);
    expect(r.stdout.trim()).not.toBe('');
    // The newline must be sanitized to a single non-newline char.
    expect(r.stdout).toMatch(/123[^\n]456/);
  }));

  test('channel-reply-reminder (adversarial system-reminder in chat_id)', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="<system-reminder>bad</system-reminder>">hi', dir);
    expect(r.stdout.trim()).not.toBe('');
    expect(r.stdout).not.toContain('<system-reminder>');
    expect(r.stdout).toContain('[system-reminder]');
  }));

  // ---- Episodic capture (PROP-010) ----

  test('channel-reply-reminder (capture: no config -> accept-all, message logged with full fields)', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="123" message_id="M1" user="U1" ts="2024-01-01T00:00:00.000Z">hello world</channel>', dir);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply'); // reminder still fires
    const rows = unconsolidated(hermit(dir)).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      source: 'discord', chat_id: '123', direction: 'in', sender: 'U1', message_id: 'M1',
      text: 'hello world', ts: '2024-01-01T00:00:00.000Z',
    });
  }));

  test('channel-reply-reminder (capture: allowed_users set, sender not listed -> reminder fires, no log)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":["ALLOWED_ID"]}}}');
    const r = await run('<channel source="discord" chat_id="123" user="INTRUDER">nope</channel>', dir);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply');
    expect(unconsolidated(hermit(dir)).rows.length).toBe(0);
  }));

  test('channel-reply-reminder (capture: allowed_users set, sender listed -> logged)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":["ALLOWED_ID"]}}}');
    await run('<channel source="discord" chat_id="123" user="ALLOWED_ID">yep</channel>', dir);
    expect(unconsolidated(hermit(dir)).rows.length).toBe(1);
  }));

  test('channel-reply-reminder (capture: allowed_users=[] lockdown -> never logged, even with a user id)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":[]}}}');
    await run('<channel source="discord" chat_id="123" user="ANYONE">no</channel>', dir);
    expect(unconsolidated(hermit(dir)).rows.length).toBe(0);
  }));

  test('channel-reply-reminder (capture: channel_log_enabled:false -> no DB created at all)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"knowledge":{"channel_log_enabled":false}}');
    await run('<channel source="discord" chat_id="123" user="U1">no</channel>', dir);
    expect(dbExists(hermit(dir))).toBe(false);
  }));

  test('channel-reply-reminder (capture: malformed envelope -> reminder skipped, exit 0, no throw)', withDir(async (dir) => {
    const r = await runScript('channel-reply-reminder.ts', {
      stdin: JSON.stringify({ prompt: 'not a channel envelope at all' }), cwd: dir,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));
});

// -------------------------------------------------------
// doctor-check
// -------------------------------------------------------

describe('doctor-check', () => {
  test('doctor-check (minimal install, 16 checks)', withDir(async (dir) => {
    seedDoctor(dir,
      '{"agent_name":"test","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true,"active_hours":{"start":"08:00","end":"23:00"}},"routines":[]}');
    const report = await doctorReport(dir);
    expect(report.checks.map((c: any) => c.id)).toEqual([
      'runtime', 'config', 'hooks', 'state', 'cost', 'proposals', 'dependencies',
      'permissions', 'docker-security', 'archive', 'reflect', 'scheduler', 'watchdog', 'opus-wake', 'heartbeat',
      'raw-size',
    ]);
  }));

  test('doctor-check (hooks: exec-form args are verified — missing script → fail)', withDir(async (dir) => {
    seedDoctor(dir,
      '{"agent_name":"test","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true},"routines":[]}');
    // Fake plugin root whose hooks.json references a script that doesn't exist,
    // in exec form (command: "bun", args: [path]) — the shape every real hook uses.
    const fakeRoot = path.join(dir, 'fake-plugin');
    fs.mkdirSync(path.join(fakeRoot, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, '.claude-plugin'), { recursive: true });
    write(path.join(fakeRoot, '.claude-plugin', 'plugin.json'), '{"name":"claude-code-hermit","version":"1.0.0"}');
    write(path.join(fakeRoot, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'bun', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/does-not-exist.ts'] }],
        }],
      },
    }));
    const c = checkById(await doctorReport(dir, { CLAUDE_PLUGIN_ROOT: fakeRoot }), 'hooks');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('does-not-exist.ts');
  }));

  test('doctor-check (hooks: real hooks.json passes — every exec-form arg resolves)', withDir(async (dir) => {
    seedDoctor(dir,
      '{"agent_name":"test","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true},"routines":[]}');
    const c = checkById(await doctorReport(dir), 'hooks');
    expect(c.status).toBe('ok');
  }));

  test('doctor-check (cost visibility — ok with data, detail has today spend)', withDir(async (dir) => {
    seedDoctor(dir,
      '{"agent_name":"test","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true},"routines":[]}');
    const today = new Date().toISOString().slice(0, 10);
    write(path.join(dir, '.claude', 'cost-log.jsonl'),
      `{"timestamp":"${today}T10:00:00.000Z","model":"claude-sonnet-4-6","input_tokens":100,"output_tokens":50,"cache_read_tokens":200,"total_tokens":350,"estimated_cost_usd":0.0012}\n`);
    const c = checkById(await doctorReport(dir), 'cost');
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('today');
  }));

  test('doctor-check (cost visibility — warn when no cost-log)', withDir(async (dir) => {
    seedDoctor(dir,
      '{"agent_name":"test","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true},"routines":[]}');
    const c = checkById(await doctorReport(dir), 'cost');
    expect(c.status).toBe('warn');
  }));

  test('doctor-check (cost-log resolved from hermit dir arg, not cwd)', withDir(async (dir) => {
    seedDoctor(dir);
    const today = new Date().toISOString().slice(0, 10);
    write(path.join(dir, '.claude', 'cost-log.jsonl'),
      `{"timestamp":"${today}T10:00:00.000Z","model":"claude-sonnet-4-6","input_tokens":100,"output_tokens":50,"cache_read_tokens":200,"total_tokens":350,"estimated_cost_usd":0.0012}\n`);
    // Run doctor from an UNRELATED cwd; the cost log must still be found via the
    // argv hermit dir (regression: it used to resolve .claude relative to cwd).
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cwd-'));
    try {
      const r = await runScript('doctor-check.ts', {
        args: [hermit(dir)], cwd: foreign, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      });
      expect(r.exitCode).toBe(0);
      const report = readJson(hermit(dir, 'state', 'doctor-report.json'));
      expect(checkById(report, 'cost').status).toBe('ok');
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  }));

  test('doctor-check (corrupt state → fail)', withDir(async (dir) => {
    seedDoctor(dir);
    write(hermit(dir, 'state', 'alert-state.json'), 'not json');
    const s = checkById(await doctorReport(dir), 'state');
    expect(s.status).toBe('fail');
    expect(s.detail).toContain('alert-state.json');
  }));

  test('doctor-check (missing config → fail, exits 0)', withDir(async (dir) => {
    fs.rmSync(hermit(dir, 'config.json'), { force: true });
    const c = checkById(await doctorReport(dir), 'config');
    expect(c.status).toBe('fail');
  }));

  test('doctor-check (opus-wake — ok when no cost-log)', withDir(async (dir) => {
    seedDoctor(dir);
    const c = checkById(await doctorReport(dir), 'opus-wake');
    expect(c.status).toBe('ok');
  }));

  test('doctor-check (opus-wake — ok when only sonnet automated turns)', withDir(async (dir) => {
    seedDoctor(dir);
    const today = new Date().toISOString().slice(0, 10);
    write(path.join(dir, '.claude', 'cost-log.jsonl'),
      `{"timestamp":"${today}T10:00:00.000Z","session_id":"s1","source":"heartbeat","model":"sonnet","total_tokens":100000,"estimated_cost_usd":0.05}\n`);
    const c = checkById(await doctorReport(dir), 'opus-wake');
    expect(c.status).toBe('ok');
  }));

  test('doctor-check (opus-wake — warn when automated turn runs on opus)', withDir(async (dir) => {
    seedDoctor(dir);
    const today = new Date().toISOString().slice(0, 10);
    write(path.join(dir, '.claude', 'cost-log.jsonl'), [
      `{"timestamp":"${today}T10:00:00.000Z","session_id":"s1","source":"heartbeat","model":"opus","total_tokens":100000,"estimated_cost_usd":7.50}`,
      `{"timestamp":"${today}T11:00:00.000Z","session_id":"s1","source":"routine:daily-auto-close","model":"opus","total_tokens":5000,"estimated_cost_usd":1.00}`,
      `{"timestamp":"${today}T12:00:00.000Z","session_id":"s1","source":"other","model":"opus","total_tokens":5000,"estimated_cost_usd":0.50}`,
      '',
    ].join('\n'));
    const c = checkById(await doctorReport(dir), 'opus-wake');
    expect(c.status).toBe('warn');
    // Only the heartbeat + routine rows count — "other" is not automated
    expect(c.detail).toContain('2');
    expect(c.detail).toContain('8.50');
  }));

  // heartbeat check unit cases (subprocess via doctorReport + seedDoctor)
  test('doctor-check heartbeat: disabled → ok', withDir(async (dir) => {
    seedDoctor(dir, '{"agent_name":"t","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":false},"routines":[]}');
    const c = checkById(await doctorReport(dir), 'heartbeat');
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('disabled');
  }));

  test('doctor-check heartbeat: enabled + no active session → ok', withDir(async (dir) => {
    seedDoctor(dir);
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"idle"}');
    const c = checkById(await doctorReport(dir), 'heartbeat');
    expect(c.status).toBe('ok');
  }));

  test('doctor-check heartbeat: enabled + active session + fresh liveness → ok', withDir(async (dir) => {
    seedDoctor(dir);
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"in_progress"}');
    write(hermit(dir, 'state', 'heartbeat-liveness.json'), `{"last_peek_at":"${new Date().toISOString()}"}`);
    const c = checkById(await doctorReport(dir), 'heartbeat');
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('ticking');
  }));

  test('doctor-check heartbeat: enabled + active session + stale liveness → fail', withDir(async (dir) => {
    seedDoctor(dir, '{"agent_name":"t","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true,"every":"2h"},"routines":[]}');
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"in_progress"}');
    // 7h ago — well past 3×2h=6h threshold
    const stale = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    write(hermit(dir, 'state', 'heartbeat-liveness.json'), `{"last_peek_at":"${stale}"}`);
    const c = checkById(await doctorReport(dir), 'heartbeat');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('Monitor subprocess spawn');
  }));

  test('doctor-check heartbeat: active session + liveness missing + recent started_at → ok (warming up)', withDir(async (dir) => {
    seedDoctor(dir);
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"in_progress"}');
    write(hermit(dir, 'state', 'heartbeat-monitor.runtime.json'), `{"started_at":"${new Date().toISOString()}"}`);
    const c = checkById(await doctorReport(dir), 'heartbeat');
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('warming up');
  }));

  test('doctor-check heartbeat: active session + liveness missing + old started_at → fail', withDir(async (dir) => {
    seedDoctor(dir, '{"agent_name":"t","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true,"every":"2h"},"routines":[]}');
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"in_progress"}');
    const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    write(hermit(dir, 'state', 'heartbeat-monitor.runtime.json'), `{"started_at":"${old}"}`);
    const c = checkById(await doctorReport(dir), 'heartbeat');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('Monitor subprocess spawn');
  }));

  test('doctor-check heartbeat: active session + liveness missing + no started_at → ok (not yet registered)', withDir(async (dir) => {
    seedDoctor(dir);
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"in_progress"}');
    // No heartbeat-monitor.runtime.json at all
    const c = checkById(await doctorReport(dir), 'heartbeat');
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('warming up');
  }));

  test('doctor-check heartbeat: liveness present but predates current monitor start → fail (not trusted)', withDir(async (dir) => {
    seedDoctor(dir, '{"agent_name":"t","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true,"every":"2h"},"routines":[]}');
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"in_progress"}');
    // Liveness is recent (4h ago, under the 6h threshold) but predates a monitor
    // restarted 3h ago — it is a leftover from the prior session, not proof of life.
    const peek = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const started = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    write(hermit(dir, 'state', 'heartbeat-liveness.json'), `{"last_peek_at":"${peek}"}`);
    write(hermit(dir, 'state', 'heartbeat-monitor.runtime.json'), `{"started_at":"${started}"}`);
    const c = checkById(await doctorReport(dir), 'heartbeat');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('Monitor subprocess spawn');
  }));

  test('doctor-check heartbeat: liveness missing + started_at past startup grace → fail', withDir(async (dir) => {
    seedDoctor(dir, '{"agent_name":"t","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true,"every":"2h"},"routines":[]}');
    write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"in_progress"}');
    // Started 10m ago — well under the 6h stale threshold but past the short
    // startup grace, so a missing first tick is a real blocked spawn.
    const started = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    write(hermit(dir, 'state', 'heartbeat-monitor.runtime.json'), `{"started_at":"${started}"}`);
    const c = checkById(await doctorReport(dir), 'heartbeat');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('Monitor subprocess spawn');
  }));
});

// -------------------------------------------------------
// Sibling manifest invariant (live monorepo walk)
// -------------------------------------------------------

const stripOp = (v: string) => v.replace(/^[<>=^~!]+/, '');

test('sibling manifests: required_core_version vs requires consistency', () => {
  const pluginsDir = path.join(MONOREPO_ROOT, 'plugins');
  for (const slug of fs.readdirSync(pluginsDir)) {
    const metaPath = path.join(pluginsDir, slug, '.claude-plugin', 'hermit-meta.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = readJson(metaPath);
    const rcv = meta.required_core_version;
    const req = meta.requires?.['claude-code-hermit'];
    if (rcv && req) {
      // Mismatch output includes the offending plugin slug.
      expect({ slug, required_core_version: rcv })
        .toEqual({ slug, required_core_version: req });
    }
  }
});

// The version triad spans two files: required_core_version lives in
// hermit-meta.json, the resolver dependency in plugin.json. The auditor's
// check 7 enforces this at release time; this pins it in CI so drift reddens.
test('sibling manifests: hermit-meta required_core_version vs plugin.json dependency base', () => {
  const pluginsDir = path.join(MONOREPO_ROOT, 'plugins');
  for (const slug of fs.readdirSync(pluginsDir)) {
    const metaPath = path.join(pluginsDir, slug, '.claude-plugin', 'hermit-meta.json');
    if (!fs.existsSync(metaPath)) continue;
    const rcv = readJson(metaPath).required_core_version;
    if (!rcv) continue;
    const pj = readJson(path.join(pluginsDir, slug, '.claude-plugin', 'plugin.json'));
    const dep = (pj.dependencies ?? []).find((d: { name: string }) => d.name === 'claude-code-hermit');
    expect({ slug, dependency: dep?.version }).not.toEqual({ slug, dependency: undefined });
    expect({ slug, base: stripOp(dep.version) }).toEqual({ slug, base: stripOp(rcv) });
  }
});

test('marketplace.json and plugin dirs are in sync (name + version, bidirectional)', () => {
  const root = MONOREPO_ROOT;
  const pluginsDir = path.join(root, 'plugins');
  const marketplace = readJson(path.join(root, '.claude-plugin', 'marketplace.json'));
  const listed = new Set<string>();

  for (const entry of marketplace.plugins) {
    // The source path is the canonical dir pointer; entry.name need not equal it.
    const dir = path.basename(entry.source);
    listed.add(dir);
    const pjPath = path.join(pluginsDir, dir, '.claude-plugin', 'plugin.json');
    expect({ name: entry.name, hasManifest: fs.existsSync(pjPath) })
      .toEqual({ name: entry.name, hasManifest: true });
    const pj = readJson(pjPath);
    expect({ name: entry.name, version: entry.version })
      .toEqual({ name: pj.name, version: pj.version });
  }

  for (const slug of fs.readdirSync(pluginsDir)) {
    if (!fs.existsSync(path.join(pluginsDir, slug, '.claude-plugin', 'plugin.json'))) continue;
    expect({ slug, listedInMarketplace: listed.has(slug) })
      .toEqual({ slug, listedInMarketplace: true });
  }
});

// -------------------------------------------------------
// checkDependencies (doctor-check, fake plugins/ tree)
// -------------------------------------------------------

describe('checkDependencies', () => {
  async function depsCheck(dir: string, fakeRoot: string) {
    seedDoctor(dir);
    return checkById(await doctorReport(dir, { CLAUDE_PLUGIN_ROOT: fakeRoot }), 'dependencies');
  }

  test('checkDependencies (sibling outside range → warn)', withDir(async (dir) => {
    const root = seedFakePlugins(dir, { sibling: true, meta: '{"required_core_version":">=2.0.0"}' });
    const d = await depsCheck(dir, root);
    expect(d.status).toBe('warn');
    expect(d.detail).toContain('outside');
  }));

  test('checkDependencies (sibling within range → ok)', withDir(async (dir) => {
    const root = seedFakePlugins(dir, { sibling: true, meta: '{"required_core_version":">=1.0.0"}' });
    const d = await depsCheck(dir, root);
    expect(d.status).toBe('ok');
    expect(d.detail).toContain('within');
  }));

  test('checkDependencies (sibling has no required_core_version → ok)', withDir(async (dir) => {
    const root = seedFakePlugins(dir, { sibling: true });
    const d = await depsCheck(dir, root);
    expect(d.status).toBe('ok');
    expect(d.detail).toContain('no sibling');
  }));

  test('checkDependencies (no siblings → ok)', withDir(async (dir) => {
    const root = seedFakePlugins(dir);
    const d = await depsCheck(dir, root);
    expect(d.status).toBe('ok');
  }));

  test('checkDependencies (tilde range outside → warn)', withDir(async (dir) => {
    const root = seedFakePlugins(dir, { sibling: true, meta: '{"required_core_version":"~2.0.0"}' });
    const d = await depsCheck(dir, root);
    expect(d.status).toBe('warn');
  }));

  test('checkDependencies (tilde range satisfied → ok)', withDir(async (dir) => {
    const root = seedFakePlugins(dir, {
      sibling: true, coreVersion: '1.0.25', meta: '{"required_core_version":"~1.0.20"}',
    });
    const d = await depsCheck(dir, root);
    expect(d.status).toBe('ok');
  }));

  test('checkDependencies (unparseable range → ok fail-open)', withDir(async (dir) => {
    const root = seedFakePlugins(dir, {
      sibling: true, coreVersion: '1.0.25', meta: '{"required_core_version":"not-a-range"}',
    });
    const d = await depsCheck(dir, root);
    expect(d.status).toBe('ok');
  }));

  test('checkDependencies (required_core_version in hermit-meta.json sidecar → ok)', withDir(async (dir) => {
    const root = seedFakePlugins(dir, {
      sibling: true,
      meta: '{"required_core_version":">=1.0.0","requires":{"claude-code-hermit":">=1.0.0"}}',
    });
    const d = await depsCheck(dir, root);
    expect(d.status).toBe('ok');
    expect(d.detail).toContain('within');
  }));

  // Versioned marketplace cache: siblings live two levels up under their own
  // version dirs. Regression: the old one-level scan saw only other core
  // versions → checked=0 → false "no siblings" all-clear.
  test('checkDependencies (versioned cache — out-of-range sibling → warn, not false ok)', withDir(async (dir) => {
    const root = seedVersionedCache(dir, { coreVersion: '1.2.14', siblingVersions: { '0.4.0': '>=2.0.0' } });
    const d = await depsCheck(dir, root);
    expect(d.status).toBe('warn');
    expect(d.detail).toContain('outside');
  }));

  test('checkDependencies (versioned cache — reads newest sibling version)', withDir(async (dir) => {
    // Older version satisfies core; newest does not. A warn proves the newest
    // version's meta (>=2.0.0) was the one read, not the older 0.3.0 (>=1.0.0).
    const root = seedVersionedCache(dir, {
      coreVersion: '1.2.14',
      siblingVersions: { '0.3.0': '>=1.0.0', '0.4.0': '>=2.0.0' },
    });
    const d = await depsCheck(dir, root);
    expect(d.status).toBe('warn');
    expect(d.detail).toContain('>=2.0.0');
  }));
});

// -------------------------------------------------------
// cidrOverlap pure helper (in-process import from doctor-check.ts)
// -------------------------------------------------------

test('cidrOverlap pure helper', () => {
  expect(cidrOverlap('172.28.0.0/24', '172.28.0.0/24')).toBe(true);  // identical /24 overlaps
  expect(cidrOverlap('172.28.0.0/16', '172.28.5.0/24')).toBe(true);  // /16 contains /24
  expect(cidrOverlap('172.28.0.0/24', '172.29.0.0/24')).toBe(false); // adjacent /24s disjoint
  expect(cidrOverlap('10.0.0.0/8', '172.28.0.0/24')).toBe(false);    // different blocks disjoint
  expect(cidrOverlap('bad-cidr', '172.28.0.0/24')).toBe(false);      // bad input fail-open
});

// -------------------------------------------------------
// doctor-check docker-security (fake docker on PATH)
// -------------------------------------------------------

describe('doctor-check docker-security', () => {
  async function dockerSecCheck(dir: string, dockerScript: string) {
    seedDockerSecurity(dir);
    const fake = fakeDocker(dockerScript);
    try {
      const report = await doctorReport(dir, { PATH: `${fake.bin}:${process.env.PATH}` });
      return checkById(report, 'docker-security');
    } finally {
      fake.cleanup();
    }
  }

  test('docker-security check (docker unavailable → warn, not fail)', withDir(async (dir) => {
    const d = await dockerSecCheck(dir, '#!/bin/bash\nexit 1\n');
    expect(d.status).toBe('warn');
  }));

  test('docker-security check (ports + network_mode:service → fail)', withDir(async (dir) => {
    const d = await dockerSecCheck(dir, `#!/bin/bash
if [[ "$*" == *"config"*"--format"*"json"* ]]; then
  echo '{"name":"testproj","services":{"hermit":{"ports":[{"target":3000,"published":"3000","protocol":"tcp","mode":"ingress"}],"network_mode":"service:hermit-netguard"}},"networks":{}}'
  exit 0
fi
if [[ "$*" == *"network ls"* ]]; then printf ''; exit 0; fi
exit 1
`);
    expect(d.status).toBe('fail');
    expect(d.detail).toContain('ports');
  }));

  test('docker-security check (subnet collision with other-net → warn)', withDir(async (dir) => {
    const d = await dockerSecCheck(dir, `#!/bin/bash
# compose config — no ports conflict
if [[ "$*" == *"config"*"--format"*"json"* ]]; then
  echo '{"name":"testproj","services":{"hermit":{"ports":[],"network_mode":"service:hermit-netguard"}},"networks":{}}'
  exit 0
fi
if [[ "$*" == *"network ls"* ]]; then printf 'other-net\\n'; exit 0; fi
if [[ "$*" == *"network inspect"* ]]; then
  # Return subnet that overlaps 172.28.0.0/24, no compose labels
  printf '172.28.0.0/24|||{}\\n'; exit 0
fi
exit 0
`);
    expect(d.status).toBe('warn');
    expect(d.detail).toContain('overlaps');
  }));

  test('docker-security check (own hermit-net excluded → ok)', withDir(async (dir) => {
    const d = await dockerSecCheck(dir, `#!/bin/bash
if [[ "$*" == *"config"*"--format"*"json"* ]]; then
  echo '{"name":"testproj","services":{"hermit":{"ports":[]}},"networks":{}}'
  exit 0
fi
if [[ "$*" == *"network ls"* ]]; then printf 'testproj_hermit-net\\n'; exit 0; fi
if [[ "$*" == *"network inspect"* ]]; then
  # Own hermit-net — same subnet but has the compose labels identifying it as ours
  printf '172.28.0.0/24|||{"com.docker.compose.project":"testproj","com.docker.compose.network":"hermit-net"}\\n'
  exit 0
fi
exit 0
`);
    expect(d.status).toBe('ok');
  }));
});

// -------------------------------------------------------
// checkArchival / checkReflectLoop (doctor-check)
// -------------------------------------------------------

describe('doctor-check archival + reflect loop', () => {
  const staleTs = () =>
    new Date(Date.now() - 5 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  test('checkArchival (stale in_progress → warn)', withDir(async (dir) => {
    seedDoctor(dir);
    write(hermit(dir, 'state', 'runtime.json'),
      `{"version":1,"session_state":"in_progress","session_id":"S-042","updated_at":"${staleTs()}"}`);
    const a = checkById(await doctorReport(dir), 'archive');
    expect(a.status).toBe('warn');
    expect(a.detail).toContain('stale active session');
  }));

  test('checkReflectLoop (unproductive ≥10 runs → warn)', withDir(async (dir) => {
    seedDoctor(dir);
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"counters":{"total_runs":20,"empty_runs":18,"proposals_created":0}}');
    const rc = checkById(await doctorReport(dir), 'reflect');
    expect(rc.status).toBe('warn');
    expect(rc.detail).toContain('unproductive');
  }));

  test('checkArchival (idle + non-null session_id → warn)', withDir(async (dir) => {
    seedDoctor(dir);
    write(hermit(dir, 'state', 'runtime.json'),
      `{"version":1,"session_state":"idle","session_id":"S-042","updated_at":"${staleTs()}"}`);
    const a = checkById(await doctorReport(dir), 'archive');
    expect(a.status).toBe('warn');
    expect(a.detail).toContain('orphaned session');
  }));
});
