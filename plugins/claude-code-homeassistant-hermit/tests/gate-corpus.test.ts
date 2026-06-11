// WP8 golden-corpus equivalence gate for the two safety hooks.
//
// Runs the retired Python implementations (materialized from git history —
// commit 42c0c8f~1, the last revision before the ha_agent_lab package was
// deleted) side by side with the TS ports in hooks/*.ts on every corpus
// entry under tests/fixtures/gate-corpus/, asserting byte-identical
// stdout / stderr / exit codes.
//
// The old gate is run "as CI knew it": PYTHONPATH points at the materialized
// src/ so `from ha_agent_lab.policy import ...` resolves (it never did on a
// standard operator install — see hooks/mcp-safety-gate.ts header).
//
// Documented divergences are explicit per-entry (`divergence` + `expect_py`
// in the fixture): the Python gate crashed with exit 1 (= fail-OPEN under
// Claude Code hook semantics) on valid-JSON-but-non-object payloads; the TS
// port fails closed (exit 2). For those entries both sides are asserted
// against their documented behavior instead of byte-equality.
//
// Requirements: python3 with python-dotenv + PyYAML (the old package's deps,
// `pip install -e` pulled them in CI), and a git checkout deep enough to
// contain 42c0c8f~1 (CI uses fetch-depth: 0).

import { beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLUGIN_DIR = join(import.meta.dir, '..');
const CORPUS_DIR = join(import.meta.dir, 'fixtures', 'gate-corpus');
const OLD_REV = '42c0c8ff801438d637b3a28ecf7c1f7ac7442ac0~1';
const OLD_PREFIX = 'plugins/claude-code-homeassistant-hermit';

interface CorpusEntry {
  gate: 'mcp' | 'curl';
  stdin: string;
  verdict: 'block' | 'allow' | 'ask' | 'curl-allow' | 'passthrough' | 'error-passthrough';
  config_mode?: string;
  env_file?: string;
  set_project_dir?: boolean;
  env?: Record<string, string>;
  stderr_class?: 'exact' | 'exception-text';
  divergence?: string;
  expect_py?: { exit: number; stderr_contains?: string };
  note?: string;
}

let python = '';
let goldenDir = ''; // materialized pre-deletion Python hooks + ha_agent_lab package

function gitShow(path: string): string {
  const r = Bun.spawnSync(['git', 'show', `${OLD_REV}:${path}`], { cwd: PLUGIN_DIR });
  if (r.exitCode !== 0) {
    throw new Error(
      `git show ${OLD_REV}:${path} failed (shallow clone? CI needs fetch-depth: 0):\n${r.stderr.toString()}`,
    );
  }
  return r.stdout.toString();
}

function resolvePython(): string {
  const candidates = [
    process.env.GATE_PARITY_PYTHON,
    'python3',
    '/usr/bin/python3',
    'python',
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      const r = Bun.spawnSync([c, '-c', 'import dotenv, yaml']);
      if (r.exitCode === 0) return c;
    } catch {
      // candidate not on PATH
    }
  }
  throw new Error(
    'No Python with python-dotenv + PyYAML found (the retired gate needs both). ' +
      'Install them or set GATE_PARITY_PYTHON. This equivalence gate must not be skipped.',
  );
}

beforeAll(() => {
  python = resolvePython();
  goldenDir = mkdtempSync(join(tmpdir(), 'gate-golden-'));
  mkdirSync(join(goldenDir, 'hooks'), { recursive: true });
  mkdirSync(join(goldenDir, 'src', 'ha_agent_lab'), { recursive: true });
  for (const f of ['mcp-safety-gate.py', 'curl-host-gate.py']) {
    writeFileSync(join(goldenDir, 'hooks', f), gitShow(`${OLD_PREFIX}/hooks/${f}`));
  }
  // policy.py imports .config (-> dotenv, .markdown -> yaml); materialize the
  // import closure of ha_agent_lab.policy exactly as deleted.
  for (const f of ['__init__.py', 'policy.py', 'config.py', 'markdown.py']) {
    writeFileSync(join(goldenDir, 'src', 'ha_agent_lab', f), gitShow(`${OLD_PREFIX}/src/ha_agent_lab/${f}`));
  }
});

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

function prepareCwd(entry: CorpusEntry): string {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-case-'));
  if (entry.config_mode !== undefined) {
    const cfgDir = join(cwd, '.claude-code-hermit');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ ha_safety_mode: entry.config_mode }));
  }
  if (entry.env_file !== undefined) {
    writeFileSync(join(cwd, '.env'), entry.env_file);
  }
  return cwd;
}

function entryEnv(entry: CorpusEntry, cwd: string): Record<string, string> {
  const env = { ...baseEnv(), ...(entry.env ?? {}) };
  if (entry.set_project_dir) env['CLAUDE_PROJECT_DIR'] = cwd;
  return env;
}

function run(cmd: string[], entry: CorpusEntry, cwd: string, extraEnv: Record<string, string> = {}): RunResult {
  const r = Bun.spawnSync(cmd, {
    cwd,
    env: { ...entryEnv(entry, cwd), ...extraEnv },
    stdin: Buffer.from(entry.stdin, 'utf8'),
    timeout: 15_000,
  });
  return { exit: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function runOldPython(entry: CorpusEntry, cwd: string): RunResult {
  const hook = join(goldenDir, 'hooks', entry.gate === 'mcp' ? 'mcp-safety-gate.py' : 'curl-host-gate.py');
  return run([python, hook], entry, cwd, {
    PYTHONPATH: join(goldenDir, 'src'),
    // Pin stdio to UTF-8 so locale-less environments don't make CPython die
    // on raw unicode entity names in stderr (CI shells were always UTF-8).
    PYTHONIOENCODING: 'utf-8',
  });
}

function runNewTs(entry: CorpusEntry, cwd: string): RunResult {
  const hook = join(PLUGIN_DIR, 'hooks', entry.gate === 'mcp' ? 'mcp-safety-gate.ts' : 'curl-host-gate.ts');
  return run([process.execPath, hook], entry, cwd);
}

/** Independent verdict assertion on the TS side — byte-equality alone could pass with both sides wrong. */
function assertVerdict(entry: CorpusEntry, ts: RunResult): void {
  switch (entry.verdict) {
    case 'block':
      expect(ts.exit).toBe(2);
      expect(ts.stdout).toBe('');
      expect(ts.stderr).not.toBe('');
      break;
    case 'allow':
      expect(ts.exit).toBe(0);
      expect(ts.stdout).toBe('');
      expect(ts.stderr).toBe('');
      break;
    case 'ask': {
      expect(ts.exit).toBe(0);
      const out = JSON.parse(ts.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
      break;
    }
    case 'curl-allow': {
      expect(ts.exit).toBe(0);
      const out = JSON.parse(ts.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
      break;
    }
    case 'passthrough':
      expect(ts.exit).toBe(0);
      expect(ts.stdout).toBe('');
      expect(ts.stderr).toBe('');
      break;
    case 'error-passthrough':
      expect(ts.exit).toBe(0);
      expect(ts.stdout).toBe('');
      expect(ts.stderr).not.toBe('');
      break;
  }
}

function compare(entry: CorpusEntry): void {
  // Fresh cwd per side so lru_cache/Map caches and .env reads stay isolated
  // yet observe identical file layouts.
  const pyCwd = prepareCwd(entry);
  const tsCwd = prepareCwd(entry);
  const py = runOldPython(entry, pyCwd);
  const ts = runNewTs(entry, tsCwd);

  assertVerdict(entry, ts);

  if (entry.divergence) {
    // Documented divergence: assert each side's pinned behavior.
    expect(entry.expect_py).toBeDefined();
    expect(py.exit).toBe(entry.expect_py!.exit);
    if (entry.expect_py!.stderr_contains) {
      expect(py.stderr).toContain(entry.expect_py!.stderr_contains);
    }
    expect(py.stdout).toBe(ts.stdout); // verdict channel (stdout) still identical
    return;
  }

  expect(ts.exit).toBe(py.exit);
  expect(ts.stdout).toBe(py.stdout);
  if (entry.stderr_class === 'exception-text') {
    // curl gate exception path: CPython vs Bun error strings differ; the
    // contract is the prefix + the verdict (no stdout decision, exit 0).
    expect(py.stderr.startsWith('curl-host-gate: ')).toBe(true);
    expect(ts.stderr.startsWith('curl-host-gate: ')).toBe(true);
  } else {
    expect(ts.stderr).toBe(py.stderr);
  }
}

const entryFiles = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json')).sort();

test('corpus is non-trivial', () => {
  expect(entryFiles.length).toBeGreaterThanOrEqual(70);
});

for (const file of entryFiles) {
  const entry = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')) as CorpusEntry;
  test(`golden corpus: ${file.replace(/\.json$/, '')}`, () => {
    compare(entry);
  });
}

// ---------------------------------------------------------------------------
// Oversized payloads — generated here instead of committed as multi-MB fixtures.
// ---------------------------------------------------------------------------

test('golden corpus: oversized entity list with one sensitive id blocks identically', () => {
  const ids = Array.from({ length: 50_000 }, (_, i) => `light.bulb_${i}`);
  ids.push('lock.front_door');
  const entry: CorpusEntry = {
    gate: 'mcp',
    stdin: JSON.stringify({ tool_input: { entity_id: ids } }),
    verdict: 'block',
  };
  compare(entry);
});

test('golden corpus: multi-megabyte garbage stdin fails closed identically', () => {
  const entry: CorpusEntry = {
    gate: 'mcp',
    stdin: 'x'.repeat(2 * 1024 * 1024),
    verdict: 'block',
  };
  compare(entry);
});

test('golden corpus: oversized safe-only entity list allows identically', () => {
  const ids = Array.from({ length: 50_000 }, (_, i) => `light.bulb_${i}`);
  const entry: CorpusEntry = {
    gate: 'mcp',
    stdin: JSON.stringify({ tool_input: { entity_id: ids } }),
    verdict: 'allow',
  };
  compare(entry);
});
