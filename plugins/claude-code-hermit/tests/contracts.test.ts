// Contract tests for claude-code-hermit (bun test port of the non-hermit-start
// classes in run-contracts.py; the hermit-start internals live in
// tests/hermit-start.test.ts).
//
// Only add tests for silent breakage — not for every branch in every helper.
// Tests cover: hook outputs, cache-edit-guard, stderr sanitization, cron corpus,
// validate-config blocks (monitors, push_notifications, routine model, primary),
// the outbound-channel resolver, proposal-id scheme, and skill/agent content
// contracts (analytics skills, kill metrics, procedure capture, bootstrap
// skills, gate-agent memory, external-origin quarantine).
//
// Hooks are exercised as subprocesses (runScript) because that is the boundary
// Claude Code sees. Pure exports (validate, validateCronSchedule, resolve) are
// imported in-process — the Python suite shelled out to `bun -e` only because
// it could not import TypeScript.
//
// Usage: bun test tests/contracts.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';
import { fixturesDir } from './helpers/workdir';
import { validateCronSchedule, validate } from '../scripts/validate-config';
import { resolve } from '../scripts/resolve-outbound-channel';

const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');
const SKILLS = path.join(PLUGIN_ROOT, 'skills');
const AGENTS = path.join(PLUGIN_ROOT, 'agents');
const TEMPLATES = path.join(PLUGIN_ROOT, 'state-templates');

const read = (p: string) => fs.readFileSync(p, 'utf-8');
const readJson = (p: string) => JSON.parse(read(p));

// ---------- tempdir harness (port of _TempDirTest, no chdir needed: cwd is
// passed to spawned processes instead) ----------

function makeTmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-contracts-'));
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

/** Run a test body inside a throwaway tempdir, always cleaning up. */
function withTmpdir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = makeTmpdir();
    try {
      await fn(dir);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
}

const writeConfig = (dir: string, config: any) =>
  fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'config.json'), JSON.stringify(config));

async function runDoctorCheck(dir: string): Promise<any> {
  const r = await runScript('doctor-check.ts', {
    args: ['.claude-code-hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  return r.exitCode === 0 ? JSON.parse(r.stdout) : {};
}

/** Emulate Python str.split(sep, 2): at most 3 parts, remainder in the last. */
function split3(content: string, sep: string): string[] {
  const parts: string[] = [];
  let rest = content;
  for (let i = 0; i < 2; i++) {
    const idx = rest.indexOf(sep);
    if (idx === -1) break;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  parts.push(rest);
  return parts;
}

/** Read the YAML frontmatter block (between the two `---` delimiters) of an agent definition. */
function agentFrontmatter(name: string): string {
  const p = path.join(AGENTS, `${name}.md`);
  expect(fs.existsSync(p)).toBe(true);
  const parts = split3(read(p), '---\n');
  expect(parts.length).toBe(3); // agent file missing closing --- of frontmatter
  return parts[1];
}

function extractBlock(text: string, startSentinel: string, endSentinel: string): string {
  const start = text.indexOf(startSentinel);
  const end = text.indexOf(endSentinel, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end + endSentinel.length);
}

// ============================================================
// Hook output tests (TestHookOutputs)
// ============================================================

describe('hook outputs', () => {
  test('cost-log.jsonl entry has required keys with correct types', withTmpdir(async (dir) => {
    const transcript = path.join(dir, '.claude', 'transcript.jsonl');
    fs.copyFileSync(path.join(fixturesDir, 'transcript.jsonl'), transcript);

    const fixture = readJson(path.join(fixturesDir, 'stop-hook-input.json'));
    const hookInput = JSON.stringify({ ...fixture, transcript_path: transcript, cwd: dir });

    const r = await runScript('cost-tracker.ts', {
      stdin: hookInput, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);

    const logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const entry = JSON.parse(read(logPath).trim().split('\n')[0]);
    expect(typeof entry.session_id).toBe('string');
    expect(typeof entry.estimated_cost_usd).toBe('number');
    expect(typeof entry.timestamp).toBe('string');
    expect(entry.estimated_cost_usd).toBeGreaterThan(0);
    // schema v2 fields
    expect(typeof entry.api_calls).toBe('number');
    expect(entry.api_calls).toBeGreaterThanOrEqual(1);
    if (entry.context_usage !== null) { expect(typeof entry.context_usage).toBe('number'); }
  }), 15000);

  test('standard profile produces structured JSON with criteria', withTmpdir(async (dir) => {
    const r = await runScript('evaluate-session.ts', {
      stdin: '{}', cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, AGENT_HOOK_PROFILE: 'standard' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).not.toBe('');
    const data = JSON.parse(r.stdout);
    expect(data).toContainKey('criteria');
    expect(Array.isArray(data.criteria)).toBe(true);
    expect(data.criteria.length).toBeGreaterThan(0);
    expect(data).toContainKey('overall');
  }), 15000);

  test('minimal profile produces no stdout (silence is the contract)', withTmpdir(async (dir) => {
    const r = await runScript('evaluate-session.ts', {
      stdin: '{}', cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, AGENT_HOOK_PROFILE: 'minimal' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }), 15000);
});

// ============================================================
// cache-edit-guard hook (TestCacheEditGuard)
//
// Project-local marketplaces load from `source` at runtime; cache copies are
// stale. Editing a cache file works *until* the bridge restarts and the source
// is read instead. The guard must catch this.
// ============================================================

const runGuard = (dir: string, event: any, env: Record<string, string> = {}) =>
  runScript('cache-edit-guard.ts', {
    stdin: JSON.stringify(event), cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
  });

/** Write .claude-plugin/marketplace.json + create the plugin source dir. */
function seedMarketplace(dir: string, pluginSource: any = './services/sample-plugin'): void {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  const manifest = {
    name: 'example-marketplace',
    plugins: [{ name: 'sample-plugin', source: pluginSource }],
  };
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify(manifest));
  if (typeof pluginSource === 'string') {
    fs.mkdirSync(path.join(dir, pluginSource.replace(/^\.\//, '')), { recursive: true });
  }
}

const cachePath = (dir: string, ...parts: string[]) =>
  path.join(dir, '.claude/plugins/cache/example-marketplace/sample-plugin/0.1.0', ...parts);

describe('cache-edit-guard', () => {
  test('cache edit warns with source path', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: cachePath(dir, 'server.ts') },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).toContain('marketplace cache copy');
    expect(r.stderr).toContain('services/sample-plugin/server.ts');
  }), 15000);

  test('block mode exits 2', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(
      dir,
      { tool_name: 'Write', tool_input: { file_path: cachePath(dir, 'server.ts') } },
      { HERMIT_CACHE_GUARD: 'block' },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
  }), 15000);

  test('remote git source is skipped silently', withTmpdir(async (dir) => {
    // Remote git refs are objects — guard must skip silently.
    seedMarketplace(dir, { source: 'github', repo: 'someone/sample-plugin' });
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: cachePath(dir, 'server.ts') },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }), 15000);

  test('non-cache path passes through', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'README.md') },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }), 15000);

  test('non-edit tool passes through', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Read',
      tool_input: { file_path: cachePath(dir, 'server.ts') },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }), 15000);

  test('no marketplace.json passes through (foreign repo)', withTmpdir(async (dir) => {
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: cachePath(dir, 'server.ts') },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }), 15000);

  test('unknown marketplace passes through', withTmpdir(async (dir) => {
    // Cache path names a marketplace not declared in this project's manifest.
    seedMarketplace(dir);
    const unknownCache = path.join(
      dir, '.claude/plugins/cache/some-other-marketplace/foo/0.1.0/index.js',
    );
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: unknownCache },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }), 15000);
});

// ============================================================
// Stderr sanitization (TestStderrSanitization)
//
// Adversarial tool_input values must not produce raw control chars in hook stderr.
// ============================================================

describe('stderr sanitization', () => {
  // Inject adversarial chars into the version segment ([^/]+ matches \n
  // and ESC), not the leaf ((.*)$ stops at \n and the regex fails).
  const evilCachePath = (dir: string, version: string, leaf = 'server.ts') =>
    path.join(dir, '.claude/plugins/cache/example-marketplace/sample-plugin', version, leaf);

  test('cache guard strips newline in path', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: evilCachePath(dir, '0.1.0\nBAD') },
    });
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).not.toContain('\nBAD');
    expect(r.stderr).toContain('0.1.0?BAD');
  }), 15000);

  test('cache guard strips ANSI in path', withTmpdir(async (dir) => {
    // ANSI in the leaf exercises BOTH safe(filePath) and safe(canonical):
    // canonical = path.join(sourceRoot, leaf), so a poisoned leaf taints
    // canonical too. The leaf regex `(.*)$` accepts \x1b (not a line
    // terminator), so the warning path still runs.
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: evilCachePath(dir, '0.1.0', 'srv\x1b[32mOK\x1b[0m.ts') },
    });
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).not.toContain('\x1b');
    expect(r.stderr).toContain('OK');
  }), 15000);

  test('cache guard strips C1 CSI', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: evilCachePath(dir, '0.1.0\x9b32mFAKE\x9b0m') },
    });
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).not.toContain('\x9b');
  }), 15000);

  test('channel hook strips chat_id control chars', withTmpdir(async (dir) => {
    writeConfig(dir, { channels: { discord: { enabled: true, dm_channel_id: null } } });
    const r = await runScript('channel-hook.ts', {
      stdin: JSON.stringify({
        tool_name: 'mcp__discord__reply',
        tool_input: { chat_id: 'abc\n\x1b[31mFAKE\x1b[0m' },
      }),
      cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.stderr).toContain('saved discord.dm_channel_id');
    expect(r.stderr).not.toContain('\x1b');
    expect(r.stderr).not.toContain('\nFAKE');
  }), 15000);
});

// ============================================================
// Cron corpus agreement (TestCronCorpus)
//
// validate-config.ts validateCronSchedule() must accept the shared corpus of
// valid expressions and reject the invalid ones. Cron schedules are consumed
// directly by CronCreate (via /hermit-routines) — only config-time validation
// remains.
// ============================================================

describe('cron corpus', () => {
  const corpus = readJson(path.join(import.meta.dir, 'cron-test-corpus.json'));

  test('validateCronSchedule() accepts valid expressions', () => {
    const fails: string[] = [];
    for (const c of corpus.valid_expressions) {
      const err = validateCronSchedule(c.schedule);
      if (err) fails.push(`${c.schedule}: ${err}`);
    }
    expect(fails).toEqual([]);
  });

  test('validateCronSchedule() rejects invalid expressions', () => {
    const fails: string[] = [];
    for (const c of corpus.invalid_expressions) {
      const err = validateCronSchedule(c.schedule);
      if (!err) fails.push(c.schedule);
    }
    expect(fails).toEqual([]);
  });
});

// ============================================================
// validate-config blocks (TestMonitorsValidation, TestPushNotificationsValidation,
// TestRoutineModelValidation)
// ============================================================

// Minimal valid config to merge overrides into
const BASE_CONFIG = {
  agent_name: null, language: null, timezone: null,
  escalation: 'balanced', channels: {}, env: {},
  heartbeat: { enabled: true, active_hours: { start: '08:00', end: '23:00' } },
  routines: [],
  quality_gate: { tier: 'budget' },
};

const runValidate = (overrides: any) => validate({ ...BASE_CONFIG, ...overrides });

describe('monitors validation', () => {
  test('a fully valid monitor entry produces no errors or warnings', () => {
    const out = runValidate({ monitors: [
      { id: 'cpu', description: 'CPU watch', command: 'top -bn1',
        class: 'poll', timeout_ms: 5000, persistent: false, enabled: true },
    ] });
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  test('monitors must be an array — non-array value is an error', () => {
    const out = runValidate({ monitors: 'bad' });
    expect(out.errors.some((e: string) => e.includes('monitors: must be an array'))).toBe(true);
  });

  test('monitor without id is an error', () => {
    const out = runValidate({ monitors: [{ description: 'no id here', command: 'true' }] });
    expect(out.errors.some((e: string) => e.includes('missing or invalid id'))).toBe(true);
  });

  test('two monitors sharing the same id produce a warning', () => {
    const out = runValidate({ monitors: [
      { id: 'dup', description: 'first', command: 'true' },
      { id: 'dup', description: 'second', command: 'true' },
    ] });
    expect(out.warnings.some((w: string) => w.includes('duplicate id'))).toBe(true);
  });

  test('class value not in (stream, poll) is an error', () => {
    const out = runValidate({ monitors: [
      { id: 'm1', description: 'desc', command: 'true', class: 'bad' },
    ] });
    expect(out.errors.some((e: string) => e.includes('class must be'))).toBe(true);
  });

  test('timeout_ms below 1000 is an error', () => {
    const out = runValidate({ monitors: [
      { id: 'm1', description: 'desc', command: 'true', timeout_ms: 500 },
    ] });
    expect(out.errors.some((e: string) => e.includes('timeout_ms'))).toBe(true);
  });

  test('monitor missing both description and command produces two errors', () => {
    const out = runValidate({ monitors: [{ id: 'm1' }] });
    expect(out.errors.some((e: string) => e.includes('missing description'))).toBe(true);
    expect(out.errors.some((e: string) => e.includes('missing command'))).toBe(true);
  });
});

describe('remote validation', () => {
  test('remote: true and false are both valid', () => {
    for (const val of [true, false]) {
      const out = runValidate({ remote: val });
      expect(out.errors.some((e: string) => e.includes('remote'))).toBe(false);
    }
  });

  test('remote must be a boolean — strings are rejected', () => {
    const out = runValidate({ remote: 'yes' });
    expect(out.errors.some((e: string) => e.includes('remote'))).toBe(true);
  });

  test('remote absent produces no error (falls through to template default)', () => {
    const out = runValidate({});
    expect(out.errors.some((e: string) => e.includes('remote'))).toBe(false);
  });
});

describe('idle_behavior validation', () => {
  test('wait and discover are both valid', () => {
    for (const val of ['wait', 'discover']) {
      const out = runValidate({ idle_behavior: val });
      expect(out.errors.some((e: string) => e.includes('idle_behavior'))).toBe(false);
    }
  });

  test('idle_behavior: bogus is an error', () => {
    const out = runValidate({ idle_behavior: 'bogus' });
    expect(out.errors.some((e: string) => e.includes('idle_behavior'))).toBe(true);
  });

  test('idle_behavior: null is treated as absent — no error', () => {
    const out = runValidate({ idle_behavior: null });
    expect(out.errors.some((e: string) => e.includes('idle_behavior'))).toBe(false);
  });
});

describe('permission_mode validation (type-only — no enum, Claude Code owns the set)', () => {
  test('any string value produces no error, including values the hermit does not recognize', () => {
    const out = runValidate({ permission_mode: 'bogus' });
    expect(out.errors.some((e: string) => e.includes('permission_mode'))).toBe(false);
  });

  test('non-string permission_mode is an error', () => {
    const out = runValidate({ permission_mode: 5 });
    expect(out.errors.some((e: string) => e.includes('permission_mode'))).toBe(true);
  });

  test('permission_mode absent or null produces no error', () => {
    expect(runValidate({}).errors.some((e: string) => e.includes('permission_mode'))).toBe(false);
    expect(runValidate({ permission_mode: null }).errors.some((e: string) => e.includes('permission_mode'))).toBe(false);
  });
});

describe('push_notifications validation', () => {
  test('push_notifications: true and false are both valid', () => {
    for (const val of [true, false]) {
      const out = runValidate({ push_notifications: val });
      expect(out.errors.some((e: string) => e.includes('push_notifications'))).toBe(false);
    }
  });

  test('push_notifications must be a boolean — strings are rejected', () => {
    const out = runValidate({ push_notifications: 'yes' });
    expect(out.errors.some((e: string) => e.includes('push_notifications'))).toBe(true);
  });
});

describe('routine model validation', () => {
  const BASE_ROUTINE = {
    id: 'check', schedule: '0 9 * * *', skill: 'claude-code-hermit:recall', enabled: true,
  };
  const HB_ROUTINE = {
    id: 'heartbeat-restart', schedule: '0 4 * * *',
    skill: 'claude-code-hermit:heartbeat start', run_during_waiting: true, enabled: true,
  };

  test('each valid model value on a routine produces no errors', () => {
    for (const model of ['haiku', 'sonnet', 'opus']) {
      const out = runValidate({ routines: [{ ...BASE_ROUTINE, model }] });
      expect(out.errors).toEqual([]);
    }
  });

  test('routine without model field produces no model-related error', () => {
    const out = runValidate({ routines: [BASE_ROUTINE] });
    expect(out.errors.some((e: string) => e.includes('model'))).toBe(false);
  });

  test('model: null is treated as absent — no error', () => {
    const out = runValidate({ routines: [{ ...BASE_ROUTINE, model: null }] });
    expect(out.errors.some((e: string) => e.includes('model'))).toBe(false);
  });

  test('model: haik (typo) is an error', () => {
    const out = runValidate({ routines: [{ ...BASE_ROUTINE, model: 'haik' }] });
    expect(out.errors.some((e: string) => e.includes('not in'))).toBe(true);
  });

  test('model: 5 (non-string) is an error', () => {
    const out = runValidate({ routines: [{ ...BASE_ROUTINE, model: 5 }] });
    expect(out.errors.some((e: string) => e.includes('not in'))).toBe(true);
  });

  test('model on heartbeat-restart produces a warning (ignored), not an error', () => {
    const out = runValidate({ routines: [{ ...HB_ROUTINE, model: 'haiku' }] });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w: string) => w.includes('ignored'))).toBe(true);
  });
});

// ============================================================
// context_hygiene.compact validation (PROP-011 commit 3)
// ============================================================

describe('context_hygiene validation', () => {
  test('a fully valid compact block produces no errors or warnings', () => {
    const out = runValidate({ context_hygiene: { compact: {
      enabled: true, min_context_tokens: 150000, min_interval: '4h',
    } } });
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  test('context_hygiene must be an object — non-object value is an error', () => {
    const out = runValidate({ context_hygiene: 'bad' });
    expect(out.errors.some((e: string) => e.includes('context_hygiene: must be an object'))).toBe(true);
  });

  test('context_hygiene.compact must be an object — non-object value is an error', () => {
    const out = runValidate({ context_hygiene: { compact: 'bad' } });
    expect(out.errors.some((e: string) => e.includes('context_hygiene.compact: must be an object'))).toBe(true);
  });

  test('compact.enabled non-boolean is an error', () => {
    const out = runValidate({ context_hygiene: { compact: { enabled: 'yes' } } });
    expect(out.errors.some((e: string) => e.includes('context_hygiene.compact.enabled: must be a boolean'))).toBe(true);
  });

  test('compact.min_context_tokens non-positive is an error', () => {
    const out = runValidate({ context_hygiene: { compact: { min_context_tokens: 0 } } });
    expect(out.errors.some((e: string) => e.includes('min_context_tokens: must be a positive number'))).toBe(true);
  });

  test('compact.min_context_tokens non-number is an error', () => {
    const out = runValidate({ context_hygiene: { compact: { min_context_tokens: '150000' } } });
    expect(out.errors.some((e: string) => e.includes('min_context_tokens: must be a positive number'))).toBe(true);
  });

  test('compact.min_interval non-string is a warning, not an error', () => {
    const out = runValidate({ context_hygiene: { compact: { min_interval: 4 } } });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w: string) => w.includes('min_interval: should be a duration string'))).toBe(true);
  });

  test('context_hygiene without compact key produces no errors', () => {
    const out = runValidate({ context_hygiene: {} });
    expect(out.errors).toEqual([]);
  });

  test('absent context_hygiene block produces no errors', () => {
    const out = runValidate({});
    expect(out.errors.filter((e: string) => e.includes('context_hygiene'))).toEqual([]);
  });
});

// ============================================================
// doctor.routine_cost_floor_usd validation
// ============================================================

describe('doctor config validation', () => {
  test('valid routine_cost_floor_usd produces no errors', () => {
    const out = runValidate({ doctor: { routine_cost_floor_usd: 5 } });
    expect(out.errors).toEqual([]);
  });

  test('negative routine_cost_floor_usd is an error', () => {
    const out = runValidate({ doctor: { routine_cost_floor_usd: -1 } });
    expect(out.errors.some((e: string) => e.includes('routine_cost_floor_usd: expected non-negative number'))).toBe(true);
  });

  test('non-number routine_cost_floor_usd is an error', () => {
    const out = runValidate({ doctor: { routine_cost_floor_usd: '5' } });
    expect(out.errors.some((e: string) => e.includes('routine_cost_floor_usd: expected non-negative number'))).toBe(true);
  });

  test('absent doctor block produces no errors', () => {
    const out = runValidate({});
    expect(out.errors.filter((e: string) => e.includes('doctor'))).toEqual([]);
  });
});

// ============================================================
// budget validation (PROP-016)
// ============================================================

describe('budget validation', () => {
  test('a fully valid budget block (all three caps) produces no errors', () => {
    const out = runValidate({ budget: { daily_usd: 5, weekly_usd: 25, monthly_usd: 100, action: 'alert' } });
    expect(out.errors).toEqual([]);
  });

  test('null caps are valid (disables that window)', () => {
    const out = runValidate({ budget: { daily_usd: null, weekly_usd: null, monthly_usd: null, action: 'pause' } });
    expect(out.errors).toEqual([]);
  });

  test('absent budget block produces no errors', () => {
    const out = runValidate({});
    expect(out.errors.filter((e: string) => e.includes('budget'))).toEqual([]);
  });

  test('negative daily_usd is an error', () => {
    const out = runValidate({ budget: { daily_usd: -5 } });
    expect(out.errors.some((e: string) => e.includes('budget.daily_usd: must be a positive number or null'))).toBe(true);
  });

  test('zero weekly_usd is an error', () => {
    const out = runValidate({ budget: { weekly_usd: 0 } });
    expect(out.errors.some((e: string) => e.includes('budget.weekly_usd: must be a positive number or null'))).toBe(true);
  });

  test('non-number monthly_usd is an error', () => {
    const out = runValidate({ budget: { monthly_usd: '100' } });
    expect(out.errors.some((e: string) => e.includes('budget.monthly_usd: must be a positive number or null'))).toBe(true);
  });

  test('invalid action is an error', () => {
    const out = runValidate({ budget: { action: 'notify' } });
    expect(out.errors.some((e: string) => e.includes('budget.action: "notify" not in [alert, pause]'))).toBe(true);
  });

  test('budget block with only one cap set is valid', () => {
    const out = runValidate({ budget: { monthly_usd: 100 } });
    expect(out.errors).toEqual([]);
  });
});

describe('artifacts validation', () => {
  test('a fully valid artifacts block (all three flags) produces no errors', () => {
    const out = runValidate({ artifacts: { dashboard: true, proposals: true, weekly_review: false } });
    expect(out.errors).toEqual([]);
  });

  test('absent artifacts block produces no errors', () => {
    const out = runValidate({});
    expect(out.errors.filter((e: string) => e.includes('artifacts'))).toEqual([]);
  });

  test('non-object artifacts is an error', () => {
    const out = runValidate({ artifacts: 'bad' });
    expect(out.errors.some((e: string) => e.includes('artifacts: must be an object'))).toBe(true);
  });

  test('non-boolean artifacts.dashboard is an error', () => {
    const out = runValidate({ artifacts: { dashboard: 'yes' } });
    expect(out.errors.some((e: string) => e.includes('artifacts.dashboard: must be a boolean'))).toBe(true);
  });

  test('non-boolean artifacts.proposals is an error', () => {
    const out = runValidate({ artifacts: { proposals: 1 } });
    expect(out.errors.some((e: string) => e.includes('artifacts.proposals: must be a boolean'))).toBe(true);
  });

  test('non-boolean artifacts.weekly_review is an error', () => {
    const out = runValidate({ artifacts: { weekly_review: null } });
    expect(out.errors.some((e: string) => e.includes('artifacts.weekly_review: must be a boolean'))).toBe(true);
  });

  test('artifacts.publish_authorized accepts true, false, and null', () => {
    for (const value of [true, false, null]) {
      const out = runValidate({ artifacts: { publish_authorized: value } });
      expect(out.errors.filter((e: string) => e.includes('publish_authorized'))).toEqual([]);
    }
  });

  test('non-boolean, non-null artifacts.publish_authorized is an error', () => {
    const out = runValidate({ artifacts: { publish_authorized: 'yes' } });
    expect(out.errors.some((e: string) => e.includes('artifacts.publish_authorized: must be a boolean or null'))).toBe(true);
  });
});

// ============================================================
// Outbound channel resolver (TestChannelResolverContract)
//
// Verifies resolution order, primary override, eligibility gates, and the
// validate-config.ts special-case for channels.primary.
// ============================================================

describe('channel resolver contract', () => {
  /** Port of _run_resolver: resolve() in-process; (code, result) tuple shape kept. */
  function runResolver(config: any): { code: number; result: any } {
    const r = resolve(config.channels ?? {});
    return r === null
      ? { code: 1, result: { error: 'no_reachable_channel' } }
      : { code: 0, result: r };
  }

  test('channels.primary picks the named channel when eligible — wins over config order', () => {
    // telegram is listed first; primary points at discord — discord must win.
    const { code, result } = runResolver({ channels: {
      primary: 'discord',
      telegram: { enabled: true, dm_channel_id: 'T1' },
      discord: { enabled: true, dm_channel_id: 'D1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('discord');
    expect(result.chat_id).toBe('D1');
  });

  test('primary channel missing dm_channel_id falls through to first eligible in config order', () => {
    const { code, result } = runResolver({ channels: {
      primary: 'discord',
      discord: { enabled: true, dm_channel_id: null },
      telegram: { enabled: true, dm_channel_id: 'T1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('telegram');
  });

  test('no primary — first eligible entry in config order wins (no hardcoded slug list)', () => {
    // telegram listed first should win — proves there's no built-in preference for discord.
    const { code, result } = runResolver({ channels: {
      telegram: { enabled: true, dm_channel_id: 'T1' },
      discord: { enabled: true, dm_channel_id: 'D1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('telegram');
  });

  test('a future/third-party channel slug is picked up without resolver changes', () => {
    const { code, result } = runResolver({ channels: {
      whatsapp: { enabled: true, dm_channel_id: 'W1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('whatsapp');
  });

  test('primary channel with enabled:false is skipped (policy gate)', () => {
    const { code, result } = runResolver({ channels: {
      primary: 'discord',
      discord: { enabled: false, dm_channel_id: 'D1' },
      telegram: { enabled: true, dm_channel_id: 'T1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('telegram');
  });

  test('validator rejects channels.primary referencing a missing channel', () => {
    const result = validate({ channels: { primary: 'ghost', discord: { dm_channel_id: 'D1' } } });
    expect(
      (result.errors ?? []).some((e: string) => e.includes('primary') && e.includes('ghost')),
    ).toBe(true);
  });

  test('validator accepts channels.primary pointing to an existing channel', () => {
    const result = validate({ channels: { primary: 'discord', discord: { dm_channel_id: 'D1' } } });
    const primaryErrors = (result.errors ?? []).filter((e: string) => e.includes('primary'));
    expect(primaryErrors).toEqual([]);
  });

  test('allowed_users: [] disables the channel for proactive sends', () => {
    const { code, result } = runResolver({ channels: {
      discord: { enabled: true, dm_channel_id: 'D1', allowed_users: [] },
      telegram: { enabled: true, dm_channel_id: 'T1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('telegram');
  });

  test('missing config.json: exit 1, JSON error on stdout with detail+path', async () => {
    // CLI-path coverage (exit codes) — spawn the resolver directly.
    const r = await runScript('resolve-outbound-channel.ts', { args: ['/nope/missing-dir'] });
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.error).toBe('config_read_failed');
    expect(payload).toContainKey('detail');
    expect(payload.path ?? '').toContain('/nope/missing-dir');
  }, 15000);

  test("channels.primary: 'primary' would point at the string itself — falls through", () => {
    const { code, result } = runResolver({ channels: {
      primary: 'primary',
      discord: { enabled: true, dm_channel_id: 'D1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('discord');
  });

  test("validator rejects channels.primary pointing at the string 'primary' (self)", () => {
    const result = validate({ channels: {
      primary: 'primary',
      discord: { dm_channel_id: 'D1' },
    } });
    expect(
      (result.errors ?? []).some(
        (e: string) => e.includes('primary') && e.includes('channel-config object'),
      ),
    ).toBe(true);
  });

  test('channels.primary must be a string', () => {
    const result = validate({ channels: { primary: 42, discord: { dm_channel_id: 'D1' } } });
    expect(
      (result.errors ?? []).some((e: string) => e.includes('primary') && e.includes('string')),
    ).toBe(true);
  });

  test('validator rejects a numeric allowed_users entry (would break the string sender gate)', () => {
    const result = validate({ channels: { discord: { dm_channel_id: 'D1', allowed_users: [123456789012345678] } } });
    expect(
      (result.errors ?? []).some((e: string) => e.includes('allowed_users') && e.includes('string')),
    ).toBe(true);
  });

  test('validator accepts string allowed_users entries', () => {
    const result = validate({ channels: { discord: { dm_channel_id: 'D1', allowed_users: ['123456789012345678'] } } });
    expect((result.errors ?? []).filter((e: string) => e.includes('allowed_users'))).toEqual([]);
  });
});

// ============================================================
// Proposal ID scheme (TestProposalIdScheme)
//
// Guards against silent regressions: scripts narrowing the filename regex back
// to the legacy-only form, or session-archive.ts losing the full-ID capture pattern.
// ============================================================

describe('proposal-id scheme', () => {
  const WIDENED_REGEX = String.raw`/^PROP-\d+(?:-.+)?\.md$/`;
  const SESSION_ARCHIVE_REGEX = '/PROP-[a-z0-9][a-z0-9-]*/gi';
  const SCRIPTS_WITH_PROPOSAL_GLOB = ['reflect-precheck.ts', 'weekly-review.ts', 'doctor-check.ts'];

  test('all proposal-scanning scripts must contain the widened filename regex', () => {
    for (const script of SCRIPTS_WITH_PROPOSAL_GLOB) {
      const p = path.join(SCRIPTS, script);
      expect(fs.existsSync(p)).toBe(true);
      // missing → new-format PROP-NNN-slug-HHMMSS.md files silently dropped
      expect(read(p)).toContain(WIDENED_REGEX);
    }
  });

  test('session-archive.ts must use a regex that captures the full PROP-NNN-slug-HHMMSS form', () => {
    const p = path.join(SCRIPTS, 'session-archive.ts');
    expect(fs.existsSync(p)).toBe(true);
    // missing → new-format IDs truncated to PROP-NNN in session reports
    expect(read(p)).toContain(SESSION_ARCHIVE_REGEX);
  });
});

// ============================================================
// Analytics skills contract (TestAnalyticsSkillsContract, PROP-038)
//
// Guards against copy-paste drift between the directory name, the frontmatter
// `name` field, and the channel-reply step that downstream operators depend on.
// ============================================================

describe('analytics skills contract', () => {
  const ANALYTICS_SKILLS = ['hermit-evolution', 'hermit-health'];

  function readSkill(slug: string): string {
    const p = path.join(SKILLS, slug, 'SKILL.md');
    expect(fs.existsSync(p)).toBe(true);
    return read(p);
  }

  test('frontmatter name matches directory', () => {
    for (const slug of ANALYTICS_SKILLS) {
      const content = readSkill(slug);
      const parts = split3(content, '---\n');
      expect(parts.length).toBe(3); // missing closing --- of frontmatter
      expect(parts[0]).toBe(''); // content before opening --- delimiter
      const head = parts[1];
      expect(head).toContain(`name: ${slug}`);
      expect(head).toContain('description:');
    }
  });

  test('each analytics skill must keep its Step 0 channel-reply branch (PROP-037 contract)', () => {
    for (const slug of ANALYTICS_SKILLS) {
      const content = readSkill(slug);
      expect(content).toContain('Channel reply');
      expect(content).toContain('<channel source=');
    }
  });

  test('each analytics skill declares the ≤1500-char channel budget', () => {
    for (const slug of ANALYTICS_SKILLS) {
      expect(readSkill(slug)).toContain('1500 chars');
    }
  });
});

// ============================================================
// Plain spend statement contract (cost-reflect --plain routing)
//
// Guards against a future edit silently reverting a channel cost question to
// the jargon-laden raw table: cost-reflect's channel branch must run --plain,
// and channel-responder must route spend questions to cost-reflect rather than
// falling through to a free-form model turn (the actual no-jargon guarantee on
// --plain's OUTPUT is verified at runtime in cost-reflect-plain.test.ts).
// ============================================================

describe('plain spend statement routing contract', () => {
  const costReflect = read(path.join(SKILLS, 'cost-reflect', 'SKILL.md'));
  const channelResponder = read(path.join(SKILLS, 'channel-responder', 'SKILL.md'));

  test('cost-reflect channel branch runs --plain, not the raw breakdown', () => {
    expect(costReflect).toContain('--plain');
  });

  test('channel-responder routes spend questions to cost-reflect', () => {
    expect(channelResponder).toContain('cost-reflect');
    expect(channelResponder.toLowerCase()).toContain('spend request');
  });
});

// ============================================================
// Kill metrics contract (TestKillMetricsContract)
//
// Guards against the silent breakage where capability-brainstorm (or any future
// brainstorm skill) declares kill criteria that grep for an origin token that no
// writer ever emits. The three emitter shapes and the kill-criteria grep targets
// must stay in sync — so each assertion checks both sides of the contract.
// ============================================================

describe('kill metrics contract', () => {
  const proposalTemplate = read(path.join(TEMPLATES, 'PROPOSAL.md.template'));
  const proposalCreate = read(path.join(SKILLS, 'proposal-create', 'SKILL.md'));
  const capabilityBrainstorm = read(path.join(SKILLS, 'capability-brainstorm', 'SKILL.md'));
  const reportScriptPath = path.join(SCRIPTS, 'proposal-metrics-report.ts');
  const reportScript = fs.existsSync(reportScriptPath) ? read(reportScriptPath) : '';

  test('PROPOSAL.md.template must declare a tags field so proposal-create can write it', () => {
    // missing → brainstorm origin can never be preserved in proposal frontmatter
    expect(proposalTemplate).toContain('tags:');
  });

  test('PROPOSAL.md.template must carry a Verification section', () => {
    // missing → proposals ship with no defined success check
    expect(proposalTemplate).toContain('## Verification');
  });

  test('PROPOSAL.md.template must carry a References section', () => {
    // missing → proposal-create has no header to fill backward-looking sources into
    expect(proposalTemplate).toContain('## References');
  });

  test('proposal-create triage-verdict event must include evidence_source', () => {
    // missing → triage-survival rate cannot be segmented by brainstorm origin.
    // record-gate.ts (tests/scripts.test.ts describe('record-gate')) guards that the
    // flag actually lands in the appended event; this guards the call site passes it.
    expect(proposalCreate).toContain('--evidence-source "<evidence source>"');
  });

  test('proposal-create triage-verdict event must include tags', () => {
    // Tagged candidate classes that share an evidence_source (e.g. procedure-capture)
    // can only segment their triage-survival rate by the tags field on this event.
    expect(proposalCreate).toContain("--tags '[<caller-supplied tags>]'");
  });

  test('proposal-create created event must include tags', () => {
    // missing → PROP-acceptance rate cannot be segmented by brainstorm origin
    expect(proposalCreate).toContain(
      '"type":"created","proposal_id":"PROP-NNN-slug-HHMMSS","source":"<source>","category":"<category>","tags":[',
    );
  });

  test('capability-brainstorm kill criteria must invoke proposal-metrics-report.ts', () => {
    const parts = capabilityBrainstorm.split('## Kill criteria');
    expect(parts.length).toBeGreaterThan(1); // Kill criteria section missing
    const killSection = parts[1].split('## ')[0];
    expect(killSection).toContain('proposal-metrics-report.ts');
  });

  test('proposal-metrics-report.ts segment registry must discriminate capability-brainstorm', () => {
    // The contract between the emitter (proposal-create) and the consumer
    // (brainstorm kill criteria) holds via evidence_source (triage) and tags (acceptance).
    expect(fs.existsSync(reportScriptPath)).toBe(true);
    expect(reportScript).toContain('evidence_source');
    expect(reportScript).toContain("'capability-brainstorm'");
    expect(reportScript).toContain("'procedure-capture'");
  });
});

// ============================================================
// Procedure capture contract (TestProcedureCaptureContract)
//
// Guards against the silent breakage where reflect declares kill criteria that
// grep for a tag token that proposal-create never actually emits. Both sides of
// the contract (emit side = proposal-create; measure side = reflect) are asserted
// in parallel so they can't silently drift. Does NOT simulate the kill verdict.
// ============================================================

describe('procedure capture contract', () => {
  // The Procedure capture subsection lives in reflect's branches.md (the
  // main-session rare-branch procedures file; SKILL.md keeps only the stub).
  const reflectBranches = read(path.join(SKILLS, 'reflect', 'branches.md'));
  const proposalCreate = read(path.join(SKILLS, 'proposal-create', 'SKILL.md'));

  /** Extract the kill-criteria block from the Procedure capture subsection. */
  function procedureCaptureKillSection(): string {
    const parts = reflectBranches.split('### Procedure capture (new-skill creation)');
    expect(parts.length).toBeGreaterThan(1); // subsection missing
    const subsection = parts[1].split('\n## ')[0];
    const killParts = subsection.split('Kill criteria');
    expect(killParts.length).toBeGreaterThan(1); // Kill criteria block missing
    return killParts[1].split('**Detection')[0];
  }

  test('reflect procedure-capture kill criteria must invoke proposal-metrics-report.ts', () => {
    expect(procedureCaptureKillSection()).toContain('proposal-metrics-report.ts');
  });

  test('reflect kill criteria must document the 25%/30% kill thresholds', () => {
    const killSection = procedureCaptureKillSection();
    expect(killSection).toContain('25%');
    expect(killSection).toContain('30%');
  });

  test('reflect kill criteria must specify counting per candidate surfaced (not per reflect run)', () => {
    expect(procedureCaptureKillSection()).toContain('per candidate surfaced');
  });

  test('proposal-create Skill Draft variant must set the procedure-capture tag', () => {
    const skillDraftParts = proposalCreate.split('## Skill Draft');
    expect(skillDraftParts.length).toBeGreaterThan(1); // ## Skill Draft variant missing
    const skillDraftSection = skillDraftParts[1].split('\n**For ')[0];
    // missing → acceptance-rate grep in reflect kill criteria will find nothing
    expect(skillDraftSection).toContain('procedure-capture');
  });

  test('PROPOSAL.md.template must not have new frontmatter keys (body-section decision locked)', () => {
    const templateText = read(path.join(TEMPLATES, 'PROPOSAL.md.template'));
    const m = templateText.match(/^---\n([\s\S]*?)\n---/m);
    expect(m).not.toBeNull();
    const keys = m![1]
      .split('\n')
      .filter((line) => line.includes(':') && !line.startsWith(' '))
      .map((line) => line.split(':')[0].trim());
    const expected = new Set([
      'id', 'title', 'status', 'source', 'session', 'created',
      'accepted_date', 'resolved_date', 'related_sessions', 'category',
      'tags', 'responded', 'self_eval_key', 'accepted_in_session', 'success_signal',
    ]);
    const extra = keys.filter((k) => !expected.has(k));
    // procedure capture must use a body section (## Skill Draft), not a new field
    expect(extra).toEqual([]);
  });
});

// ============================================================
// Bootstrap skills (TestBootstrapSkills)
//
// Skills reachable from hermit-start's bootstrap `steps` are invoked via the
// Skill tool when 2+ steps produce the prose path. Any
// `disable-model-invocation: true` among them silently breaks first boot
// (issue #229). Keep them model-invocable.
// ============================================================

describe('bootstrap skills', () => {
  test('bootstrap skills are model-invocable', () => {
    const BOOTSTRAP_SKILLS = ['heartbeat', 'hermit-routines', 'session'];
    const offenders: string[] = [];
    for (const skill of BOOTSTRAP_SKILLS) {
      const text = read(path.join(SKILLS, skill, 'SKILL.md'));
      const parts = split3(text, '---\n');
      const fm = parts.length === 3 ? parts[1] : '';
      if (fm.includes('disable-model-invocation: true')) offenders.push(skill);
    }
    expect(offenders).toEqual([]);
  });
});

// ============================================================
// Stop payload snapshot (TestStopPayloadSnapshot)
//
// stop-pipeline.ts writes state/cc-stop-snapshot.json from the Stop payload.
// Guards against: snapshot not written, wrong tri-state, absent fields, or
// missing captured_at. Also exercises checkScheduler() via doctor-check.ts.
// ============================================================

describe('stop payload snapshot', () => {
  const runStopPipeline = (dir: string, payload: any) =>
    runScript('stop-pipeline.ts', {
      stdin: JSON.stringify(payload), cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });

  /** Seed the minimal state/ layout so stop-pipeline doesn't error on missing files. */
  function seedHermitState(dir: string): void {
    fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'sessions'), { recursive: true });
  }

  const snapPath = (dir: string) =>
    path.join(dir, '.claude-code-hermit', 'state', 'cc-stop-snapshot.json');

  const checkById = (report: any, id: string) =>
    Object.fromEntries((report.checks ?? []).map((c: any) => [c.id, c]))[id];

  test('session_crons present → snapshot written with state=populated', withTmpdir(async (dir) => {
    seedHermitState(dir);
    const fixture = readJson(path.join(fixturesDir, 'stop-hook-input-with-scheduler.json'));
    const r = await runStopPipeline(dir, fixture);
    expect(r.exitCode).toBe(0);

    expect(fs.existsSync(snapPath(dir))).toBe(true);
    const snap = readJson(snapPath(dir));
    expect(snap).toContainKey('captured_at');
    expect(typeof snap.captured_at).toBe('string');
    expect(snap.session_crons.state).toBe('populated');
    expect(snap.session_crons.count).toBe(2);
    expect(snap.background_tasks.state).toBe('empty');
    expect(snap.background_tasks.count).toBe(0);
  }), 20000);

  test('no session_crons/background_tasks in payload → unsupported_or_unreachable', withTmpdir(async (dir) => {
    seedHermitState(dir);
    const fixture = readJson(path.join(fixturesDir, 'stop-hook-input.json'));
    const r = await runStopPipeline(dir, fixture);
    expect(r.exitCode).toBe(0);

    expect(fs.existsSync(snapPath(dir))).toBe(true);
    const snap = readJson(snapPath(dir));
    expect(snap.session_crons.state).toBe('unsupported_or_unreachable');
    expect(snap.background_tasks.state).toBe('unsupported_or_unreachable');
  }), 20000);

  test('unsupported_or_unreachable must NEVER appear as count-based "0" in doctor', withTmpdir(async (dir) => {
    seedHermitState(dir);
    const snap = {
      captured_at: '2026-06-10T09:00:00Z',
      cc_version: null,
      session_crons: { state: 'unsupported_or_unreachable', count: 0 },
      background_tasks: { state: 'empty', count: 0 },
    };
    fs.writeFileSync(snapPath(dir), JSON.stringify(snap));
    writeConfig(dir, {});
    const report = await runDoctorCheck(dir);
    const scheduler = checkById(report, 'scheduler');
    expect(scheduler).toBeDefined();
    // Must say "unsupported or unreachable", not "0 crons" or "0 armed"
    expect(scheduler.detail.toLowerCase()).toContain('unsupported');
  }), 20000);

  test("missing snapshot → ok + 'not yet captured'", withTmpdir(async (dir) => {
    seedHermitState(dir);
    writeConfig(dir, {});
    const report = await runDoctorCheck(dir);
    const scheduler = checkById(report, 'scheduler');
    expect(scheduler).toBeDefined();
    expect(scheduler.status).toBe('ok');
    expect(scheduler.detail).toContain('not yet captured');
  }), 20000);

  test('populated snapshot → ok, detail includes count and captured_at', withTmpdir(async (dir) => {
    seedHermitState(dir);
    const snap = {
      captured_at: '2026-06-10T09:51:00Z',
      cc_version: '2.1.145',
      session_crons: { state: 'populated', count: 3 },
      background_tasks: { state: 'empty', count: 0 },
    };
    fs.writeFileSync(snapPath(dir), JSON.stringify(snap));
    writeConfig(dir, {});
    const report = await runDoctorCheck(dir);
    const scheduler = checkById(report, 'scheduler');
    expect(scheduler).toBeDefined();
    expect(scheduler.status).toBe('ok');
    expect(scheduler.detail).toContain('3');
    expect(scheduler.detail).toContain('2026-06-10');
  }), 20000);
});

// ============================================================
// hermit-routines plugin-root resolution contract (TestHermitRoutinesPluginRootContract)
//
// Guards against the `echo $CLAUDE_PLUGIN_ROOT` pattern being reintroduced.
// That bare env-var form always returns empty at Bash runtime (in all modes),
// causing load to abort and leaving all CronCreates unregistered. The
// mode-independent fix derives pluginRoot from the skill's Base directory.
// ============================================================

describe('hermit-routines plugin-root resolution contract', () => {
  const skillContent = read(path.join(SKILLS, 'hermit-routines', 'SKILL.md'));

  test('SKILL.md derives pluginRoot from Base directory, not echo $CLAUDE_PLUGIN_ROOT', () => {
    expect(skillContent).toContain('Base directory');
    expect(skillContent).not.toContain('echo $CLAUDE_PLUGIN_ROOT');
  });

  test('SKILL.md documents that $CLAUDE_PLUGIN_ROOT is not a Bash env var at runtime', () => {
    expect(skillContent).toContain('NOT a Bash env var at runtime');
  });
});

// ============================================================
// hermit-routines model contract (TestHermitRoutinesModelContract)
//
// Guards against the template change being reverted while the validator keeps
// accepting the model field (accepted-but-inert), and against the
// heartbeat-restart short-circuit guard being silently dropped.
// ============================================================

describe('hermit-routines model contract', () => {
  const skillContent = read(path.join(SKILLS, 'hermit-routines', 'SKILL.md'));

  test('SKILL.md must document the model-override substitution rule', () => {
    expect(skillContent).toContain('Model-override substitution');
  });

  test('SKILL.md must reference Agent tool dispatch for model overrides', () => {
    expect(skillContent).toContain('via the Agent tool');
  });

  test('SKILL.md must document the heartbeat-restart short-circuit in the substitution rule', () => {
    expect(skillContent).toContain('heartbeat-restart');
    expect(skillContent).toContain('treat `model` as absent');
  });
});

// ============================================================
// hermit-routines diff-registration contract (TestHermitRoutinesCronRegistryContract)
//
// Guards the `load` success path against regressing back to an unconditional
// CronList/CronDelete-all/CronCreate-all sweep on every call. That sweep was
// replaced by cron-registry.ts's plan/commit diff (see scripts/cron-registry.ts
// and its own test file, tests/cron-registry.test.ts, for the planner's pure
// logic); `load --reset` keeps the old unconditional sweep as an explicit,
// operator-invoked escape hatch — only the *default* path must not silently
// regress to it.
// ============================================================

describe('hermit-routines diff-registration contract', () => {
  const skillContent = read(path.join(SKILLS, 'hermit-routines', 'SKILL.md'));

  test('SKILL.md wires the diff planner into load\'s success path', () => {
    expect(skillContent).toContain('cron-registry.ts plan');
    expect(skillContent).toContain('cron-registry.ts commit');
  });

  test('load\'s default success path is no longer an unconditional CronList sweep', () => {
    expect(skillContent).not.toContain('Unconditional reset — ensures stale entries');
  });

  test('SKILL.md documents the KEEP-only fast path (no CronList/CronCreate/CronDelete)', () => {
    expect(skillContent).toContain('KEEP:<n>');
    expect(skillContent).toContain('No `CronList`, no `CronCreate`, no `CronDelete` this run.');
  });

  test('SKILL.md documents load --reset as the unconditional escape hatch', () => {
    expect(skillContent).toContain('load --reset');
    expect(skillContent).toContain('--force');
  });

  test('SKILL.md documents the boot-id mirror-invalidation mechanism', () => {
    expect(skillContent).toContain('.boot-id');
  });
});

// ============================================================
// Gate-agent memory contract (TestGateAgentMemoryContract)
//
// Gate agents (proposal-triage, reflection-judge) must declare memory: project.
// Guards against the frontmatter key being accidentally dropped, since it enables
// persistent heuristic accumulation across invocations (17.3 gate-agent memory).
// ============================================================

describe('gate-agent memory contract', () => {
  const GATE_AGENTS = ['proposal-triage', 'reflection-judge'];

  test('gate agents declare memory: project', () => {
    for (const name of GATE_AGENTS) {
      expect(agentFrontmatter(name)).toContain('memory: project');
    }
  });

  test('memory curation needs Write/Edit granted and out of disallowedTools', () => {
    // A silent revert of the tool grant breaks curation just as badly as
    // dropping the memory key, so guard it explicitly.
    for (const name of GATE_AGENTS) {
      const head = agentFrontmatter(name);
      expect(head).toContain('disallowedTools:');
      const idx = head.indexOf('disallowedTools:');
      const tools = head.slice(0, idx);
      const disallowed = head.slice(idx + 'disallowedTools:'.length);
      for (const tool of ['Write', 'Edit']) {
        expect(tools).toContain(`- ${tool}\n`);
        expect(disallowed).not.toContain(`- ${tool}\n`);
      }
    }
  });
});

// ============================================================
// hermit-evolve delegation contract (TestEvolveRunnerRoutingContract)
//
// hermit-evolve delegates steps 0–9 to the evolve-runner subagent. Guards
// against: the agent reference losing its namespace (bare names fail with
// "Agent type not found"), the recursion guard being dropped (subagent would
// re-dispatch), and evolve-runner gaining tools it must not have (Agent →
// recursion; web/channel → the subagent must not notify, step 10 owns that).
// ============================================================

describe('hermit-evolve delegation contract', () => {
  const skill = read(path.join(SKILLS, 'hermit-evolve', 'SKILL.md'));

  test('SKILL.md dispatches evolve-runner fully-qualified', () => {
    expect(skill).toContain('claude-code-hermit:evolve-runner');
  });

  test('SKILL.md keeps the recursion guard', () => {
    // The subagent reads this same SKILL.md; without this line it would
    // re-enter the routing branch and dispatch another evolve-runner.
    expect(skill).toContain('running AS the `evolve-runner` subagent');
    expect(skill).toContain('execute steps 0–9 directly');
  });

  test('evolve-runner omits Agent, web, and channel/MCP tools', () => {
    const head = agentFrontmatter('evolve-runner');
    expect(head).toContain('disallowedTools:');
    const idx = head.indexOf('disallowedTools:');
    const granted = head.slice(0, idx);
    // Agent must not be granted (recursion); web tools must not be granted.
    for (const tool of ['Agent', 'WebSearch', 'WebFetch']) {
      expect(granted).not.toContain(`- ${tool}\n`);
    }
    // No channel/MCP tools — the subagent must not notify.
    expect(granted).not.toContain('mcp__');
  });

  test('evolve-runner declares no memory (non-gate agent)', () => {
    expect(agentFrontmatter('evolve-runner')).not.toContain('memory:');
  });

  test('report contract is identical in evolve-runner.md and SKILL.md', () => {
    // The report format is duplicated: the agent emits it, step 10 parses it.
    // Drift between the two copies would desync producer and consumer.
    const block = (text: string) => extractBlock(text, 'Upgrade: vOLD -> vNEW', '--- end ---');
    const agent = read(path.join(AGENTS, 'evolve-runner.md'));
    expect(block(agent)).toBe(block(skill));
  });

  test('evolve-runner reads reference.md, not SKILL.md, for steps 0-9', () => {
    // Unlike the generic skill-eval-runner dispatchers (reflect/brief/weekly-review),
    // evolve-runner is a dedicated agent that hard-codes the file it reads — so this
    // guards the one place a stale "Read .../SKILL.md" instruction would silently
    // leave the runner executing pre-split steps that no longer live there.
    const agent = read(path.join(AGENTS, 'evolve-runner.md'));
    expect(agent).toContain('hermit-evolve/reference.md');
  });

  test('hermit-evolve/reference.md exists', () => {
    expect(fs.existsSync(path.join(SKILLS, 'hermit-evolve', 'reference.md'))).toBe(true);
  });

  test('SKILL.md guards both SKILL.md and reference.md before dispatch', () => {
    // reference.md is load-bearing for evolve-runner post-split; a guard that only
    // checks SKILL.md would dispatch into a broken read if reference.md were missing.
    expect(skill).toContain('skills/hermit-evolve/SKILL.md');
    expect(skill).toContain('skills/hermit-evolve/reference.md');
  });
});

// ============================================================
// reflect delegation contract (TestReflectDelegationContract)
//
// reflect dispatches the cross-session file analysis (Resolution Check, routine
// check, procedure detection) to skill-eval-runner, a shared read-only runner.
// Guards against: losing the fully-qualified agent reference, skill-eval-runner
// re-coupling to a single skill or hardcoding a hermit state path, the
// no-memory and no-model-override invariants being dropped (non-gate agent), and
// producer/consumer schema drift between reference.md and SKILL.md.
// ============================================================

describe('reflect delegation contract', () => {
  const skill = read(path.join(SKILLS, 'reflect', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'reflect', 'reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with reference.md', () => {
    expect(skill).toContain('claude-code-hermit:skill-eval-runner');
    expect(skill).toContain('skills/reflect/reference.md');
  });

  test('SKILL.md points at branches.md for rare-branch procedures', () => {
    // branches.md is load-bearing post-split: candidate processing, scheduled
    // checks, and procedure capture live there. A stub that loses the pointer
    // would strand those flows.
    expect(skill).toContain('skills/reflect/branches.md');
  });

  test('skill-eval-runner stays generic and reference-driven', () => {
    // Shared runner: a downstream operator can't edit plugin source, so behavior
    // must come from the dispatched reference.md, not from rules baked into the agent.
    // Guard against re-coupling it to a single skill or hardcoding a state path.
    const agent = read(path.join(AGENTS, 'skill-eval-runner.md'));
    expect(agent).not.toContain('.claude-code-hermit/');
    expect(agent.toLowerCase()).not.toContain('reflect');
  });

  test('skill-eval-runner declares no memory and no model override', () => {
    // Non-gate agent; inherits the session model rather than pinning one.
    const head = agentFrontmatter('skill-eval-runner');
    expect(head).not.toContain('memory:');
    expect(head).not.toContain('model:');
  });

  test('schema block is byte-identical in reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- reflect-eval-schema:start -->', '<!-- reflect-eval-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });

  test('nudge write-back uses top-level last_sparse_nudge, not a per-entry field', () => {
    // Producer and consumer must agree on the nudge-debounce write-back field.
    // The runner returns nudge timestamps in the top-level `last_sparse_nudge` map;
    // a stray per-entry `last_sparse_nudge_update` would never reach reflection-state.json.
    expect(refFile).not.toContain('last_sparse_nudge_update');
    expect(refFile).toContain('last_sparse_nudge');
    expect(skill).toContain('last_sparse_nudge');
  });
});

// ============================================================
// weekly-review delegation contract (TestWeeklyReviewDelegationContract)
//
// weekly-review dispatches the topic-page semantic check (Step 3) to
// skill-eval-runner to keep full topic-page bodies off the main session.
// Guards against: losing the fully-qualified agent reference, and
// producer/consumer schema drift between reference.md and SKILL.md.
// Generic skill-eval-runner invariants (stays generic, no memory/model override)
// are already covered by the reflect delegation contract above.
// ============================================================

describe('weekly-review delegation contract', () => {
  const skill = read(path.join(SKILLS, 'weekly-review', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'weekly-review', 'reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with reference.md', () => {
    expect(skill).toContain('claude-code-hermit:skill-eval-runner');
    expect(skill).toContain('skills/weekly-review/reference.md');
  });

  test('schema block is byte-identical in reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- weekly-review-eval-schema:start -->', '<!-- weekly-review-eval-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });
});

// ============================================================
// weekly-review consolidation delegation contract (PROP-010)
//
// weekly-review dispatches the channel-log consolidation step (Step 4) to
// skill-eval-runner, read-only — it must never write memory/compiled/the log
// itself (agents/skill-eval-runner.md contract). Guards against: losing the
// fully-qualified agent reference, and producer/consumer schema drift between
// consolidation-reference.md and SKILL.md.
// ============================================================

describe('weekly-review consolidation delegation contract', () => {
  const skill = read(path.join(SKILLS, 'weekly-review', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'weekly-review', 'consolidation-reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with consolidation-reference.md', () => {
    expect(skill).toContain('claude-code-hermit:skill-eval-runner');
    expect(skill).toContain('skills/weekly-review/consolidation-reference.md');
  });

  test('schema block is byte-identical in consolidation-reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- weekly-review-consolidation-schema:start -->', '<!-- weekly-review-consolidation-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });

  test('consolidation-reference.md states the runner never writes (defers to caller)', () => {
    expect(refFile).toContain('read-only');
    expect(refFile.toLowerCase()).toContain('never write');
  });
});

// ============================================================
// External-origin quarantine contract (TestExternalOriginQuarantineContract)
//
// Guards against the ROP-001 class of drift where a security rule is added to
// one file but not the others — e.g. reflect sets Evidence Origin but judge
// never reads it.
// ============================================================

describe('external-origin quarantine contract', () => {
  const reflect = read(path.join(SKILLS, 'reflect', 'SKILL.md'));
  const judge = read(path.join(AGENTS, 'reflection-judge.md'));
  const triage = read(path.join(AGENTS, 'proposal-triage.md'));
  const proposalCreate = read(path.join(SKILLS, 'proposal-create', 'SKILL.md'));

  test('reflect SKILL.md must document that external-content candidates are Tier 3', () => {
    expect(reflect).toContain('external-content');
    expect(reflect).toContain('Tier 3');
  });

  test('reflection-judge must document the quarantine escalation and reason phrase', () => {
    expect(judge).toContain('external-content');
    expect(judge).toContain('quarantine');
    expect(judge).toContain('Evidence Origin');
  });

  test('proposal-triage must document the Evidence Origin field', () => {
    expect(triage).toContain('external-content');
    expect(triage).toContain('Evidence Origin');
  });

  test('proposal-create must thread Evidence Origin through its Pre-Creation Gate', () => {
    expect(proposalCreate).toContain('external-content');
    expect(proposalCreate).toContain('Evidence Origin');
  });

  test('proposal-create must write operator-visible provenance for external-content proposals', () => {
    expect(proposalCreate).toContain('review for injection');
  });
});

// ============================================================
// template-manifest.json shape contract (TestTemplateManifestContract)
//
// doctor-check.ts must detect missing, malformed, and invalid manifests without
// crashing. Guards against silent regressions in the shape-check added for
// PROP-001 (customization-aware template/bin updates).
// ============================================================

describe('template-manifest doctor contract', () => {
  const EXPECTED_STUB_FILES = [
    'alert-state.json', 'reflection-state.json', 'runtime.json', 'monitors.runtime.json',
  ];

  /** Seed a minimal .claude-code-hermit/state/ with all expected files. */
  function seedState(dir: string, manifestContent?: string | null): void {
    const stateDir = path.join(dir, '.claude-code-hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    for (const f of EXPECTED_STUB_FILES) {
      fs.writeFileSync(path.join(stateDir, f), '{}');
    }
    if (manifestContent !== null) {
      const content = manifestContent !== undefined
        ? manifestContent
        : JSON.stringify({ version: 1, files: {
            'templates/SHELL.md.template': { sha256: 'a'.repeat(64), plugin_version: '1.2.0' },
          }});
      fs.writeFileSync(path.join(stateDir, 'template-manifest.json'), content);
    }
  }

  const stateCheck = (report: any) =>
    (report.checks ?? []).find((c: any) => c.id === 'state');

  test('valid manifest → state check ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir);
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('ok');
  }), 20000);

  test('manifest absent → state check warns, names template-manifest.json', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir, null); // do not write manifest
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('warn');
    expect(s.detail).toContain('template-manifest.json');
  }), 20000);

  test('manifest without files object → state check fails', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir, JSON.stringify({ version: 1 })); // files key absent
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('fail');
    expect(s.detail).toContain('template-manifest.json');
  }), 20000);

  test('manifest entry with invalid sha256 → state check fails with key name', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir, JSON.stringify({ version: 1, files: {
      'templates/SHELL.md.template': { sha256: 'not-a-hash', plugin_version: '1.2.0' },
    }}));
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('fail');
    expect(s.detail).toContain('templates/SHELL.md.template');
  }), 20000);

  test('docker deployed but no template baselines → state warns', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir); // default manifest: templates key only, no docker/
    fs.writeFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'services: {}\n');
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('warn');
    expect(s.detail).toContain('docker');
  }), 20000);

  test('docker deployed + ONLY entrypoint baseline (evolve wrote it, docker-setup did not) → still warns', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    // Step 5c writes the entrypoint key independently of docker-setup; that alone must
    // NOT suppress the warn — the F2 compose/Dockerfile baselines are still missing.
    seedState(dir, JSON.stringify({ version: 1, files: {
      'templates/SHELL.md.template': { sha256: 'a'.repeat(64), plugin_version: '1.2.0' },
      'docker/docker-entrypoint.hermit.sh': { sha256: 'b'.repeat(64), plugin_version: '1.2.0' },
    }}));
    fs.writeFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'services: {}\n');
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('warn');
  }), 20000);

  test('docker deployed WITH compose/Dockerfile template baselines → state ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir, JSON.stringify({ version: 1, files: {
      'templates/SHELL.md.template': { sha256: 'a'.repeat(64), plugin_version: '1.2.0' },
      'docker/docker-compose.hermit.yml.template': { sha256: 'b'.repeat(64), plugin_version: '1.2.0' },
      'docker/Dockerfile.hermit.template': { sha256: 'c'.repeat(64), plugin_version: '1.2.0' },
    }}));
    fs.writeFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'services: {}\n');
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('ok');
  }), 20000);
});

// ============================================================
// brief delegation contract (TestBriefDelegationContract)
//
// brief dispatches archived-report/cost/proposal reads to the shared
// skill-eval-runner. Guards against: losing the fully-qualified agent reference
// and producer/consumer schema drift between reference.md and SKILL.md.
// ============================================================

describe('brief delegation contract', () => {
  const skill = read(path.join(SKILLS, 'brief', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'brief', 'reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with reference.md', () => {
    expect(skill).toContain('claude-code-hermit:skill-eval-runner');
    expect(skill).toContain('skills/brief/reference.md');
  });

  test('schema block is byte-identical in reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- brief-eval-schema:start -->', '<!-- brief-eval-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });
});

// ============================================================
// hermit-evolution delegation contract (TestHermitEvolutionDelegationContract)
//
// hermit-evolution dispatches the weekly-review / session-report / proposal-metrics
// reads (and bun script runs) to skill-eval-runner to keep that heavy context
// off the main session.
// Guards against: losing the fully-qualified agent reference and
// producer/consumer schema drift between reference.md and SKILL.md.
// ============================================================

describe('hermit-evolution delegation contract', () => {
  const skill = read(path.join(SKILLS, 'hermit-evolution', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'hermit-evolution', 'reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with reference.md', () => {
    expect(skill).toContain('claude-code-hermit:skill-eval-runner');
    expect(skill).toContain('skills/hermit-evolution/reference.md');
  });

  test('schema block is byte-identical in reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- hermit-evolution-eval-schema:start -->', '<!-- hermit-evolution-eval-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });
});

// ============================================================
// capability-brainstorm delegation contract (TestCapabilityBrainstormDelegationContract)
//
// capability-brainstorm dispatches the memory / compiled-artifact / codebase reads
// (and idea generation) to skill-eval-runner. Harness-context signals (skills list,
// MCPs, channels) are gathered in main and passed via the dispatch prompt.
// Guards against: losing the fully-qualified agent reference and
// producer/consumer schema drift between reference.md and SKILL.md.
// ============================================================

describe('capability-brainstorm delegation contract', () => {
  const skill = read(path.join(SKILLS, 'capability-brainstorm', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'capability-brainstorm', 'reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with reference.md', () => {
    expect(skill).toContain('claude-code-hermit:skill-eval-runner');
    expect(skill).toContain('skills/capability-brainstorm/reference.md');
  });

  test('schema block is byte-identical in reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- brainstorm-eval-schema:start -->', '<!-- brainstorm-eval-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });
});

// ============================================================
// reference.md plugin-root contract (TestReferencePluginRootContract)
//
// The skill-eval-runner reads each reference.md via the Read tool, where the
// `${CLAUDE_PLUGIN_ROOT}` token is NOT substituted (it is only text-substituted
// in skill markdown loaded by the harness in installed mode, and is empty as a
// Bash variable). Any executable path in a reference.md must therefore use the
// `<plugin_root>` value passed in the dispatch prompt, never `${CLAUDE_PLUGIN_ROOT}/`.
// Mirrors the #395 regression guard for hermit-routines. A plain `${CLAUDE_PLUGIN_ROOT}`
// mention (the warning telling the runner not to use it) is allowed; only the
// path form `${CLAUDE_PLUGIN_ROOT}/` is forbidden.
// ============================================================

describe('reference.md plugin-root contract', () => {
  const refFiles = fs.readdirSync(SKILLS)
    .map((d) => path.join(SKILLS, d, 'reference.md'))
    .filter((p) => fs.existsSync(p));

  test('at least one reference.md exists', () => {
    expect(refFiles.length).toBeGreaterThan(0);
  });

  for (const refPath of refFiles) {
    const rel = path.relative(SKILLS, refPath);
    test(`${rel} uses no \${CLAUDE_PLUGIN_ROOT}/ path (must use <plugin_root>)`, () => {
      expect(read(refPath)).not.toContain('${CLAUDE_PLUGIN_ROOT}/');
    });
  }
});

// ============================================================
// proposal-act dispatch contract (TestProposalActDispatchContract)
//
// Step (e) dispatches the WHOLE implementation tail (implement → quality gate →
// verification) to general-purpose when the falsification gate returned PROCEED and
// there is no in-main skill handler. Main only resolves + notifies on a verified
// return. The dispatch prompt is the contract — guard its key invariants so they
// can't silently drift.
// ============================================================

describe('proposal-act dispatch contract', () => {
  const skill = read(path.join(SKILLS, 'proposal-act', 'SKILL.md'));

  test('falsification gate runs for every code-edit implementation', () => {
    // missing → skill-improvement-without-skill-creator dispatches with no PROCEED file list
    expect(skill).toContain('Skip only when the body contains `## Skill Improvement` **and** `/skill-creator:skill-creator` is in the available-skills list');
    expect(skill).toContain('the gate runs to produce a `PROCEED` file list for the dispatch');
    // dispatch block is labelled by what gates it, not the stale "no skill marker"
    expect(skill).toContain('Dispatch (falsification gate returned PROCEED, no in-main skill handler)');
  });

  test('dispatch prompt instructs escalate-don\'t-guess (cannot prompt the operator)', () => {
    // missing → subagent guesses on ambiguous/destructive choices instead of escalating
    expect(skill).toContain('You cannot prompt the operator');
    expect(skill).toContain('stop and return an escalation block');
  });

  test('dispatch prompt defines the six-field structured return shape', () => {
    // missing → resolve/notify branch and escalation relay have no defined source fields
    expect(skill).toContain('Status: implemented | escalated | blocked:');
    expect(skill).toContain('Touched files:');
    expect(skill).toContain('Tests run:');
    expect(skill).toContain('Quality gate:');
    expect(skill).toContain('Verification: passed | failed:');
    expect(skill).toContain('Deferred for operator:');
  });

  test('subagent owns the quality gate and verification (design b)', () => {
    // missing → e.5/e.6 bounce back to main, splitting execution across two contexts
    expect(skill).toContain('then run its quality gate and verification');
    expect(skill).toContain('quality_gate.tier');
    expect(skill).toContain('/claude-code-hermit:simplify');
    // balanced tier is decided inline (no quality-gate-judge subagent)
    expect(skill).toContain('decide RUN vs SKIP yourself');
  });

  test('verification failure is handled inside the subagent with a bounded retry', () => {
    // missing → a verification failure after dispatch has no defined recovery path
    expect(skill).toContain('attempt **one** fix and re-verify');
    expect(skill).toContain('it still fails, set `Verification: failed`');
  });

  test('main resolves only on a verified return; escalation branches interactive vs autonomous', () => {
    // missing → main resolves on failed/escalated, or silently discards escalations
    expect(skill).toContain('`Status: implemented` **and** `Verification:` is `passed` or `none defined`');
    expect(skill).toContain('do **not** resolve');
    expect(skill).toContain('(interactive)');
    expect(skill).toContain('(autonomous)');
  });
});

describe('reflect routine gating contract (token efficiency)', () => {
  // The reflect routine's CronCreate prompt must run the precheck in bash and
  // hand the verdict to reflect via --precheck-verdict, so EMPTY days never load
  // reflect's body. Both sides of that handoff must stay wired.
  test('hermit-routines documents the reflect precheck-gated prompt', () => {
    const routines = read(path.join(SKILLS, 'hermit-routines', 'SKILL.md'));
    expect(routines).toContain('reflect-precheck.ts');
    expect(routines).toContain('--precheck-verdict');
  });

  test('reflect accepts the --precheck-verdict handoff', () => {
    const reflect = read(path.join(SKILLS, 'reflect', 'SKILL.md'));
    expect(reflect).toContain('--precheck-verdict');
  });
});

// ============================================================
// PROP-018: proactive doctor — report shape, doc-count sync, new checks
// ============================================================

const DOCTOR_CHECK_IDS = [
  'runtime', 'config', 'hooks', 'state', 'cost', 'proposals', 'dependencies', 'version-currency',
  'permissions', 'docker-security', 'archive', 'reflect', 'scheduler', 'watchdog', 'context-age',
  'opus-wake', 'routine-cost', 'heartbeat', 'raw-size', 'credential-expiry', 'model-pricing-known',
  'channel-liveness',
];

describe('doctor report contract (PROP-018 count pin)', () => {
  test('report emits exactly the 22 pinned check ids, in order', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const report = await runDoctorCheck(dir);
    expect((report.checks ?? []).map((c: any) => c.id)).toEqual(DOCTOR_CHECK_IDS);
  }), 20000);
});

describe('hermit-doctor SKILL.md doc-sync (no drift between JSON checks and docs)', () => {
  const skill = read(path.join(SKILLS, 'hermit-doctor', 'SKILL.md'));

  test('every JSON check id (plus sandbox) appears as a table row', () => {
    const missing = [...DOCTOR_CHECK_IDS, 'sandbox'].filter(id => !skill.includes(`| \`${id}\` |`));
    expect(missing).toEqual([]);
  });

  test('step 2 enumerates every JSON check id', () => {
    const missing = DOCTOR_CHECK_IDS.filter(id => !skill.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  test('counts read twenty-three, not fifteen', () => {
    expect(skill).not.toContain('fifteen');
    expect(skill.toLowerCase()).toContain('twenty-three');
  });
});

describe('doctor version-currency check', () => {
  const vcCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'version-currency');
  const coreManifest = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  const installedVersion: string = coreManifest.version;
  const coreName: string = coreManifest.name;

  test('no marketplace cache configured → ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const report = await runDoctorCheck(dir);
    const c = vcCheck(report);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('no marketplace cache');
  }), 20000);

  test('marketplace cache lists no matching plugin entry → ok, no comparable entry', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const mpFile = path.join(dir, 'marketplace.json');
    fs.writeFileSync(mpFile, JSON.stringify({ plugins: [] }));
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_DOCTOR_MARKETPLACE_FILE: mpFile },
    });
    const c = vcCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('no comparable version entry');
  }), 20000);

  test('marketplace cache lists the same version → ok, no newer version', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const mpFile = path.join(dir, 'marketplace.json');
    fs.writeFileSync(mpFile, JSON.stringify({ plugins: [{ name: coreName, version: installedVersion }] }));
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_DOCTOR_MARKETPLACE_FILE: mpFile },
    });
    const c = vcCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('no newer version');
  }), 20000);

  test('marketplace cache lists a newer version, no Fixed entries in range → warn, not escalated', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const mpFile = path.join(dir, 'marketplace.json');
    fs.writeFileSync(mpFile, JSON.stringify({ plugins: [{ name: coreName, version: '99.0.0' }] }));
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_DOCTOR_MARKETPLACE_FILE: mpFile },
    });
    const c = vcCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('99.0.0');
    expect(c.detail).not.toContain('Fixed entries');
  }), 20000);

  test('marketplace cache lists a newer version with a Fixed entry in range → warn, escalated', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const mpFile = path.join(dir, 'marketplace.json');
    fs.writeFileSync(mpFile, JSON.stringify({ plugins: [{ name: coreName, version: '99.0.0' }] }));
    const changelog = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(changelog, '## [99.0.0] - 2099-01-01\n\n### Fixed\n- something\n');
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: {
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        HERMIT_DOCTOR_MARKETPLACE_FILE: mpFile,
        HERMIT_DOCTOR_CHANGELOG_PATH: changelog,
      },
    });
    const c = vcCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('Fixed entries');
  }), 20000);

  // The escalation must read the newer version's CHANGELOG from the marketplace-cache clone
  // (marketplace.json's dir + the plugin's `source`), which is refreshed with marketplace.json
  // — NOT the installed snapshot, which structurally can't carry the newer version's sections.
  // No HERMIT_DOCTOR_CHANGELOG_PATH override here: resolution must come from `source`.
  test('newer version Fixed entry resolved via marketplace-cache clone `source` → warn, escalated', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const mpRoot = path.join(dir, 'mp');
    const mpFile = path.join(mpRoot, '.claude-plugin', 'marketplace.json');
    fs.mkdirSync(path.dirname(mpFile), { recursive: true });
    fs.writeFileSync(mpFile, JSON.stringify({ plugins: [{ name: coreName, version: '99.0.0', source: './core' }] }));
    fs.mkdirSync(path.join(mpRoot, 'core'), { recursive: true });
    fs.writeFileSync(path.join(mpRoot, 'core', 'CHANGELOG.md'), '## [99.0.0] - 2099-01-01\n\n### Fixed\n- something\n');
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_DOCTOR_MARKETPLACE_FILE: mpFile },
    });
    const c = vcCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('Fixed entries');
  }), 20000);
});

describe('doctor context-age check', () => {
  const caCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'context-age');
  const HYGIENE_CONFIG = { context_hygiene: { compact: { enabled: true, min_context_tokens: 1000 } } };

  function writeCostLogEntry(dir: string, sessionId: string, maxPromptTokens: number) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(), session_id: sessionId, source: 'interactive', model: 'sonnet',
      input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
      total_tokens: maxPromptTokens, api_calls: 1, max_prompt_tokens: maxPromptTokens,
      estimated_cost_usd: 0,
    };
    fs.writeFileSync(path.join(dir, '.claude', 'cost-log.jsonl'), JSON.stringify(entry) + '\n');
  }

  function writeRuntime(dir: string, sessionState: string, sessionId: string) {
    fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'state', 'runtime.json'), JSON.stringify({
      session_state: sessionState, session_id: sessionId, updated_at: new Date().toISOString(),
    }));
  }

  function writeHygieneEvent(dir: string, action: string, ageHours: number) {
    const ts = new Date(Date.now() - ageHours * 3600000).toISOString();
    fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'state', 'watchdog-events.jsonl'),
      JSON.stringify({ ts, action, reason: 'test' }) + '\n');
  }

  test('compact tier not enabled → ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('not enabled');
  }), 20000);

  test('no active session → ok', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('no active session');
  }), 20000);

  test('active session, context under threshold → ok', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    writeRuntime(dir, 'in_progress', 'sess-1');
    writeCostLogEntry(dir, 'sess-1', 500);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('under');
  }), 20000);

  test('active session, context over threshold, recent hygiene event → ok', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    writeRuntime(dir, 'in_progress', 'sess-1');
    writeCostLogEntry(dir, 'sess-1', 2000);
    writeHygieneEvent(dir, 'context-compact', 1);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('hygiene fired');
  }), 20000);

  test('active session, context over threshold, no recent hygiene event → warn', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    writeRuntime(dir, 'in_progress', 'sess-1');
    writeCostLogEntry(dir, 'sess-1', 2000);
    writeHygieneEvent(dir, 'context-compact', 48);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('context hygiene may be disabled or stuck');
  }), 20000);

  // Estimate-only entry (multi-call, no max_prompt_tokens): the compact tier this check
  // mirrors averages the summed total rather than skipping, so an over-threshold average
  // must still warn — regression guard for the clear-tier skip that used to short-circuit here.
  test('active session, estimate-only entry over threshold → warn (compact-tier parity)', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    writeRuntime(dir, 'in_progress', 'sess-1');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(), session_id: 'sess-1', source: 'interactive', model: 'sonnet',
      input_tokens: 6000, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
      total_tokens: 6000, api_calls: 3, // no max_prompt_tokens → avg 2000 > 1000 threshold
      estimated_cost_usd: 0,
    };
    fs.writeFileSync(path.join(dir, '.claude', 'cost-log.jsonl'), JSON.stringify(entry) + '\n');
    writeHygieneEvent(dir, 'context-compact', 48);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('context hygiene may be disabled or stuck');
  }), 20000);
});

describe('doctor credential-expiry check', () => {
  const credCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'credential-expiry');

  test('no credentials file, no API key → ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const credDir = path.join(dir, 'no-such-cred-dir');
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    const report = JSON.parse(r.stdout);
    expect(credCheck(report).status).toBe('ok');
  }), 20000);

  test('no credentials file, API key set → ok, API-key mode', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const credDir = path.join(dir, 'no-such-cred-dir');
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: 'sk-test' },
    });
    const report = JSON.parse(r.stdout);
    const c = credCheck(report);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('API-key mode');
  }), 20000);

  test('malformed credentials JSON → warn', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const credDir = path.join(dir, 'creds');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, '.credentials.json'), '{not json');
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    const report = JSON.parse(r.stdout);
    expect(credCheck(report).status).toBe('warn');
  }), 20000);

  test('fresh token (+24h) → ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const credDir = path.join(dir, 'creds');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { expiresAt: Date.now() + 24 * 3600000 },
    }));
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    const report = JSON.parse(r.stdout);
    expect(credCheck(report).status).toBe('ok');
  }), 20000);

  test('near-expiry token (+30m) → warn', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const credDir = path.join(dir, 'creds');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { expiresAt: Date.now() + 30 * 60000 },
    }));
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    const report = JSON.parse(r.stdout);
    expect(credCheck(report).status).toBe('warn');
  }), 20000);

  test('expired token (-1h) → warn, detail mentions login', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const credDir = path.join(dir, 'creds');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { expiresAt: Date.now() - 3600000 },
    }));
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    const report = JSON.parse(r.stdout);
    const c = credCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('/login');
  }), 20000);
});

describe('doctor model-pricing-known check', () => {
  const priceCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'model-pricing-known');

  test('default template models → ok', withTmpdir(async (dir) => {
    const template = readJson(path.join(TEMPLATES, 'config.json.template'));
    writeConfig(dir, template);
    const report = await runDoctorCheck(dir);
    expect(priceCheck(report).status).toBe('ok');
  }), 20000);

  test('unknown config.model → warn naming config.model', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, model: 'gpt-mini' });
    const report = await runDoctorCheck(dir);
    const c = priceCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('config.model');
  }), 20000);

  test('full Claude model id (detectModel-priced) → ok, not a false warn', withTmpdir(async (dir) => {
    // "claude-opus-4-8" is priced correctly (detectModel substring-maps it to
    // opus), so it must not be flagged as unpriced. Guards the fix for the
    // alias-only false positive.
    writeConfig(dir, { ...BASE_CONFIG, model: 'claude-opus-4-8' });
    const report = await runDoctorCheck(dir);
    expect(priceCheck(report).status).toBe('ok');
  }), 20000);

  test('unknown routine model → warn naming the routine', withTmpdir(async (dir) => {
    writeConfig(dir, {
      ...BASE_CONFIG,
      routines: [{ id: 'my-routine', schedule: '0 9 * * *', skill: 'x:y', model: 'gpt-mini', enabled: true }],
    });
    const report = await runDoctorCheck(dir);
    const c = priceCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('routines[my-routine].model');
  }), 20000);

  test('unknown heartbeat.model → warn naming heartbeat.model', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, heartbeat: { ...BASE_CONFIG.heartbeat, model: 'gpt-mini' } });
    const report = await runDoctorCheck(dir);
    const c = priceCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('heartbeat.model');
  }), 20000);

  test('unknown model in cost-log within last 7d → warn naming cost-log', withTmpdir(async (dir) => {
    writeConfig(dir, BASE_CONFIG);
    const costLog = path.join(dir, '.claude', 'cost-log.jsonl');
    fs.writeFileSync(costLog, JSON.stringify({
      timestamp: new Date().toISOString(), model: 'mystery-model', estimated_cost_usd: 0.01, total_tokens: 100,
    }) + '\n');
    const report = await runDoctorCheck(dir);
    const c = priceCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('cost-log');
  }), 20000);
});

describe('doctor routine-cost check', () => {
  const routineCostCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'routine-cost');
  const routine = (id: string) => ({ id, schedule: '0 9 * * *', skill: 'x:y', enabled: true });
  // A fire-turn stamps exactly one of started|skipped-* via routine-precheck.ts; both accrue
  // cost to the routine bucket, so both count toward the run denominator. `fired` is a later
  // duplicate of `started` and is deliberately NOT counted.
  const runs = (id: string, n: number, event = 'started') => Array.from({ length: n }, () => ({ routine_id: id, event }));

  function writeCostIndex(dir: string, bySource: Record<string, { cost: number; tokens: number }>) {
    fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'state', 'cost-index.json'), JSON.stringify({
      version: 3, byte_offset: 0, total_cost_usd: 0, total_tokens: 0, total_sessions: 0,
      last_session_id: null, by_source: bySource, by_date: {}, by_week: {}, by_month: {},
      skipped_corrupt_lines: 0, updated_at: new Date().toISOString(),
    }));
  }

  function writeRoutineMetrics(dir: string, rows: Array<{ routine_id: string; event: string }>) {
    const lines = rows.map(r => JSON.stringify({
      ts: new Date().toISOString(), routine_id: r.routine_id, event: r.event, delivery: 'cron-create',
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'state', 'routine-metrics.jsonl'), lines);
  }

  test('no enabled routines → ok', withTmpdir(async (dir) => {
    writeConfig(dir, BASE_CONFIG);
    const report = await runDoctorCheck(dir);
    expect(routineCostCheck(report).status).toBe('ok');
  }), 20000);

  test('cost-index.json absent → ok', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a')] });
    const report = await runDoctorCheck(dir);
    expect(routineCostCheck(report).status).toBe('ok');
  }), 20000);

  test('fewer than 3 runs → ok (no divide-by-small-N false positive)', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a')] });
    writeCostIndex(dir, { 'routine:a': { cost: 100, tokens: 1000 } });
    writeRoutineMetrics(dir, runs('a', 2));
    const report = await runDoctorCheck(dir);
    expect(routineCostCheck(report).status).toBe('ok');
  }), 20000);

  test('outlier routine exceeding 3x peer median and floor → warn naming it', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('cheap'), routine('cheap2'), routine('expensive')] });
    writeCostIndex(dir, {
      'routine:cheap': { cost: 1.2, tokens: 1000 },        // $0.40/run
      'routine:cheap2': { cost: 1.35, tokens: 1000 },      // $0.45/run
      'routine:expensive': { cost: 45, tokens: 100000 },   // $15/run — peer median ≈$0.42, threshold $2
    });
    writeRoutineMetrics(dir, [...runs('cheap', 3), ...runs('cheap2', 3), ...runs('expensive', 3)]);
    const report = await runDoctorCheck(dir);
    const c = routineCostCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('expensive');
    expect(c.detail).toContain('peer median $');  // the comparison basis is rendered, not just the verdict
  }), 20000);

  test('all routines under the floor → ok', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a'), routine('b')] });
    writeCostIndex(dir, {
      'routine:a': { cost: 3, tokens: 1000 },   // $1.00/run
      'routine:b': { cost: 3.3, tokens: 1000 }, // $1.10/run
    });
    writeRoutineMetrics(dir, [...runs('a', 3), ...runs('b', 3)]);
    const report = await runDoctorCheck(dir);
    expect(routineCostCheck(report).status).toBe('ok');
  }), 20000);

  test('polluted routine:<artifact> key with no matching routine id is ignored', withTmpdir(async (dir) => {
    // cost-tracker's classifySource() can mint keys like "routine:fired" from the
    // log-routine-event.sh fallback matcher — must not be treated as a real routine.
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a')] });
    writeCostIndex(dir, {
      'routine:a': { cost: 3, tokens: 1000 },     // $1.00/run, under floor
      'routine:fired': { cost: 999, tokens: 1 },  // classifier artifact
    });
    writeRoutineMetrics(dir, runs('a', 3));
    const report = await runDoctorCheck(dir);
    const c = routineCostCheck(report);
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('999');
  }), 20000);

  test('skipped fires count toward the run denominator (cheap-but-skipped routine not flagged)', withTmpdir(async (dir) => {
    // skippy proceeded 3x (started+fired) but was idle-gated 20x (skipped-waiting). cost-tracker
    // buckets all 23 fire-turns' cost to routine:skippy, so dividing by only the 3 `fired`
    // events would report ~$7.67/run and warn; dividing by all 23 fire-turns reports $1/run.
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('skippy'), routine('normal')] });
    writeCostIndex(dir, {
      'routine:skippy': { cost: 23, tokens: 23000 },  // 23 fire-turns → $1.00/run
      'routine:normal': { cost: 3, tokens: 3000 },    // 3 fire-turns → $1.00/run
    });
    writeRoutineMetrics(dir, [
      ...runs('skippy', 3, 'started'), ...runs('skippy', 3, 'fired'), ...runs('skippy', 20, 'skipped-waiting'),
      ...runs('normal', 3, 'started'), ...runs('normal', 3, 'fired'),
    ]);
    const c = routineCostCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('skippy');
  }), 20000);

  test('expensive routine in a two-routine fleet is flagged (peer median, not self-inclusive)', withTmpdir(async (dir) => {
    // With a self-inclusive median, 3×median is unreachable at n=2 and the outlier escapes;
    // comparing against the peer median (self excluded) catches it.
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('cheap'), routine('pricey')] });
    writeCostIndex(dir, {
      'routine:cheap': { cost: 3, tokens: 1000 },    // $1.00/run
      'routine:pricey': { cost: 30, tokens: 10000 }, // $10.00/run — peer median $1, threshold $3
    });
    writeRoutineMetrics(dir, [...runs('cheap', 3), ...runs('pricey', 3)]);
    const c = routineCostCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('pricey');
  }), 20000);

  test('default floor absorbs a low-absolute-cost outlier that is many times the median', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a'), routine('b'), routine('lonewolf')] });
    writeCostIndex(dir, {
      'routine:a': { cost: 0.03, tokens: 100 },  // $0.01/run
      'routine:b': { cost: 0.036, tokens: 100 }, // $0.012/run (median)
      'routine:lonewolf': { cost: 0.15, tokens: 100 },  // $0.05/run — >3x median, under the $2 floor
    });
    writeRoutineMetrics(dir, [...runs('a', 3), ...runs('b', 3), ...runs('lonewolf', 3)]);
    const report = await runDoctorCheck(dir);
    expect(routineCostCheck(report).status).toBe('ok');
  }), 20000);

  test('config.doctor.routine_cost_floor_usd override flags the same outlier', withTmpdir(async (dir) => {
    writeConfig(dir, {
      ...BASE_CONFIG, routines: [routine('a'), routine('b'), routine('lonewolf')],
      doctor: { routine_cost_floor_usd: 0.02 },
    });
    writeCostIndex(dir, {
      'routine:a': { cost: 0.03, tokens: 100 },
      'routine:b': { cost: 0.036, tokens: 100 },
      'routine:lonewolf': { cost: 0.15, tokens: 100 },
    });
    writeRoutineMetrics(dir, [...runs('a', 3), ...runs('b', 3), ...runs('lonewolf', 3)]);
    const report = await runDoctorCheck(dir);
    const c = routineCostCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('lonewolf');
  }), 20000);
});

describe('doctor channel-liveness check', () => {
  const liveCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'channel-liveness');

  function seedChannel(dir: string, port: number | undefined, tokenLine = 'TELEGRAM_BOT_TOKEN=dummy') {
    writeConfig(dir, {
      ...BASE_CONFIG,
      channels: { telegram: { enabled: true, dm_channel_id: '1', state_dir: 'chan' } },
    });
    const chanDir = path.join(dir, 'chan');
    fs.mkdirSync(chanDir, { recursive: true });
    if (tokenLine) fs.writeFileSync(path.join(chanDir, '.env'), tokenLine + '\n');
    return { HERMIT_DOCTOR_TELEGRAM_API: `http://127.0.0.1:${port}` };
  }

  test('no channels configured → ok, skipped', withTmpdir(async (dir) => {
    writeConfig(dir, BASE_CONFIG);
    const report = await runDoctorCheck(dir);
    const c = liveCheck(report);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('skipped');
  }), 20000);

  test('missing .env → warn, no token configured', withTmpdir(async (dir) => {
    const env = seedChannel(dir, 0, '');
    const r = await runScript('doctor-check.ts', {
      args: ['.claude-code-hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
    });
    const report = JSON.parse(r.stdout);
    const c = liveCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('no token configured');
  }), 20000);

  test('200 response → ok, reachable', withTmpdir(async (dir) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('{"ok":true}', { status: 200 }) });
    try {
      const env = seedChannel(dir, server.port);
      const r = await runScript('doctor-check.ts', {
        args: ['.claude-code-hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
      });
      const report = JSON.parse(r.stdout);
      const c = liveCheck(report);
      expect(c.status).toBe('ok');
      expect(c.detail).toContain('reachable');
    } finally {
      server.stop(true);
    }
  }), 20000);

  test('401 response → fail, auth rejected, token never echoed', withTmpdir(async (dir) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('unauthorized', { status: 401 }) });
    try {
      const env = seedChannel(dir, server.port);
      const r = await runScript('doctor-check.ts', {
        args: ['.claude-code-hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
      });
      const report = JSON.parse(r.stdout);
      const c = liveCheck(report);
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('auth rejected');
      expect(c.detail).not.toContain('dummy');
    } finally {
      server.stop(true);
    }
  }), 20000);

  test('timeout → warn, unreachable', withTmpdir(async (dir) => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
    try {
      const env = seedChannel(dir, server.port);
      const r = await runScript('doctor-check.ts', {
        args: ['.claude-code-hermit'], cwd: dir,
        env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env, HERMIT_DOCTOR_LIVENESS_TIMEOUT_MS: '250' },
      });
      const report = JSON.parse(r.stdout);
      const c = liveCheck(report);
      expect(c.status).toBe('warn');
      expect(c.detail).toContain('unreachable');
    } finally {
      server.stop(true);
    }
  }), 20000);
});

describe('doctor routine template contract', () => {
  test('template config validates cleanly with the doctor routine present', () => {
    const template = readJson(path.join(TEMPLATES, 'config.json.template'));
    const routine = template.routines.find((r: any) => r.id === 'doctor');
    expect(routine).toBeDefined();
    expect(routine.schedule).toBe('0 10 * * 1');
    expect(routine.skill).toBe('claude-code-hermit:hermit-doctor');
    expect(routine.enabled).toBe(true);

    const { errors, warnings } = validate(template);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

// ============================================================
// proposal-triage batch contract (PR-1: batch proposal-triage in reflect)
//
// proposal-triage used to be invoked strictly per-candidate ("never as a
// batch"); it now accepts N candidates in one call and returns N title-tagged
// verdict blocks, mirroring reflection-judge's existing batch grammar. Guards
// against: the agent definition regressing to the old bare CREATE/SUPPRESS —
// <code>/DUPLICATE:<PROP-ID> grammar, and any caller (reflect, proposal-create,
// capability-brainstorm) still parsing the old bare grammar.
// ============================================================

describe('proposal-triage batch contract', () => {
  const triage = read(path.join(AGENTS, 'proposal-triage.md'));
  const branches = read(path.join(SKILLS, 'reflect', 'branches.md'));
  const reflectSkill = read(path.join(SKILLS, 'reflect', 'SKILL.md'));
  const proposalCreate = read(path.join(SKILLS, 'proposal-create', 'SKILL.md'));
  const brainstorm = read(path.join(SKILLS, 'capability-brainstorm', 'SKILL.md'));

  test('agents/proposal-triage.md documents multi-candidate batch input', () => {
    expect(triage).toContain('batch of one');
    expect(triage).toContain('separated by a blank line');
  });

  test('agents/proposal-triage.md documents the title-tagged verdict grammar', () => {
    expect(triage).toContain('CREATE: <title>');
    expect(triage).toContain('SUPPRESS: <title>');
    expect(triage).toContain('DUPLICATE: <title>');
  });

  test('agents/proposal-triage.md no longer documents the old bare grammar', () => {
    expect(triage).not.toContain('SUPPRESS — <code>');
    expect(triage).not.toContain('DUPLICATE:<PROP-ID> — <one-line reason>');
  });

  test('reflect/branches.md gates candidates through proposal-triage in one batched call', () => {
    expect(branches).toContain('single batched call');
    expect(branches).not.toContain('single-candidate — invoke per-candidate, never as a batch');
  });

  test('reflect/branches.md parses the title-tagged triage verdict grammar', () => {
    // Routed via record-gate.ts's PROCEED/DROP tokens rather than the raw agent
    // grammar directly — the raw `CREATE: <title>` line still flows into the
    // script's stdin (see the record-gate.ts invocation just above these lines).
    expect(branches).toContain('PROCEED|CREATE');
    expect(branches).toContain('DROP|DUPLICATE:<PROP-ID>');
    expect(branches).toContain('DROP|SUPPRESS:<code>');
  });

  test('reflect/SKILL.md no longer describes per-candidate triage dispatch', () => {
    expect(reflectSkill).not.toContain('Triage each candidate');
    expect(reflectSkill).not.toContain('per-candidate `claude-code-hermit:proposal-triage`');
  });

  test('proposal-create/SKILL.md documents its call as a batch of one and parses the new grammar', () => {
    expect(proposalCreate).toContain('batch of one');
    expect(proposalCreate).toContain('PROCEED|CREATE');
    expect(proposalCreate).toContain('DROP|DUPLICATE:<PROP-ID>');
    expect(proposalCreate).toContain('DROP|SUPPRESS:<code>');
  });

  test('capability-brainstorm/SKILL.md parses proposal-create outcome with the title-tagged grammar', () => {
    expect(brainstorm).toContain('CREATE: <title>');
    expect(brainstorm).toContain('DUPLICATE: <title> — <PROP-ID>');
  });
});

// ============================================================
// Chat voice contract
//
// Presence/drift guard proving the "no internal IDs / no slash commands / no
// token counts to a channel" rule is documented in the two surfaces that
// carry it — this proves the rule is specified, not that every
// channel-emitting skill obeys it (model-authored replies can't be enforced
// by a markdown scan). The one deterministic (non-model) channel sender that
// composes prose, composeBudgetMessage, is covered by a real forbidden-string
// assertion in hooks.contract.test.ts (it shares that file's single-import
// cost-tracker.ts fixture — see the comment there on why the module can only
// be imported once per process).
// ============================================================

describe('chat voice contract', () => {
  test('CLAUDE-APPEND.md documents the channel voice rule', () => {
    const append = read(path.join(TEMPLATES, 'CLAUDE-APPEND.md'));
    expect(append).toContain('Channel voice.');
    expect(append).toContain('No internal IDs (PROP-NNN, S-NNN, MP-…)');
  });

  test('channel-responder/SKILL.md mirrors the channel voice rule', () => {
    const responder = read(path.join(SKILLS, 'channel-responder', 'SKILL.md'));
    expect(responder).toContain('Channel voice:');
    expect(responder).toContain('no internal IDs');
  });

  test('hermit-doctor/SKILL.md channel example contains no slash command', () => {
    const doctor = read(path.join(SKILLS, 'hermit-doctor', 'SKILL.md'));
    expect(doctor).not.toMatch(/then run \/channel-setup/);
  });
});
