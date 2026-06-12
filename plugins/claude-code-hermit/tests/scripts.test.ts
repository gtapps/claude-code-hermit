// Script & static tests for claude-code-hermit (bun test port of run-scripts.sh).
// Tests standalone scripts called by hooks or the CLI, but not themselves hooks.
//
// Structure mirrors run-scripts.sh 1:1 — all 174 run_test cases are preserved
// with their original names. The bash file's `bun -e "require(...)"` probes of
// exported functions are converted to direct in-process imports + expect();
// subprocess execution (runScript / bash) is kept only where a case exercises a
// script's end-to-end CLI behavior (argv, exit code, stdout, file writes).
//
// Usage: bun test tests/scripts.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, PLUGIN_ROOT, SCRIPTS_DIR } from './helpers/run';
import { setupWorkdir, fixturesDir, type Workdir } from './helpers/workdir';

// In-process imports — pure libs with no import-time CWD dependence.
import { safeForLLM } from '../scripts/lib/sanitize';
import * as ccCompat from '../scripts/lib/cc-compat';
import {
  sessionId, transcriptPath, sessionCrons, backgroundTasks,
  extractUsage, costLogPath, ccVersion,
} from '../scripts/lib/cc-compat';
import * as costLog from '../scripts/lib/cost-log';
import { costIndexPath, readCostIndex, updateCostIndex, scanAutomatedOpus } from '../scripts/lib/cost-log';
import * as pricing from '../scripts/lib/pricing';
import { calculateCost, costByType } from '../scripts/lib/pricing';
import { search } from '../scripts/lib/search';

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

/** Subprocess runner for the bash scripts under test (check-upgrade.sh etc.). */
async function runBash(
  scriptPath: string,
  opts: { args?: string[]; cwd?: string; env?: Record<string, string> } = {},
) {
  const proc = Bun.spawn({
    cmd: ['bash', scriptPath, ...(opts.args ?? [])],
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: Buffer.from(''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const isoSec = (d: Date) => d.toISOString().slice(0, 19) + 'Z';
const utcDate = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);
// Local calendar date, matching python's datetime.date.today() in the bash suite.
const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// -------------------------------------------------------
// check-upgrade.sh
// -------------------------------------------------------

describe('check-upgrade.sh', () => {
  let wd: Workdir;
  let out = '';

  beforeAll(async () => {
    wd = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), '{"_hermit_versions":{"claude-code-hermit":"0.0.0"}}');
    const r = await runBash(path.join(SCRIPTS_DIR, 'check-upgrade.sh'), {
      args: [PLUGIN_ROOT], cwd: wd.dir,
    });
    out = r.stdout + r.stderr;
  });
  afterAll(() => wd.cleanup());

  test('check-upgrade.sh', () => {
    expect(out.length).toBeGreaterThan(0);
  });

  test('check-upgrade output', () => {
    expect(out).toContain('---Upgrade Available---');
  });
});

describe('check-upgrade.sh always_on banner', () => {
  const pluginVer = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')).version;
  async function run(configObj: any) {
    const wd = setupWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), JSON.stringify(configObj));
      const r = await runBash(path.join(SCRIPTS_DIR, 'check-upgrade.sh'), { args: [PLUGIN_ROOT], cwd: wd.dir });
      return r.stdout + r.stderr;
    } finally { wd.cleanup(); }
  }

  test('always_on=true + gap -> REQUIRED directive', async () => {
    const out = await run({ always_on: true, _hermit_versions: { 'claude-code-hermit': '0.0.0' } });
    expect(out).toContain('---Upgrade Available---');
    expect(out).toContain('REQUIRED');
    expect(out).toContain('hermit-evolve unattended');
  });

  test('always_on=false + gap -> advisory, no REQUIRED', async () => {
    const out = await run({ always_on: false, _hermit_versions: { 'claude-code-hermit': '0.0.0' } });
    expect(out).toContain('---Upgrade Available---');
    expect(out).not.toContain('REQUIRED');
  });

  test('always_on absent + gap -> advisory, no REQUIRED', async () => {
    const out = await run({ _hermit_versions: { 'claude-code-hermit': '0.0.0' } });
    expect(out).toContain('---Upgrade Available---');
    expect(out).not.toContain('REQUIRED');
  });

  test('no gap -> silent (no banner)', async () => {
    const out = await run({ always_on: true, _hermit_versions: { 'claude-code-hermit': pluginVer } });
    expect(out).not.toContain('---Upgrade Available---');
  });
});

// -------------------------------------------------------
// Static file checks
// -------------------------------------------------------

describe('static file checks', () => {
  test('deny-patterns.json', () => {
    const d = readJson(path.join(PLUGIN_ROOT, 'state-templates', 'deny-patterns.json'));
    const denyRead = d?.sandbox?.filesystem?.denyRead ?? [];
    expect(Array.isArray(d.default)).toBe(true);
    expect(Array.isArray(d.always_on)).toBe(true);
    expect(Array.isArray(denyRead)).toBe(true);
    expect(denyRead.length).toBeGreaterThan(0);
  });

  test('bin scripts executable', () => {
    const binDir = path.join(PLUGIN_ROOT, 'state-templates', 'bin');
    for (const f of fs.readdirSync(binDir)) {
      expect(() => fs.accessSync(path.join(binDir, f), fs.constants.X_OK)).not.toThrow();
    }
  });

  test('hermit-docker update moves the pin, not the marketplace', () => {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'bin', 'hermit-docker'), 'utf8');
    // The whole point of the fix: durable `plugin update` per plugin with explicit scope...
    expect(src).toContain('claude plugin update');
    expect(src).toContain('--scope');
    expect(src).toContain('hermit-evolve unattended');
    // ...and NOT the old ephemeral marketplace-refresh loop.
    expect(src).not.toContain('claude plugin marketplace update');
  });
});

// -------------------------------------------------------
// hermit-update (host path, stubbed claude/tmux)
// -------------------------------------------------------

describe('hermit-update host path', () => {
  // Build a workdir with the wrapper installed at .claude-code-hermit/bin, a config
  // (no docker compose → host path), and stub `claude`/`tmux` on a prepended PATH.
  function fixture(opts: { listJson: (proj: string) => string }) {
    const wd = setupWorkdir();
    const proj = wd.dir;
    const binDir = hermit(proj, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'bin', 'hermit-update'),
      path.join(binDir, 'hermit-update'),
    );
    write(hermit(proj, 'config.json'),
      JSON.stringify({ tmux_session_name: 'hermit-{project_name}', _hermit_versions: { 'claude-code-hermit': '1.2.0' } }));

    const stub = path.join(proj, '.stub');
    fs.mkdirSync(stub, { recursive: true });
    const listFile = path.join(stub, 'list.json');
    const recFile = path.join(stub, 'rec.txt');
    write(listFile, opts.listJson(proj));
    write(path.join(stub, 'claude'),
      `#!/usr/bin/env bash\n` +
      `if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then cat "${listFile}"; exit 0; fi\n` +
      `if [ "$1" = "plugin" ] && [ "$2" = "update" ]; then echo "$@" >> "${recFile}"; exit 0; fi\n` +
      `exit 0\n`);
    write(path.join(stub, 'tmux'),
      `#!/usr/bin/env bash\n[ "$1" = "has-session" ] && exit 1\nexit 0\n`);
    fs.chmodSync(path.join(stub, 'claude'), 0o755);
    fs.chmodSync(path.join(stub, 'tmux'), 0o755);

    return { wd, proj, recFile, env: { PATH: `${stub}:${process.env.PATH}` } };
  }

  const listThreeScopes = (proj: string) => JSON.stringify([
    { id: 'claude-code-hermit@claude-code-hermit', scope: 'local', enabled: true, version: '1.2.0', projectPath: proj },
    { id: 'some-user@official', scope: 'user', enabled: true, version: '0.5.0', projectPath: '/elsewhere' },
    { id: 'cross@mp', scope: 'local', enabled: true, version: '9.9.9', projectPath: '/other/project' },
  ]);

  test('updates project plugin with full id + scope; skips user + cross-project', async () => {
    const f = fixture({ listJson: listThreeScopes });
    try {
      const r = await runBash(hermit(f.proj, 'bin', 'hermit-update'), { args: ['--yes'], cwd: f.proj, env: f.env });
      const rec = fs.existsSync(f.recFile) ? fs.readFileSync(f.recFile, 'utf8') : '';
      // durable update of the project-local plugin, full id + explicit scope
      expect(rec).toContain('plugin update claude-code-hermit@claude-code-hermit --scope local');
      // user-scope and cross-project entries are NOT updated
      expect(rec).not.toContain('some-user@official');
      expect(rec).not.toContain('cross@mp');
      // user-scope surfaced as a skip hint; no live tmux session message
      expect(r.stdout).toContain('some-user@official');
      expect(r.stdout).toContain('No live tmux session');
      // history entry shape
      const hist = fs.readFileSync(hermit(f.proj, 'state', 'update-history.jsonl'), 'utf8').trim();
      const entry = JSON.parse(hist);
      expect(entry.trigger).toBe('hermit-update');
      expect(entry.mode).toBe('host-plugins');
      expect(Array.isArray(entry.plugins)).toBe(true);
      expect(entry.plugins[0].id).toBe('claude-code-hermit@claude-code-hermit');
    } finally { f.wd.cleanup(); }
  });

  test('--dry-run records no update calls', async () => {
    const f = fixture({ listJson: listThreeScopes });
    try {
      await runBash(hermit(f.proj, 'bin', 'hermit-update'), { args: ['--dry-run'], cwd: f.proj, env: f.env });
      expect(fs.existsSync(f.recFile)).toBe(false);
    } finally { f.wd.cleanup(); }
  });
});

// -------------------------------------------------------
// sanitize.js — safeForLLM (in-process)
// -------------------------------------------------------

describe('safeForLLM', () => {
  test('safeForLLM: strips <system-reminder>', () => {
    expect(safeForLLM('<system-reminder>inject</system-reminder>')).not.toContain('<system-reminder>');
  });

  test('safeForLLM: strips </system>', () => {
    expect(safeForLLM('</system>')).not.toContain('<');
  });

  test('safeForLLM: strips <assistant>, <user>, <thinking>', () => {
    const r = safeForLLM('<assistant>x</assistant><user>y</user><thinking>z</thinking>');
    expect(r).not.toContain('<assistant>');
    expect(r).not.toContain('<user>');
    expect(r).not.toContain('<thinking>');
  });

  test('safeForLLM: strips <tool_use>, <tool_result>, <function_calls>', () => {
    const r = safeForLLM('<tool_use/><tool_result/><function_calls/>');
    expect(r).not.toContain('<tool_use');
    expect(r).not.toContain('<tool_result');
    expect(r).not.toContain('<function_calls');
  });

  test('safeForLLM: strips tags with attributes', () => {
    expect(safeForLLM('<system class="x">inject</system>')).not.toContain('<system');
  });

  test('safeForLLM: bracket-wraps stripped tags (readable)', () => {
    const r = safeForLLM('<system-reminder>x</system-reminder>');
    expect(r).toContain('[system-reminder]');
    expect(r).toContain('[/system-reminder]');
  });

  test('safeForLLM: preserves non-injection text', () => {
    expect(safeForLLM('normal error text')).toBe('normal error text');
  });

  test('safeForLLM: preserves non-injection angle brackets (3 < 5)', () => {
    expect(safeForLLM('3 < 5')).toBe('3 < 5');
  });

  test('safeForLLM: preserves unknown tags (<foo>)', () => {
    expect(safeForLLM('<foo>bar</foo>')).toBe('<foo>bar</foo>');
  });

  test('safeForLLM: inherits control-char stripping from safe()', () => {
    expect(safeForLLM('\x1b[31mred\x1b[0m')).not.toContain('\x1b');
  });

  test('safeForLLM: case-insensitive (<System-Reminder>)', () => {
    const r = safeForLLM('<System-Reminder>x</System-Reminder>');
    expect(r).not.toContain('<System-Reminder>');
    expect(r).not.toContain('</System-Reminder>');
  });
});

// -------------------------------------------------------
// knowledge-lint.ts (subprocess — argv/stdout CLI contract)
// -------------------------------------------------------

const runLint = (dir: string) =>
  runScript('knowledge-lint.ts', { args: [hermit(dir)] });

describe('knowledge-lint', () => {
  // 4. Empty state — no raw/, no compiled/
  test('knowledge-lint (empty state)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{}');
    const r = await runLint(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Knowledge base is clean');
  }));

  // 5. Findings: stale, unreferenced, oversized, missing-type
  describe('findings', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      const dir = wd.dir;
      fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
      fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
      write(hermit(dir, 'config.json'), '{}');
      write(hermit(dir, 'raw', 'old-snap.md'),
        '---\ntitle: old\ncreated: 2025-01-01T00:00:00+00:00\n---\ndata');
      write(hermit(dir, 'compiled', 'note.md'),
        '---\ntitle: no type\ncreated: 2026-04-01T00:00:00+00:00\n---\nshort');
      write(hermit(dir, 'compiled', 'big.md'),
        `---\ntitle: big\ntype: briefing\ncreated: 2026-04-10T00:00:00+00:00\n---\n${'x'.repeat(1500)}`);
      const r = await runLint(dir);
      out = r.stdout + r.stderr;
    });
    afterAll(() => wd.cleanup());

    test('knowledge-lint (finds unreferenced or stale)', () => {
      expect(out).toMatch(/unreferenced|stale/);
    });
    test('knowledge-lint (finds stale)', () => {
      expect(out).toContain('stale');
    });
    test('knowledge-lint (finds oversized)', () => {
      expect(out).toContain('oversized');
    });
    test('knowledge-lint (finds missing-type)', () => {
      expect(out).toContain('missing-type');
    });
  });

  // 5a. injection_stub exempts oversized artifact; unstubbed oversized still flagged
  describe('injection_stub exemption', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      const dir = wd.dir;
      fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
      write(hermit(dir, 'config.json'), '{}');
      write(hermit(dir, 'compiled', 'context-stubbed.md'),
        `---\ntitle: stubbed\ntype: context\ncreated: 2026-06-01T00:00:00+00:00\ntags: [foundational]\ninjection_stub: House profile stub\n---\n${'x'.repeat(1500)}`);
      write(hermit(dir, 'compiled', 'briefing-big.md'),
        `---\ntitle: big\ntype: briefing\ncreated: 2026-06-01T00:00:00+00:00\n---\n${'x'.repeat(1500)}`);
      const r = await runLint(dir);
      out = r.stdout + r.stderr;
    });
    afterAll(() => wd.cleanup());

    test('knowledge-lint (stub exempts oversized)', () => {
      expect(out).not.toContain('context-stubbed');
    });
    test('knowledge-lint (unstubbed oversized still flagged)', () => {
      expect(out).toContain('oversized');
    });
  });

  // 5b. Topic pages — staleness on updated ?? created, all topics checked, missing-updated lint
  describe('topic pages', () => {
    let wd: Workdir;
    let out = '';
    beforeAll(async () => {
      wd = setupWorkdir();
      const dir = wd.dir;
      fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
      write(hermit(dir, 'config.json'), '{}');
      // Old created but fresh updated — must NOT be stale
      write(hermit(dir, 'compiled', 'topic-fresh.md'),
        `---\ntitle: Fresh topic\ntype: topic\ncreated: ${isoSec(daysAgo(90))}\nupdated: ${isoSec(daysAgo(5))}\n---\nbody`);
      // Stale by updated; second stale topic proves the per-type collapse is gone
      write(hermit(dir, 'compiled', 'topic-stale-a.md'),
        `---\ntitle: Stale A\ntype: topic\ncreated: ${isoSec(daysAgo(200))}\nupdated: ${isoSec(daysAgo(90))}\n---\nbody`);
      write(hermit(dir, 'compiled', 'topic-stale-b.md'),
        `---\ntitle: Stale B\ntype: topic\ncreated: ${isoSec(daysAgo(150))}\nupdated: ${isoSec(daysAgo(70))}\n---\nbody`);
      // Missing updated field
      write(hermit(dir, 'compiled', 'topic-no-updated.md'),
        `---\ntitle: No updated\ntype: topic\ncreated: ${isoSec(daysAgo(5))}\n---\nbody`);
      const r = await runLint(dir);
      out = r.stdout + r.stderr;
    });
    afterAll(() => wd.cleanup());

    test('knowledge-lint (fresh updated not stale despite old created)', () => {
      expect(out).not.toContain('topic-fresh');
    });
    test('knowledge-lint (stale topic flagged by updated)', () => {
      expect(out).toContain('topic-stale-a.md');
    });
    test('knowledge-lint (all topic pages stale-checked, not just newest)', () => {
      expect(out).toContain('topic-stale-b.md');
    });
    test('knowledge-lint (topic-missing-updated flagged)', () => {
      expect(out).toContain('topic-missing-updated');
      expect(out).toContain('topic-no-updated.md');
    });
  });

  // 6. Clean state — valid files with matching schema, no findings
  test('knowledge-lint (clean state)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    write(hermit(dir, 'knowledge-schema.md'),
      '## Work Products\n- briefing: daily summary\n\n## Raw Captures\n- source: fetched articles\n');
    write(hermit(dir, 'raw', 'fresh-snap.md'),
      '---\ntitle: fresh\ntype: source\ncreated: 2026-04-14T00:00:00+00:00\n---\ndata');
    write(hermit(dir, 'compiled', 'summary.md'),
      '---\ntitle: summary\ntype: briefing\ncreated: 2026-04-14T00:00:00+00:00\n---\nBased on fresh-snap.md data');
    const r = await runLint(dir);
    expect(r.stdout).toContain('Knowledge base is clean');
  }));

  // 6a. Schema-empty finding — template-style schema (all bullets commented)
  test('knowledge-lint (schema-empty emitted without --verbose)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    // Add a raw artifact so the schema-presence guard fires
    write(hermit(dir, 'raw', 'snap.md'),
      '---\ntitle: snap\ncreated: 2026-04-22T00:00:00+00:00\n---\ndata');
    // Copy the real template (all bullets inside HTML comments) so parseSchema
    // returns null, removing the starter bullets to simulate a pre-upgrade
    // all-comments schema.
    const template = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'knowledge-schema.md.template'), 'utf-8');
    write(hermit(dir, 'knowledge-schema.md'),
      template.split('\n').filter((l) => !/^- (note|input|review|procedure-brief|topic):/.test(l)).join('\n'));
    const r = await runLint(dir); // exit code intentionally not asserted (bash used `|| true`)
    expect(r.stdout + r.stderr).toContain('schema-empty');
  }));

  // 6b. Schema enforcement — undeclared type warned; declared+matching type clean
  describe('schema enforcement', () => {
    let wd: Workdir;

    beforeAll(() => {
      wd = setupWorkdir();
      const dir = wd.dir;
      fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
      fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
      write(hermit(dir, 'config.json'), '{}');
      // Schema declares 'briefing'; compiled file uses undeclared 'foo'
      write(hermit(dir, 'knowledge-schema.md'),
        '## Work Products\n- briefing: daily summary\n\n## Raw Captures\n- source: fetched articles\n');
    });
    afterAll(() => wd.cleanup());

    test('knowledge-lint (schema: undeclared type warned)', async () => {
      write(hermit(wd.dir, 'compiled', 'unknown.md'),
        '---\ntitle: unknown\ntype: foo\ncreated: 2026-04-14T00:00:00+00:00\n---\ndata');
      const r = await runLint(wd.dir);
      expect(r.stdout + r.stderr).toContain('undeclared-type');
    });

    test('knowledge-lint (schema: declared type is clean)', async () => {
      // Matching type: schema has 'briefing', file has type: briefing
      write(hermit(wd.dir, 'compiled', 'unknown.md'),
        '---\ntitle: summary\ntype: briefing\ncreated: 2026-04-14T00:00:00+00:00\n---\ndata');
      const r = await runLint(wd.dir);
      expect(r.stdout).toContain('Knowledge base is clean');
    });
  });

  // 6c. Bold-format schema — `- **type**:` entries are parsed
  test('knowledge-lint (bold schema entries parsed)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    write(hermit(dir, 'knowledge-schema.md'),
      '## Work Products\n- **briefing**: daily summary\n\n## Raw Captures\n- **source**: fetched articles\n');
    write(hermit(dir, 'raw', 'fresh-snap.md'),
      '---\ntitle: fresh\ntype: source\ncreated: 2026-04-14T00:00:00+00:00\n---\ndata');
    write(hermit(dir, 'compiled', 'summary.md'),
      '---\ntitle: summary\ntype: briefing\ncreated: 2026-04-14T00:00:00+00:00\n---\nBased on fresh-snap.md data');
    const r = await runLint(dir);
    expect(r.stdout).toContain('Knowledge base is clean');
  }));
});

// -------------------------------------------------------
// archive-raw.ts (subprocess — file-archiving CLI contract)
// -------------------------------------------------------

describe('archive-raw', () => {
  // review-weekly must not pin expired raw files, but a real compiled work product must
  let wd: Workdir;
  let lintOut = '';
  let archiveOut = '';

  beforeAll(async () => {
    wd = setupWorkdir();
    const dir = wd.dir;
    fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    // Expired raw named ONLY by a review file -> should archive.
    // Very old dates so this test is stable regardless of the current wall clock.
    write(hermit(dir, 'raw', 'expired-snap.md'),
      '---\ntitle: expired\ncreated: 2000-01-01T00:00:00+00:00\n---\ndata');
    // Expired raw named by a genuine compiled work product -> should stay retained
    write(hermit(dir, 'raw', 'cited-snap.md'),
      '---\ntitle: cited\ncreated: 2000-01-01T00:00:00+00:00\n---\ndata');
    write(hermit(dir, 'compiled', 'review-weekly-2025-W03.md'),
      '---\ntype: review\ncreated: 2000-01-15T00:00:00+00:00\n---\n### Knowledge Health\n- raw/expired-snap.md [14d] — Past retention.\n');
    write(hermit(dir, 'compiled', 'work.md'),
      '---\ntype: briefing\ncreated: 2000-01-15T00:00:00+00:00\n---\nDerived from cited-snap.md.\n');

    const lint = await runLint(dir);
    lintOut = lint.stdout + lint.stderr;
    const arch = await runScript('archive-raw.ts', { args: [hermit(dir)] });
    archiveOut = arch.stdout + arch.stderr;
  });
  afterAll(() => wd.cleanup());

  // Regression: review-weekly must not mask stale raw in knowledge-lint
  test('knowledge-lint (review-weekly does not mask stale)', () => {
    expect(lintOut).toMatch(/^stale /m);
  });
  test('knowledge-lint (expired raw flagged stale)', () => {
    expect(lintOut).toContain('raw/expired-snap.md');
  });

  test('archive-raw (review-weekly does not pin, real ref does)', () => {
    expect(archiveOut).toContain('1 archived, 1 retained');
  });
  test('archive-raw (review-named file archived)', () => {
    expect(fs.existsSync(hermit(wd.dir, 'raw', '.archive', 'expired-snap.md'))).toBe(true);
  });
  test('archive-raw (work-product-cited file retained)', () => {
    expect(fs.existsSync(hermit(wd.dir, 'raw', 'cited-snap.md'))).toBe(true);
  });
});

// -------------------------------------------------------
// update-reflection-state.ts (subprocess — argv + file-write CLI contract)
// -------------------------------------------------------

describe('update-reflection-state', () => {
  /** Run the script against the workdir's state file and return the resulting JSON. */
  async function updateState(dir: string, payload: string) {
    const stateFile = hermit(dir, 'state', 'reflection-state.json');
    const r = await runScript('update-reflection-state.ts', { args: [stateFile, payload] });
    expect(r.exitCode).toBe(0);
    return readJson(stateFile);
  }

  // 7. Fresh state file — initializes counters from scratch
  test('update-reflection-state (initializes counters)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'), '{"last_reflection":null}');
    const d = await updateState(dir,
      '{"ran_with_candidates":true,"judge_accept":2,"proposals_created":1}');
    const c = d.counters;
    expect(c.total_runs).toBe(1);
    expect(c.runs_with_candidates).toBe(1);
    expect(c.empty_runs).toBe(0);
    expect(c.judge_accept).toBe(2);
    expect(c.proposals_created).toBe(1);
    expect(c.last_output_at).not.toBeNull();
  }));

  // 8. Empty run — increments empty_runs, leaves last_output_at null, preserves other keys
  test('update-reflection-state (empty run, preserves other keys)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"scheduled_checks":{"md-audit":{"last_run":"2026-04-01"}},"counters":{"total_runs":5,"empty_runs":2,"runs_with_candidates":3,"last_output_at":null}}');
    const d = await updateState(dir, '{"ran_with_candidates":false}');
    const c = d.counters;
    expect(c.total_runs).toBe(6);
    expect(c.empty_runs).toBe(3);
    expect(c.runs_with_candidates).toBe(3);
    expect(c.last_output_at).toBeNull();
    expect(d.scheduled_checks['md-audit'].last_run).toBe('2026-04-01');
  }));

  // 9. Missing counters object — treated as all-zero, seeds counters with since key
  test('update-reflection-state (missing counters object)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"last_reflection":"2026-04-01T00:00:00Z"}');
    const d = await updateState(dir,
      '{"ran_with_candidates":true,"micro_proposals_queued":1}');
    const c = d.counters;
    expect(c.total_runs).toBe(1);
    expect(c.micro_proposals_queued).toBe(1);
    expect(c.last_output_at).not.toBeNull();
    expect(c).toHaveProperty('since');
  }));

  // 10. Missing state file — fail-open: exits 0 and writes valid JSON
  test('update-reflection-state (missing state file, fail-open)', withDir(async (dir) => {
    const d = await updateState(dir, '{"ran_with_candidates":false}');
    expect(d.counters.total_runs).toBe(1);
  }));

  // 11. last_sparse_nudge — new entry is merged, existing entries preserved
  test('update-reflection-state (last_sparse_nudge merge)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"last_sparse_nudge":{"PROP-001":"2026-04-01T00:00:00Z"},"counters":{"total_runs":1}}');
    const d = await updateState(dir,
      '{"ran_with_candidates":false,"last_sparse_nudge":{"PROP-002":"2026-04-22T00:00:00Z"}}');
    expect(d.last_sparse_nudge['PROP-001']).toBe('2026-04-01T00:00:00Z');
    expect(d.last_sparse_nudge['PROP-002']).toBe('2026-04-22T00:00:00Z');
  }));

  // 11a. judge_suppress_by_code — first run initializes map and accumulates codes
  test('update-reflection-state (judge_suppress_by_code: initial accumulation)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'), '{"counters":{"total_runs":1}}');
    const d = await updateState(dir,
      '{"ran_with_candidates":true,"judge_suppress":2,"judge_suppress_by_code":{"no-evidence":1,"covered-by-memory":1}}');
    const m = d.counters.judge_suppress_by_code;
    expect(m['no-evidence']).toBe(1);
    expect(m['covered-by-memory']).toBe(1);
    expect(m).not.toHaveProperty('no-sessions');
  }));

  // 11b. judge_suppress_by_code — second run accumulates into existing counts
  test('update-reflection-state (judge_suppress_by_code: cumulative accumulation)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"counters":{"total_runs":2,"judge_suppress":2,"judge_suppress_by_code":{"no-evidence":1,"covered-by-memory":1}}}');
    const d = await updateState(dir,
      '{"ran_with_candidates":true,"judge_suppress":2,"judge_suppress_by_code":{"no-evidence":1,"no-sessions":1}}');
    const m = d.counters.judge_suppress_by_code;
    expect(m['no-evidence']).toBe(2);
    expect(m['covered-by-memory']).toBe(1);
    expect(m['no-sessions']).toBe(1);
  }));

  // 11c. judge_suppress_by_code — absent from payload leaves existing map unchanged
  test('update-reflection-state (judge_suppress_by_code: absent payload preserves map)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"counters":{"total_runs":3,"judge_suppress_by_code":{"no-evidence":5}}}');
    const d = await updateState(dir, '{"ran_with_candidates":false}');
    expect(d.counters.judge_suppress_by_code['no-evidence']).toBe(5);
  }));
});

// -------------------------------------------------------
// heartbeat-precheck.ts (subprocess — argv/stdout/state-mutation CLI contract)
// -------------------------------------------------------

const DEFAULT_CHECKLIST = '# Heartbeat\n- Review proposals/ for any needing attention\n';

function seedHeartbeat(dir: string, opts: {
  end?: string;
  alertState?: string;
  runtime?: string;
  micro?: string;
  checklist?: string | null; // null → no HEARTBEAT.md
} = {}) {
  write(hermit(dir, 'config.json'),
    `{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"${opts.end ?? '23:59'}"}}}`);
  write(hermit(dir, 'state', 'alert-state.json'),
    opts.alertState ?? '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}');
  write(hermit(dir, 'state', 'runtime.json'), opts.runtime ?? '{"session_state":"idle"}');
  write(hermit(dir, 'state', 'micro-proposals.json'), opts.micro ?? '{"pending":[]}');
  if (opts.checklist != null) write(hermit(dir, 'HEARTBEAT.md'), opts.checklist);
}

async function precheckOut(dir: string, peek = false): Promise<string> {
  const r = await runScript('heartbeat-precheck.ts', {
    args: peek ? ['--peek', hermit(dir)] : [hermit(dir)],
  });
  expect(r.exitCode).toBe(0);
  return r.stdout.trimEnd();
}

describe('heartbeat-precheck', () => {
  // 12. SKIP — HEARTBEAT.md missing
  test('heartbeat-precheck (SKIP: missing HEARTBEAT.md)', withDir(async (dir) => {
    seedHeartbeat(dir, { checklist: null });
    expect(await precheckOut(dir)).toMatch(/^SKIP\|/);
  }));

  // 13. SKIP — empty HEARTBEAT.md (no checklist items)
  test('heartbeat-precheck (SKIP: empty HEARTBEAT.md)', withDir(async (dir) => {
    seedHeartbeat(dir, { checklist: '# Heartbeat Checklist\n<!-- no items -->\n' });
    expect(await precheckOut(dir)).toMatch(/^SKIP\|/);
  }));

  // 14. SKIP — outside active hours (window 00:00–00:01, always past it)
  test('heartbeat-precheck (SKIP: outside active hours)', withDir(async (dir) => {
    seedHeartbeat(dir, { end: '00:01', checklist: '# Heartbeat\n- Check something\n' });
    expect(await precheckOut(dir)).toMatch(/^SKIP\|/);
  }));

  // 15. EVALUATE — no alert entry for checklist item
  test('heartbeat-precheck (EVALUATE: item not in alerts)', withDir(async (dir) => {
    seedHeartbeat(dir, { checklist: DEFAULT_CHECKLIST });
    expect(await precheckOut(dir)).toBe('EVALUATE');
  }));

  // 16. EVALUATE — pending tier-1 micro-proposal
  test('heartbeat-precheck (EVALUATE: tier-1 micro-proposal pending)', withDir(async (dir) => {
    seedHeartbeat(dir, {
      micro: '{"pending":[{"id":"MP-001","tier":1,"status":"pending","question":"Do X?"}]}',
      checklist: DEFAULT_CHECKLIST,
    });
    expect(await precheckOut(dir)).toBe('EVALUATE');
  }));

  // 17. EVALUATE — session in_progress
  test('heartbeat-precheck (EVALUATE: session in_progress)', withDir(async (dir) => {
    seedHeartbeat(dir, { runtime: '{"session_state":"in_progress"}', checklist: DEFAULT_CHECKLIST });
    expect(await precheckOut(dir)).toBe('EVALUATE');
  }));

  // 18. EVALUATE — self-eval due (tick 20)
  test('heartbeat-precheck (EVALUATE: self-eval due at tick 20)', withDir(async (dir) => {
    seedHeartbeat(dir, {
      alertState: '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":19}',
      checklist: DEFAULT_CHECKLIST,
    });
    expect(await precheckOut(dir)).toBe('EVALUATE');
  }));

  // 19. OK — all items suppressed and stable, structural checks clear
  test('heartbeat-precheck (OK: all items suppressed and stable)', withDir(async (dir) => {
    seedHeartbeat(dir, {
      alertState: `{"alerts":{"checklist:reviewpr":{"count":6,"suppressed":true,"consecutive_clean":0,"first_seen":"2026-04-01","last_seen":"2026-04-28","text":"Review proposals"}},"last_digest_date":"${utcDate(new Date())}","self_eval":{},"total_ticks":5}`,
      checklist: DEFAULT_CHECKLIST,
    });
    expect(await precheckOut(dir)).toBe('OK');
  }));

  // 20. total_ticks incremented exactly once; alerts{} and self_eval{} untouched by precheck
  describe('state mutation', () => {
    let wd: Workdir;
    let alertState: any;

    beforeAll(async () => {
      wd = setupWorkdir();
      seedHeartbeat(wd.dir, {
        alertState: `{"alerts":{"checklist:reviewpr":{"count":6,"suppressed":true,"consecutive_clean":0}},"last_digest_date":"${utcDate(new Date())}","self_eval":{"mykey":{"clean_ticks":5}},"total_ticks":3}`,
        checklist: DEFAULT_CHECKLIST,
      });
      await precheckOut(wd.dir);
      alertState = readJson(hermit(wd.dir, 'state', 'alert-state.json'));
    });
    afterAll(() => wd.cleanup());

    test('heartbeat-precheck (total_ticks incremented once)', () => {
      expect(alertState.total_ticks).toBe(4);
    });
    test('heartbeat-precheck (alerts{} not mutated by precheck)', () => {
      expect(alertState.alerts['checklist:reviewpr'].count).toBe(6);
    });
    test('heartbeat-precheck (self_eval{} not mutated by precheck)', () => {
      expect(alertState.self_eval.mykey.clean_ticks).toBe(5);
    });
  });

  // 20a. --peek returns verdict without mutating total_ticks
  describe('--peek (read-only mode)', () => {
    let wd: Workdir;
    let peekOut = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      seedHeartbeat(wd.dir, {
        alertState: '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":5}',
        checklist: null,
      });
      peekOut = await precheckOut(wd.dir, true);
    });
    afterAll(() => wd.cleanup());

    test('heartbeat-precheck --peek (returns verdict)', () => {
      expect(peekOut.length).toBeGreaterThan(0);
    });
    test('heartbeat-precheck --peek (total_ticks not mutated)', () => {
      expect(readJson(hermit(wd.dir, 'state', 'alert-state.json')).total_ticks).toBe(5);
    });
  });

  // 20a-2. --peek fires self-eval EVALUATE one tick early (at total_ticks=19)
  describe('--peek self-eval', () => {
    let wd: Workdir;
    let peekOut = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      seedHeartbeat(wd.dir, {
        alertState: '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":19}',
        checklist: DEFAULT_CHECKLIST,
      });
      peekOut = await precheckOut(wd.dir, true);
    });
    afterAll(() => wd.cleanup());

    test('heartbeat-precheck --peek (self-eval EVALUATE at tick 19)', () => {
      expect(peekOut).toBe('EVALUATE');
    });
    test('heartbeat-precheck --peek (self-eval: total_ticks still 19)', () => {
      expect(readJson(hermit(wd.dir, 'state', 'alert-state.json')).total_ticks).toBe(19);
    });
  });
});

// -------------------------------------------------------
// heartbeat-monitor.sh — real-script tests (HEARTBEAT_MONITOR_ONCE=1)
// -------------------------------------------------------

describe('heartbeat-monitor', () => {
  const MONITOR_SH = path.join(SCRIPTS_DIR, 'heartbeat-monitor.sh');

  function makeStub(body: string): { path: string; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-stub-'));
    const p = path.join(dir, 'stub.js');
    fs.writeFileSync(p, body);
    return { path: p, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
  }

  /** One monitor iteration with the precheck stubbed out; returns stdout and the temp hermit dir. */
  async function monitorOnce(stubBody: string): Promise<{ stdout: string; hbDir: string; cleanup(): void }> {
    const stub = makeStub(stubBody);
    const hbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-hermit-'));
    try {
      const r = await runBash(MONITOR_SH, {
        args: ['60', hbDir],
        env: { HEARTBEAT_MONITOR_ONCE: '1', HEARTBEAT_PRECHECK: stub.path },
      });
      return {
        stdout: r.stdout.trimEnd(),
        hbDir,
        cleanup: () => { try { fs.rmSync(hbDir, { recursive: true, force: true }); } catch {} },
      };
    } finally {
      stub.cleanup();
    }
  }

  // 20b. EVALUATE on iter-1 → silent (cold-start suppression)
  test('heartbeat-monitor (iter-1 EVALUATE → silent, cold-start suppressed)', async () => {
    const r = await monitorOnce('process.stdout.write("EVALUATE\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('');
  });

  // 20c. EVALUATE with suffix on iter-1 → silent (prefix match still suppressed)
  test('heartbeat-monitor (iter-1 EVALUATE|micro-pending → silent)', async () => {
    const r = await monitorOnce('process.stdout.write("EVALUATE|micro-pending\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('');
  });

  // 20d. AUTO_CLOSE → HEARTBEAT_EVALUATE
  test('heartbeat-monitor (AUTO_CLOSE → HEARTBEAT_EVALUATE)', async () => {
    const r = await monitorOnce('process.stdout.write("AUTO_CLOSE\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('HEARTBEAT_EVALUATE');
  });

  // 20e. OK → silent (no output)
  test('heartbeat-monitor (OK → silent)', async () => {
    const r = await monitorOnce('process.stdout.write("OK\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('');
  });

  // 20f. SKIP|outside-hours → silent
  test('heartbeat-monitor (SKIP|outside-hours → silent)', async () => {
    const r = await monitorOnce('process.stdout.write("SKIP|outside-hours\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('');
  });

  // 20g. precheck nonzero exit → HEARTBEAT_ERROR: precheck failed
  test('heartbeat-monitor (nonzero exit → HEARTBEAT_ERROR: precheck failed)', async () => {
    const r = await monitorOnce('process.stderr.write("crash\\n"); process.exit(1);\n');
    r.cleanup();
    expect(r.stdout).toContain('HEARTBEAT_ERROR: precheck failed');
  });

  // 20h. unknown verdict → HEARTBEAT_ERROR: unknown verdict
  test('heartbeat-monitor (unknown verdict → HEARTBEAT_ERROR: unknown verdict)', async () => {
    const r = await monitorOnce('process.stdout.write("WHATEVER\\n");\n');
    r.cleanup();
    expect(r.stdout).toContain('HEARTBEAT_ERROR: unknown verdict');
  });

  // 20j. liveness file written on every iteration
  test('heartbeat-monitor (liveness file written with fresh last_peek_at)', async () => {
    const before = Date.now();
    const r = await monitorOnce('process.stdout.write("OK\\n");\n');
    try {
      const livenessPath = path.join(r.hbDir, 'state', 'heartbeat-liveness.json');
      expect(fs.existsSync(livenessPath)).toBe(true);
      const liveness = JSON.parse(fs.readFileSync(livenessPath, 'utf-8'));
      expect(typeof liveness.last_peek_at).toBe('string');
      const t = new Date(liveness.last_peek_at).getTime();
      // date -u has 1s precision; allow up to 1s before `before`
      expect(t).toBeGreaterThanOrEqual(before - 1000);
      expect(t).toBeLessThanOrEqual(Date.now() + 5000);
    } finally {
      r.cleanup();
    }
  });

  // 20i. EVALUATE on iter-2 → HEARTBEAT_EVALUATE (suppression is first-iteration-only).
  // Runs without HEARTBEAT_MONITOR_ONCE so the loop can reach iter-2; bounded by timeout(1).
  test('heartbeat-monitor (iter-2 EVALUATE → HEARTBEAT_EVALUATE, suppression not permanent)', async () => {
    const stub = makeStub('process.stdout.write("EVALUATE\\n");\n');
    const hbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-hermit-'));
    try {
      const proc = Bun.spawn({
        cmd: ['timeout', '3', 'bash', MONITOR_SH, '1', hbDir],
        env: { ...process.env, HEARTBEAT_PRECHECK: stub.path },
        stdin: Buffer.from(''),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(stdout).toContain('HEARTBEAT_EVALUATE');
    } finally {
      stub.cleanup();
      try { fs.rmSync(hbDir, { recursive: true, force: true }); } catch {}
    }
  }, 10000);
});

// -------------------------------------------------------
// reflect-precheck.ts (subprocess — argv/stdout/state-mutation CLI contract)
// -------------------------------------------------------

const runReflectPrecheck = (dir: string, opts: { cwd?: string; env?: Record<string, string> } = {}) =>
  runScript('reflect-precheck.ts', { args: [hermit(dir), PLUGIN_ROOT], ...opts });

function seedReflect(dir: string, stateJson: object) {
  write(hermit(dir, 'config.json'), '{"timezone":"UTC"}');
  write(hermit(dir, 'state', 'runtime.json'), '{"session_state":"idle"}');
  fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  write(hermit(dir, 'state', 'reflection-state.json'), JSON.stringify(stateJson));
}

describe('reflect-precheck', () => {
  const since30 = () => isoSec(daysAgo(30));

  // 21. EMPTY — all timestamps recent, session idle, no accepted proposals
  test('reflect-precheck (EMPTY: no due phases)', withDir(async (dir) => {
    const today = isoSec(new Date());
    seedReflect(dir, {
      last_reflection: today, last_resolution_check: null, last_digest_at: today,
      counters: { total_runs: 5, empty_runs: 2, runs_with_candidates: 3, last_run_at: today, since: since30() },
    });
    // No cost log, no session reports newer than last_run_at
    const r = await runReflectPrecheck(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd()).toBe('EMPTY');
  }));

  // 22. EMPTY path: progress log line appended to SHELL.md
  test('reflect-precheck (EMPTY: progress log line written to SHELL.md)', withDir(async (dir) => {
    const today = isoSec(new Date());
    seedReflect(dir, {
      last_reflection: today,
      counters: { total_runs: 1, empty_runs: 0, last_run_at: today, since: since30() },
    });
    await runReflectPrecheck(dir);
    const shell = fs.readFileSync(hermit(dir, 'sessions', 'SHELL.md'), 'utf-8');
    expect(shell).toContain('reflect');
  }));

  // 23. EMPTY path: empty_runs incremented in reflection-state.json
  test('reflect-precheck (EMPTY: empty_runs incremented)', withDir(async (dir) => {
    const today = isoSec(new Date());
    seedReflect(dir, {
      counters: { total_runs: 3, empty_runs: 1, runs_with_candidates: 2, last_run_at: today, since: since30() },
    });
    await runReflectPrecheck(dir);
    const d = readJson(hermit(dir, 'state', 'reflection-state.json'));
    expect(d.counters.empty_runs).toBe(2);
    expect(d.counters.total_runs).toBe(4);
  }));

  // 24. RUN — resolution_check due (accepted proposal + last_resolution_check > 7 days)
  test('reflect-precheck (RUN: resolution_check due)', withDir(async (dir) => {
    const today = isoSec(new Date());
    seedReflect(dir, {
      counters: { total_runs: 5, empty_runs: 2, last_run_at: today, since: since30() },
      last_resolution_check: '2026-04-01T00:00:00Z',
    });
    write(hermit(dir, 'proposals', 'PROP-001.md'),
      '---\nstatus: accepted\naccepted_date: 2026-04-01\ntitle: Test\n---\nBody\n');
    const r = await runReflectPrecheck(dir);
    expect(r.stdout).toContain('resolution_check');
  }));

  // 24b. RUN — resolution_check due via new-format proposal filename (PROP-NNN-slug-HHMMSS.md)
  test('reflect-precheck (RUN: resolution_check due — new-format proposal filename)', withDir(async (dir) => {
    const today = isoSec(new Date());
    seedReflect(dir, {
      counters: { total_runs: 5, empty_runs: 2, last_run_at: today, since: since30() },
      last_resolution_check: '2026-04-01T00:00:00Z',
    });
    write(hermit(dir, 'proposals', 'PROP-002-test-new-format-103612.md'),
      '---\nid: PROP-002-test-new-format-103612\nstatus: accepted\naccepted_date: 2026-04-01\ntitle: Test new format\n---\nBody\n');
    const r = await runReflectPrecheck(dir);
    expect(r.stdout).toContain('resolution_check');
  }));

  // 25. RUN — compute activity (session report newer than last_run_at)
  test('reflect-precheck (RUN: compute activity detected)', withDir(async (dir) => {
    seedReflect(dir, {
      counters: { total_runs: 2, empty_runs: 1, last_run_at: '2026-01-01T00:00:00Z', since: since30() },
    });
    // Create a session report (mtime = now, which is after last_run_at)
    write(hermit(dir, 'sessions', 'S-001-REPORT.md'),
      '---\ntitle: Test\ncreated: 2026-04-29\n---\nBody\n');
    const r = await runReflectPrecheck(dir);
    expect(r.stdout).toContain('compute');
  }));

  // Local helper for #26-#29 — workdir with config/runtime/state/proposals scaffolding.
  function seedArchivePrecheck(dir: string, sessionState: string, inflate: boolean) {
    write(hermit(dir, 'config.json'), '{"timezone":"UTC"}');
    write(hermit(dir, 'state', 'runtime.json'),
      `{"session_state":"${sessionState}","last_shell_snapshot_at":null}`);
    fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
    write(hermit(dir, 'state', 'reflection-state.json'), JSON.stringify({
      counters: { total_runs: 5, empty_runs: 2, last_run_at: isoSec(new Date()), since: since30() },
    }));
    if (inflate) {
      let fixture = fs.readFileSync(path.join(fixturesDir, 'shell-session.md'), 'utf-8');
      if (!fixture.endsWith('\n')) fixture += '\n';
      const bulk = Array.from({ length: 450 }, (_, k) =>
        `- [10:${String((k + 1) % 60).padStart(2, '0')}] Bulk entry ${k + 1} — done`).join('\n');
      write(hermit(dir, 'sessions', 'SHELL.md'), fixture + bulk + '\n');
    }
  }

  const snapshotCount = (dir: string) => {
    try { return fs.readdirSync(hermit(dir, 'sessions', 'snapshots')).length; } catch { return 0; }
  };

  // 26. ARCHIVE-only path: SHELL.md > 400 lines, last_shell_snapshot_at null,
  //     no other phases due → precheck runs archive-shell.ts synchronously and
  //     emits EMPTY (no LLM reflect path).
  describe('ARCHIVE-only', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      seedArchivePrecheck(wd.dir, 'idle', true);
      const r = await runReflectPrecheck(wd.dir);
      out = r.stdout.trimEnd();
    });
    afterAll(() => wd.cleanup());

    test('reflect-precheck (ARCHIVE-only: emits EMPTY)', () => {
      expect(out).toBe('EMPTY');
    });
    test('reflect-precheck (ARCHIVE-only: snapshot file created)', () => {
      expect(snapshotCount(wd.dir)).toBeGreaterThanOrEqual(1);
    });
    test('reflect-precheck (ARCHIVE-only: last_shell_snapshot_at populated)', () => {
      expect(readJson(hermit(wd.dir, 'state', 'runtime.json')).last_shell_snapshot_at).not.toBeNull();
    });
    test('reflect-precheck (ARCHIVE-only: SHELL.md compacted, sections preserved)', () => {
      const shell = fs.readFileSync(hermit(wd.dir, 'sessions', 'SHELL.md'), 'utf-8');
      expect(shell).toMatch(/^## Task/m);
    });
  });

  // 27. ARCHIVE skipped when SHELL.md is small (no archive_due fires)
  test('reflect-precheck (small SHELL.md: no snapshot taken)', withDir(async (dir) => {
    seedArchivePrecheck(dir, 'idle', false);
    await runReflectPrecheck(dir);
    expect(snapshotCount(dir)).toBe(0);
  }));

  // 28. ARCHIVE + other phases due → RUN with archive_due in phases JSON
  //     (in_progress session forces compute=true; large SHELL forces archive_due)
  describe('ARCHIVE + other phases', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      seedArchivePrecheck(wd.dir, 'in_progress', true);
      const r = await runReflectPrecheck(wd.dir);
      out = r.stdout;
    });
    afterAll(() => wd.cleanup());

    test('reflect-precheck (ARCHIVE+other: emits RUN)', () => {
      expect(out).toMatch(/^RUN\|/m);
    });
    test('reflect-precheck (ARCHIVE+other: phases include compute)', () => {
      expect(out).toContain('"compute":true');
    });
    test('reflect-precheck (ARCHIVE+other: phases include archive_due)', () => {
      expect(out).toContain('"archive_due":true');
    });
    test('reflect-precheck (ARCHIVE+other: snapshot still taken)', () => {
      expect(snapshotCount(wd.dir)).toBe(1);
    });
  });

  // 29. ARCHIVE due but subprocess fails (snapshot already exists, EEXIST/concurrent)
  //     + other phases → archive_due omitted from phases JSON (gated on archiveTaken)
  describe('ARCHIVE failed', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      seedArchivePrecheck(wd.dir, 'in_progress', true);
      fs.mkdirSync(hermit(wd.dir, 'sessions', 'snapshots'), { recursive: true });
      // Pre-create the file linkSync would target (HERMIT_NOW pinned) → EEXIST.
      write(hermit(wd.dir, 'sessions', 'snapshots', 'SHELL-20260506-2200.md'), '');
      const r = await runReflectPrecheck(wd.dir, {
        cwd: wd.dir, env: { HERMIT_NOW: '2026-05-06T22:00:00Z' },
      });
      out = r.stdout;
    });
    afterAll(() => wd.cleanup());

    test('reflect-precheck (ARCHIVE failed: emits RUN)', () => {
      expect(out).toMatch(/^RUN\|/m);
    });
    test('reflect-precheck (ARCHIVE failed: compute still in phases)', () => {
      expect(out).toContain('"compute":true');
    });
    test('reflect-precheck (ARCHIVE failed: archive_due omitted)', () => {
      expect(out).not.toContain('archive_due');
    });
  });
});

// -------------------------------------------------------
// log-routine-event.sh — resolves hermit root by walking up from CWD
// -------------------------------------------------------

describe('log-routine-event', () => {
  const SCRIPT = path.join(SCRIPTS_DIR, 'log-routine-event.sh');

  describe('hermit root resolution', () => {
    let wd: Workdir;
    const metrics = () => hermit(wd.dir, 'state', 'routine-metrics.jsonl');

    beforeAll(() => {
      wd = setupWorkdir();
      fs.mkdirSync(path.join(wd.dir, 'app', 'sub'), { recursive: true });
    });
    afterAll(() => wd.cleanup());

    test('log-routine-event (subdir resolves to ancestor)', async () => {
      // Fired from a subdirectory → appends to the ancestor's state file
      await runBash(SCRIPT, { args: ['morning-brief', 'fired'], cwd: path.join(wd.dir, 'app', 'sub') });
      const content = fs.readFileSync(metrics(), 'utf-8');
      expect(content).toContain('"routine_id":"morning-brief","event":"fired"');
    });

    test('log-routine-event (root resolves to state file)', async () => {
      // Fired from the hermit root → unchanged behavior
      await runBash(SCRIPT, { args: ['weekly-review', 'skipped-waiting'], cwd: wd.dir });
      const content = fs.readFileSync(metrics(), 'utf-8');
      expect(content).toContain('"routine_id":"weekly-review","event":"skipped-waiting"');
    });
  });

  describe('no hermit ancestor', () => {
    // No .claude-code-hermit/ ancestor → non-zero exit with a clear diagnostic
    let exitCode = 0;
    let stderr = '';

    beforeAll(async () => {
      const nohermit = fs.mkdtempSync(path.join(os.tmpdir(), 'no-hermit-'));
      try {
        const r = await runBash(SCRIPT, { args: ['x', 'fired'], cwd: nohermit });
        exitCode = r.exitCode;
        stderr = r.stderr;
      } finally {
        try { fs.rmSync(nohermit, { recursive: true, force: true }); } catch {}
      }
    });

    test('log-routine-event (no ancestor exits non-zero)', () => {
      expect(exitCode).not.toBe(0);
    });
    test('log-routine-event (no ancestor diagnostic)', () => {
      expect(stderr).toContain('could not find .claude-code-hermit/');
    });
  });
});

// -------------------------------------------------------
// lib/cc-compat.js — CC-owned format accessors (in-process)
// -------------------------------------------------------

describe('cc-compat', () => {
  test('cc-compat.js: exports required symbols', () => {
    for (const k of ['sessionId', 'transcriptPath', 'sessionCrons', 'backgroundTasks',
      'extractUsage', 'costLogPath', 'ccVersion']) {
      expect(typeof (ccCompat as any)[k]).toBe('function');
    }
  });

  // sessionId: session_id preferred, sessionId fallback, absent → null
  test('cc-compat.js: sessionId reads session_id', () => {
    expect(sessionId({ session_id: 's1' })).toBe('s1');
  });
  test('cc-compat.js: sessionId falls back to sessionId', () => {
    expect(sessionId({ sessionId: 's2' })).toBe('s2');
  });
  test('cc-compat.js: sessionId absent → null', () => {
    expect(sessionId({})).toBeNull();
  });

  // transcriptPath: present → value, absent → null
  test('cc-compat.js: transcriptPath reads transcript_path', () => {
    expect(transcriptPath({ transcript_path: '/a' })).toBe('/a');
  });
  test('cc-compat.js: transcriptPath absent → null', () => {
    expect(transcriptPath({})).toBeNull();
  });

  // sessionCrons: tri-state — absent, empty, populated
  test('cc-compat.js: sessionCrons absent → unsupported_or_unreachable', () => {
    expect(sessionCrons({}).state).toBe('unsupported_or_unreachable');
  });
  test('cc-compat.js: sessionCrons empty array → empty count 0', () => {
    const r = sessionCrons({ session_crons: [] });
    expect(r.state).toBe('empty');
    expect(r.count).toBe(0);
  });
  test('cc-compat.js: sessionCrons non-empty → populated count', () => {
    const r = sessionCrons({ session_crons: [{}, {}] });
    expect(r.state).toBe('populated');
    expect(r.count).toBe(2);
  });

  // backgroundTasks: same tri-state
  test('cc-compat.js: backgroundTasks absent → unsupported_or_unreachable', () => {
    expect(backgroundTasks({}).state).toBe('unsupported_or_unreachable');
  });
  test('cc-compat.js: backgroundTasks empty → empty count 0', () => {
    const r = backgroundTasks({ background_tasks: [] });
    expect(r.state).toBe('empty');
    expect(r.count).toBe(0);
  });
  test('cc-compat.js: backgroundTasks populated → count 3', () => {
    const r = backgroundTasks({ background_tasks: [1, 2, 3] });
    expect(r.state).toBe('populated');
    expect(r.count).toBe(3);
  });

  // extractUsage: golden values
  test('cc-compat.js: extractUsage golden — assistant entry with usage', () => {
    const entry = {
      type: 'assistant',
      message: {
        usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 },
        model: 'claude-sonnet-4-x',
      },
    };
    const u = extractUsage(entry);
    expect(u).not.toBeNull();
    expect(u!.inputTokens).toBe(10);
    expect(u!.cacheWriteTokens).toBe(20);
    expect(u!.cacheReadTokens).toBe(30);
    expect(u!.outputTokens).toBe(40);
    expect(u!.model).toContain('sonnet');
  });
  test('cc-compat.js: extractUsage non-assistant entry → null', () => {
    expect(extractUsage({ type: 'user', message: { content: 'hi' } })).toBeNull();
  });
  test('cc-compat.js: extractUsage assistant without usage → null', () => {
    expect(extractUsage({ type: 'assistant', message: {} })).toBeNull();
  });

  // costLogPath: deterministic from a stateDir
  test('cc-compat.js: costLogPath resolves .claude/cost-log.jsonl', () => {
    const p = costLogPath('/project/.claude-code-hermit');
    expect(p.endsWith('/.claude/cost-log.jsonl')).toBe(true);
    expect(p).toContain('/project/');
  });

  // ccVersion: returns null when absent, no throw
  test('cc-compat.js: ccVersion absent → null (no throw)', () => {
    const v = ccVersion({});
    expect(v === null || typeof v === 'string').toBe(true);
  });
});

// -------------------------------------------------------
// lib/cost-log.js — incremental cost-log index (in-process)
// -------------------------------------------------------

describe('cost-log', () => {
  let wd: Workdir;
  let costIndexFile = '';
  let costLogFile = '';
  // Recent dates so by_date buckets survive the retention-window prune.
  const D1 = localDate(new Date());
  const D2 = localDate(daysAgo(1));

  beforeAll(() => {
    wd = setupWorkdir();
    costIndexFile = hermit(wd.dir, 'state', 'cost-index.json');
    costLogFile = path.join(wd.dir, '.claude', 'cost-log.jsonl');
    write(costLogFile, [
      `{"timestamp":"${D2}T10:00:00.000Z","session_id":"s1","source":"heartbeat","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":100000,"output_tokens":0,"total_tokens":100000,"estimated_cost_usd":0.03}`,
      `{"timestamp":"${D2}T10:01:00.000Z","session_id":"s1","source":"other","model":"sonnet","input_tokens":0,"cache_write_tokens":50000,"cache_read_tokens":0,"output_tokens":500,"total_tokens":50500,"estimated_cost_usd":0.195}`,
      `{"timestamp":"${D1}T10:00:00.000Z","session_id":"s2","source":"other","model":"haiku","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":200000,"output_tokens":2000,"total_tokens":202000,"estimated_cost_usd":0.024}`,
      '',
    ].join('\n'));
  });
  afterAll(() => wd.cleanup());

  test('cost-log.js: exports required symbols', () => {
    for (const k of ['costIndexPath', 'readCostIndex', 'updateCostIndex', 'rebuildCostIndex']) {
      expect(typeof (costLog as any)[k]).toBe('function');
    }
  });

  test('cost-log.js: costIndexPath resolves to state/cost-index.json', () => {
    const p = costIndexPath('/proj/.claude-code-hermit');
    expect(p.endsWith('/.claude-code-hermit/state/cost-index.json')).toBe(true);
  });

  test('cost-log.js: readCostIndex absent → null', () => {
    expect(readCostIndex('/tmp/no-such-index.json')).toBeNull();
  });

  test('cost-log.js: updateCostIndex computes correct totals', () => {
    const idx = updateCostIndex(costLogFile, costIndexFile);
    expect(idx.total_cost_usd).toBeCloseTo(0.03 + 0.195 + 0.024, 9);
    expect(idx.total_tokens).toBe(100000 + 50500 + 202000);
    expect(idx.total_sessions).toBe(2);
  });

  test('cost-log.js: by_date populated for both dates', () => {
    const idx = readCostIndex(costIndexFile)!;
    expect(idx.by_date[D2]).toBeTruthy();
    expect(idx.by_date[D1]).toBeTruthy();
    expect(idx.by_date[D2].session_ids.length).toBe(1);
  });

  // Old by_date buckets are pruned to the retention window; totals are not affected
  test('cost-log.js: old by_date buckets pruned, totals retained', () => {
    const pruneLog = path.join(wd.dir, '.claude', 'cost-log-prune.jsonl');
    const pruneIndex = hermit(wd.dir, 'state', 'cost-index-prune.json');
    write(pruneLog, [
      '{"timestamp":"2020-01-01T10:00:00.000Z","session_id":"old","source":"other","total_tokens":1000,"estimated_cost_usd":0.01}',
      `{"timestamp":"${D1}T10:00:00.000Z","session_id":"new","source":"other","total_tokens":2000,"estimated_cost_usd":0.02}`,
      '',
    ].join('\n'));
    const idx = updateCostIndex(pruneLog, pruneIndex);
    expect(idx.by_date['2020-01-01']).toBeFalsy();
    expect(idx.by_date[D1]).toBeTruthy();
    expect(idx.total_cost_usd).toBeCloseTo(0.03, 9);
    expect(idx.total_sessions).toBe(2);
  });

  test('cost-log.js: by_source buckets heartbeat vs other', () => {
    const idx = readCostIndex(costIndexFile)!;
    expect(idx.by_source.heartbeat).toBeTruthy();
    expect(idx.by_source.heartbeat.cost).toBeCloseTo(0.03, 9);
  });

  test('cost-log.js: byte_offset advances to file size', () => {
    const idx = readCostIndex(costIndexFile)!;
    expect(idx.byte_offset).toBe(fs.statSync(costLogFile).size);
  });

  // Second call with no new bytes is a no-op (offset stable, totals unchanged)
  test('cost-log.js: second updateCostIndex call is a no-op', () => {
    const before = readCostIndex(costIndexFile)!;
    const after = updateCostIndex(costLogFile, costIndexFile);
    expect(after.byte_offset).toBe(before.byte_offset);
    expect(after.total_cost_usd).toBe(before.total_cost_usd);
  });

  test('cost-log.js: corrupt line increments skipped_corrupt_lines', () => {
    const corruptLog = path.join(wd.dir, '.claude', 'cost-log-corrupt.jsonl');
    const corruptIndex = hermit(wd.dir, 'state', 'cost-index-corrupt.json');
    write(corruptLog, [
      '{"timestamp":"2026-01-01T10:00:00.000Z","session_id":"x","model":"sonnet","total_tokens":1000,"estimated_cost_usd":0.01}',
      'NOT VALID JSON AT ALL',
      '{"timestamp":"2026-01-01T10:01:00.000Z","session_id":"x","model":"sonnet","total_tokens":2000,"estimated_cost_usd":0.02}',
      '',
    ].join('\n'));
    const idx = updateCostIndex(corruptLog, corruptIndex);
    expect(idx.skipped_corrupt_lines).toBe(1);
    expect(idx.total_tokens).toBe(3000);
  });

  // Truncated log triggers rebuild (byte_offset > new fileSize)
  test('cost-log.js: truncated log triggers rebuild', () => {
    const corruptLog = path.join(wd.dir, '.claude', 'cost-log-corrupt.jsonl');
    const corruptIndex = hermit(wd.dir, 'state', 'cost-index-corrupt.json');
    // Manufacture a stale index (current schema) with a large offset → truncation rebuild
    const stale = {
      version: 2, byte_offset: 999999, total_cost_usd: 99, total_tokens: 99,
      total_sessions: 0, last_session_id: null, by_source: {}, by_date: {},
      skipped_corrupt_lines: 0, updated_at: '2020-01-01T00:00:00.000Z',
    };
    write(corruptIndex, JSON.stringify(stale) + '\n');
    const idx = updateCostIndex(corruptLog, corruptIndex);
    expect(idx.byte_offset).not.toBe(999999);
    expect(idx.total_cost_usd).toBeLessThanOrEqual(10);
  });

  // scanAutomatedOpus: counts only heartbeat/routine:* rows with model=opus
  // within the given date window. Used by cost-summary and doctor-check.
  describe('scanAutomatedOpus', () => {
    test('returns zero count when log absent', () => {
      const result = scanAutomatedOpus('/tmp/no-such-cost-log.jsonl', '2020-01-01');
      expect(result.count).toBe(0);
      expect(result.cost).toBe(0);
    });

    test('counts heartbeat+routine opus rows, excludes other/sonnet/haiku', withDir((dir) => {
      const logFile = path.join(dir, '.claude', 'cost-log.jsonl');
      const inWindow = localDate(new Date());        // today
      const outWindow = '2020-01-01';                // old date — outside window
      write(logFile, [
        // counted: automated + opus + in window
        `{"timestamp":"${inWindow}T10:00:00.000Z","source":"heartbeat","model":"opus","total_tokens":100,"estimated_cost_usd":5.00}`,
        `{"timestamp":"${inWindow}T11:00:00.000Z","source":"routine:daily-auto-close","model":"opus","total_tokens":50,"estimated_cost_usd":2.50}`,
        // excluded: not automated
        `{"timestamp":"${inWindow}T12:00:00.000Z","source":"other","model":"opus","total_tokens":50,"estimated_cost_usd":0.50}`,
        // excluded: wrong model
        `{"timestamp":"${inWindow}T13:00:00.000Z","source":"heartbeat","model":"sonnet","total_tokens":50,"estimated_cost_usd":0.10}`,
        `{"timestamp":"${inWindow}T14:00:00.000Z","source":"routine:reflect","model":"haiku","total_tokens":50,"estimated_cost_usd":0.01}`,
        // excluded: out of date window
        `{"timestamp":"${outWindow}T10:00:00.000Z","source":"heartbeat","model":"opus","total_tokens":100,"estimated_cost_usd":8.50}`,
        '',
      ].join('\n'));
      const result = scanAutomatedOpus(logFile, inWindow);
      expect(result.count).toBe(2);
      expect(result.cost).toBeCloseTo(7.50, 9);
    }));

    test('skips corrupt lines silently', withDir((dir) => {
      const logFile = path.join(dir, '.claude', 'cost-log.jsonl');
      const today = localDate(new Date());
      write(logFile, [
        `{"timestamp":"${today}T10:00:00.000Z","source":"heartbeat","model":"opus","estimated_cost_usd":3.00}`,
        'NOT VALID JSON',
        '',
      ].join('\n'));
      const result = scanAutomatedOpus(logFile, today);
      expect(result.count).toBe(1);
      expect(result.cost).toBeCloseTo(3.00, 9);
    }));
  });
});

// -------------------------------------------------------
// lib/pricing.js — shared pricing regression (in-process)
// Validates that extracting pricing into lib didn't change any output.
// Golden values computed from the original cost-tracker.ts constants.
// -------------------------------------------------------

describe('pricing', () => {
  test('pricing.js: exports PRICING, costByType, calculateCost', () => {
    for (const k of ['PRICING', 'costByType', 'calculateCost']) {
      expect((pricing as any)[k]).toBeDefined();
    }
  });

  test('pricing.js: calculateCost golden (sonnet 1M cache_read = $0.30)', () => {
    expect(calculateCost('sonnet', 0, 0, 1000000, 0)).toBeCloseTo(0.30, 9);
  });

  test('pricing.js: costByType sums equal calculateCost', () => {
    const t = costByType('opus', 100, 200, 300, 400);
    const s = t.input + t.cacheWrite + t.cacheRead + t.output;
    expect(Math.abs(s - calculateCost('opus', 100, 200, 300, 400))).toBeLessThan(1e-12);
  });

  test('pricing.js: unknown model falls back to sonnet', () => {
    expect(Math.abs(
      calculateCost('unknown-model', 0, 0, 1000000, 0) - calculateCost('sonnet', 0, 0, 1000000, 0),
    )).toBeLessThan(1e-12);
  });
});

// -------------------------------------------------------
// cost-reflect.ts (subprocess — CWD-relative cost-log read, stdout report)
// -------------------------------------------------------

async function runCostReflect(dir: string): Promise<string> {
  const r = await runScript('cost-reflect.ts', { args: ['.claude-code-hermit'], cwd: dir });
  return r.stdout + r.stderr;
}

describe('cost-reflect', () => {
  // Fixture log with known entries. Entry timestamps use a date definitely within
  // the 7-day window (today - 1 day). One entry is older than the window (today - 8 days).
  describe('window + sections', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      const inWindow = utcDate(daysAgo(1));
      const old = utcDate(daysAgo(8));
      write(path.join(wd.dir, '.claude', 'cost-log.jsonl'), [
        `{"timestamp":"${inWindow}T10:00:00.000Z","session_id":"sessionA1","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":100000,"output_tokens":0,"total_tokens":100000,"estimated_cost_usd":0.03}`,
        `{"timestamp":"${inWindow}T10:01:00.000Z","session_id":"sessionA1","model":"sonnet","input_tokens":0,"cache_write_tokens":50000,"cache_read_tokens":0,"output_tokens":500,"total_tokens":50500,"estimated_cost_usd":0.195}`,
        `{"timestamp":"${inWindow}T10:02:00.000Z","session_id":"sessionA1","model":"haiku","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":200000,"output_tokens":2000,"total_tokens":202000,"estimated_cost_usd":0.024}`,
        `{"timestamp":"${inWindow}T10:03:00.000Z","session_id":"sessionB2","model":"opus","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":0,"output_tokens":100000,"total_tokens":100000,"estimated_cost_usd":7.5}`,
        `{"timestamp":"${inWindow}T10:04:00.000Z","session_id":"sessionD4","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":20000,"output_tokens":1000,"total_tokens":21000,"estimated_cost_usd":0.021}`,
        `{"timestamp":"${old}T10:00:00.000Z","session_id":"session-OLD","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":999999,"output_tokens":0,"total_tokens":999999,"estimated_cost_usd":99.9999}`,
        'NOT_VALID_JSON', // malformed line to test resilience
        '',
      ].join('\n'));
      out = await runCostReflect(wd.dir);
    });
    afterAll(() => wd.cleanup());

    // Basic: exits cleanly and produces output
    test('cost-reflect: produces output', () => {
      expect(out.length).toBeGreaterThan(0);
    });

    // Grand total = sum of 5 in-window entries (session-OLD and malformed line excluded)
    // Recomputed from tokens (not estimated_cost_usd): 0.03 + 0.195 + 0.024 + 7.5 + 0.021 = 7.77
    test('cost-reflect: total includes all 5 in-window entries', () => {
      expect(out).toMatch(/7\.7[0-9]/);
    });

    // Pre-window entry excluded (session-OLD would contribute $99 if included)
    test('cost-reflect: pre-window entry excluded', () => {
      expect(out).not.toMatch(/99\./);
      expect(out).not.toContain('session-OLD');
    });

    // Malformed line skipped, output still produced
    test('cost-reflect: malformed line skipped', () => {
      expect(out).toContain('$');
    });

    // Cold-start: section appears AND the content shows exactly 1 turn
    // (entry 2 matches heuristic; entry 5 has cw=0 so it is NOT a cold-start)
    test('cost-reflect: cold-start section present', () => {
      expect(out).toContain('Cold starts');
    });
    test('cost-reflect: 1 cold-start turn detected', () => {
      expect(out).toMatch(/1 turn.*cache-write/);
    });

    // sessionB2 is the most expensive (opus, $7.5 output) → first line under Top sessions
    test('cost-reflect: sessionB (opus output) is top session', () => {
      const lines = out.split('\n');
      const i = lines.findIndex((l) => l.includes('Top sessions'));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(lines[i] + '\n' + (lines[i + 1] ?? '')).toContain('sessionB');
    });

    // sessionD4: sonnet, cache_read=20K tokens vs output=1K tokens — by token count
    // cache_read>output, but by sub-cost output ($0.015) > cache_read ($0.006) →
    // dominant must be 'output', not 'cache_read'. Targets only the sessionD line.
    test('cost-reflect: dominant type by sub-cost not token volume', () => {
      const dLines = out.split('\n').filter((l) => l.includes('sessionD'));
      expect(dLines.join('\n')).toMatch(/output/i);
    });

    // Output respects ≤1500 char cap
    test('cost-reflect: output ≤1500 chars', () => {
      expect(out.length).toBeLessThanOrEqual(1500);
    });
  });

  // Empty log: no entries at all
  test("cost-reflect: empty log → 'No cost data'", withDir(async (dir) => {
    write(path.join(dir, '.claude', 'cost-log.jsonl'), '\n');
    expect(await runCostReflect(dir)).toMatch(/no cost data/i);
  }));

  // Missing log: .claude/cost-log.jsonl does not exist
  test("cost-reflect: missing log → 'No cost data' (exit 0)", withDir(async (dir) => {
    const r = await runScript('cost-reflect.ts', { args: ['.claude-code-hermit'], cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/no cost data/i);
  }));
});

// -------------------------------------------------------
// cost-tracker: classifySource / scanTriggerMarkers unit tests (in-process)
// -------------------------------------------------------

describe('cost-tracker classifySource / scanTriggerMarkers', () => {
  // cost-tracker.ts freezes CWD-relative state paths at import time (see the
  // chdir-guarded import in hooks.contract.test.ts). classifySource and
  // scanTriggerMarkers are pure and never touch those paths, but a plain
  // import here would populate the shared module cache before
  // hooks.contract.test.ts's workdir-pinned import runs (bun executes this
  // file first in a combined run), breaking its getCumulativeCost tests. The
  // query-string specifier forces a separate module instance so the two test
  // files never share cost-tracker state.
  let classifySource: typeof import('../scripts/cost-tracker').classifySource;
  let scanTriggerMarkers: typeof import('../scripts/cost-tracker').scanTriggerMarkers;

  beforeAll(async () => {
    const mod = (await import(
      '../scripts/cost-tracker' + '?scripts-test-pure-fns' // concat keeps tsc from resolving the query path
    )) as typeof import('../scripts/cost-tracker');
    ({ classifySource, scanTriggerMarkers } = mod);
  });

  test('cost-tracker: exports classifySource and scanTriggerMarkers', () => {
    expect(typeof classifySource).toBe('function');
    expect(typeof scanTriggerMarkers).toBe('function');
  });

  // classifySource: heartbeat marker
  test('cost-tracker: classifySource(HEARTBEAT_EVALUATE) = heartbeat', () => {
    expect(classifySource('some prefix HEARTBEAT_EVALUATE rest')).toBe('heartbeat');
  });
  test('cost-tracker: classifySource(heartbeat run) = heartbeat', () => {
    expect(classifySource('/claude-code-hermit:heartbeat run')).toBe('heartbeat');
  });

  // classifySource: routine marker
  test('cost-tracker: classifySource([hermit-routine:daily]) = routine:daily', () => {
    expect(classifySource('[hermit-routine:daily]')).toBe('routine:daily');
  });
  test('cost-tracker: classifySource([hermit-routine:cortex-refresh]) = routine:cortex-refresh', () => {
    expect(classifySource('text [hermit-routine:cortex-refresh] more text')).toBe('routine:cortex-refresh');
  });

  // classifySource: no marker → other
  test('cost-tracker: classifySource(no marker) = other', () => {
    expect(classifySource('just a normal operator message')).toBe('other');
  });
  test('cost-tracker: classifySource(empty) = other', () => {
    expect(classifySource('')).toBe('other');
  });

  // classifySource: skill-template noise must NOT match (false-positive guard)
  // These strings appear as tool_result content when routines register
  test('cost-tracker: classifySource rejects [hermit-routine:*] (template glob)', () => {
    expect(classifySource('[hermit-routine:*]')).toBe('other');
  });
  test('cost-tracker: classifySource rejects [hermit-routine:<id>] (template placeholder)', () => {
    expect(classifySource('[hermit-routine:<id>]')).toBe('other');
  });

  // classifySource: unsanitized id with disallowed chars yields other (not a partial match)
  test('cost-tracker: classifySource rejects id with pipe/newline', () => {
    expect(classifySource('[hermit-routine:foo|bar]')).toBe('other');
  });

  // classifySource: id length-capped at 64 chars
  test('cost-tracker: classifySource caps id at 64 chars', () => {
    const r = classifySource(`[hermit-routine:${'a'.repeat(80)}]`);
    expect(r.startsWith('routine:')).toBe(true);
    expect(r.slice('routine:'.length).length).toBe(64);
  });

  // scanTriggerMarkers: backward scan finds routine marker past tool_result boundary
  // Simulates: human([hermit-routine:daily]) → assistant(tool_use) → user(tool_result) → assistant(usage)
  // The billed entry is the last assistant; scanTriggerMarkers should find the human entry's marker.
  test('cost-tracker: scanTriggerMarkers finds routine past tool_result', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:daily] Read runtime.json. Invoke /reflect.' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    expect(scanTriggerMarkers(lines, 3)).toContain('[hermit-routine:daily]');
  });

  // scanTriggerMarkers: turn-boundary stops at prior billed assistant
  // Ensures a routine from a PREVIOUS turn can't bleed into the current turn's source
  test('cost-tracker: scanTriggerMarkers respects turn boundary', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:old-routine] prior turn' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 50, output_tokens: 20 } } }),
      JSON.stringify({ type: 'user', message: { content: 'operator message with no marker' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    expect(scanTriggerMarkers(lines, 3)).not.toContain('[hermit-routine:old-routine]');
  });

  // scanTriggerMarkers: reaches the marker past an intermediate tool-calling assistant
  // that ITSELF carries usage — the realistic transcript shape (every API round-trip is
  // billed). The scan must skip it and stop at the triggering user prompt, not truncate early.
  test('cost-tracker: scanTriggerMarkers passes intermediate billed assistant', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:reflect] Invoke /reflect.' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 80, output_tokens: 30 }, content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: 'done' }] } }),
    ];
    const text = scanTriggerMarkers(lines, 3);
    expect(text).toContain('[hermit-routine:reflect]');
    expect(classifySource(text)).toBe('routine:reflect');
  });
});

// -------------------------------------------------------
// cost-tracker: sumTurnUsage unit tests (in-process)
// -------------------------------------------------------

describe('cost-tracker sumTurnUsage', () => {
  let sumTurnUsage: typeof import('../scripts/cost-tracker').sumTurnUsage;

  beforeAll(async () => {
    const mod = (await import(
      '../scripts/cost-tracker' + '?scripts-test-sumTurnUsage'
    )) as typeof import('../scripts/cost-tracker');
    ({ sumTurnUsage } = mod);
  });

  test('cost-tracker: sumTurnUsage exported', () => {
    expect(typeof sumTurnUsage).toBe('function');
  });

  // Single-call turn — baseline: result equals what the old code returned
  test('cost-tracker: sumTurnUsage single billed entry', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, model: 'claude-sonnet-4-6' } }),
    ];
    const r = sumTurnUsage(lines, 1);
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(50);
    expect(r.apiCalls).toBe(1);
    expect(r.model).toBe('claude-sonnet-4-6');
  });

  // Three-call turn — the core undercount fix
  test('cost-tracker: sumTurnUsage sums three billed entries in one turn', () => {
    const lines = [
      // Prior turn (must NOT be included)
      JSON.stringify({ type: 'user', message: { content: 'prior turn prompt' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 999, output_tokens: 999 } } }),
      // Current turn
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:reflect] go' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 200, output_tokens: 20 }, content: [{ type: 'tool_use', id: 't2', name: 'Write', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't2', type: 'tool_result', content: 'written' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 150 }, model: 'claude-sonnet-4-6' } }),
    ];
    const billedIndex = lines.length - 1; // last assistant entry
    const r = sumTurnUsage(lines, billedIndex);
    expect(r.apiCalls).toBe(3);
    expect(r.inputTokens).toBe(100 + 200 + 300);
    expect(r.outputTokens).toBe(10 + 20 + 30);
    expect(r.cacheReadTokens).toBe(150);
    // Prior turn's 999 tokens must not bleed in
    expect(r.inputTokens).not.toBeGreaterThanOrEqual(999);
  });

  // Boundary respected: prior turn's billed entries are excluded
  test('cost-tracker: sumTurnUsage stops at turn boundary (prior-turn tokens excluded)', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'turn 1 prompt' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 500, output_tokens: 500 } } }),
      JSON.stringify({ type: 'user', message: { content: 'turn 2 prompt' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } }),
    ];
    const r = sumTurnUsage(lines, 3);
    expect(r.apiCalls).toBe(1);
    expect(r.inputTokens).toBe(10);
  });
});

// -------------------------------------------------------
// cost-reflect.ts: source attribution tests (subprocess)
// -------------------------------------------------------

describe('cost-reflect source attribution', () => {
  // Fixture log with known source values + legacy untagged entries
  describe('tagged sources', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      const d = utcDate(daysAgo(1));
      write(path.join(wd.dir, '.claude', 'cost-log.jsonl'), [
        `{"timestamp":"${d}T10:00:00.000Z","session_id":"s1","source":"heartbeat","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":100000,"output_tokens":0,"total_tokens":100000,"estimated_cost_usd":0.03}`,
        `{"timestamp":"${d}T10:01:00.000Z","session_id":"s2","source":"routine:reflect","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":100000,"output_tokens":2000,"total_tokens":102000,"estimated_cost_usd":0.06}`,
        `{"timestamp":"${d}T10:02:00.000Z","session_id":"s3","source":"other","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":50000,"output_tokens":5000,"total_tokens":55000,"estimated_cost_usd":0.09}`,
        `{"timestamp":"${d}T10:03:00.000Z","session_id":"s4","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":50000,"output_tokens":1000,"total_tokens":51000,"estimated_cost_usd":0.021}`,
        '',
      ].join('\n'));
      out = await runCostReflect(wd.dir);
    });
    afterAll(() => wd.cleanup());

    test('cost-reflect: Cost by source section present', () => {
      expect(out).toContain('Cost by source');
    });
    test('cost-reflect: heartbeat source row present', () => {
      expect(out).toContain('heartbeat');
    });
    test('cost-reflect: routine:reflect source row present', () => {
      expect(out).toContain('routine:reflect');
    });
    test('cost-reflect: other (non-scheduled) label present', () => {
      expect(out).toContain('non-scheduled');
    });
    test('cost-reflect: legacy entry (no source) bucketed to other', () => {
      expect(out).toContain('other');
    });
    test('cost-reflect: routine row triggers subagent footnote', () => {
      expect(out).toMatch(/subagent/i);
    });
    test('cost-reflect (source fixture): output ≤1500 chars', () => {
      expect(out.length).toBeLessThanOrEqual(1500);
    });
  });

  // No-routine fixture: footnote must be absent when no routine row is displayed (no dangling note)
  describe('no routine row', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      const d = utcDate(daysAgo(1));
      write(path.join(wd.dir, '.claude', 'cost-log.jsonl'), [
        `{"timestamp":"${d}T10:00:00.000Z","session_id":"s1","source":"heartbeat","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":100000,"output_tokens":0,"total_tokens":100000,"estimated_cost_usd":0.03}`,
        `{"timestamp":"${d}T10:02:00.000Z","session_id":"s3","source":"other","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":50000,"output_tokens":5000,"total_tokens":55000,"estimated_cost_usd":0.09}`,
        '',
      ].join('\n'));
      out = await runCostReflect(wd.dir);
    });
    afterAll(() => wd.cleanup());

    test('cost-reflect: no routine row → source section still present', () => {
      expect(out).toContain('Cost by source');
    });
    test('cost-reflect: no routine row → no subagent footnote', () => {
      expect(out).not.toMatch(/subagent/i);
    });
  });

  // ~20-source cap fixture: verify ≤1500 chars with many distinct routine sources
  describe('many sources cap', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      const d = utcDate(daysAgo(1));
      const lines = Array.from({ length: 20 }, (_, k) => {
        const i = k + 1;
        return `{"timestamp":"${d}T10:${String(i).padStart(2, '0')}:00.000Z","session_id":"s${i}","source":"routine:routine-${i}","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":10000,"output_tokens":500,"total_tokens":10500,"estimated_cost_usd":0.01}`;
      });
      write(path.join(wd.dir, '.claude', 'cost-log.jsonl'), lines.join('\n') + '\n');
      out = await runCostReflect(wd.dir);
    });
    afterAll(() => wd.cleanup());

    test('cost-reflect: 20-source fixture produces output', () => {
      expect(out.length).toBeGreaterThan(0);
    });
    test('cost-reflect: 20-source fixture ≤1500 chars', () => {
      expect(out.length).toBeLessThanOrEqual(1500);
    });
    test('cost-reflect: 20-source fixture shows +N more sources line', () => {
      expect(out).toContain('more sources');
    });
  });
});

// -------------------------------------------------------
// search.ts (subprocess CLI) / lib/search.ts (in-process)
// -------------------------------------------------------

describe('search', () => {
  const runSearch = async (dir: string, query: string) => {
    const r = await runScript('search.ts', { args: [hermit(dir), query] });
    expect(r.exitCode).toBe(0);
    return r.stdout + r.stderr;
  };

  // search: basic match — finds a compiled artifact by keyword, returns file:line snippet
  describe('basic match', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      const dir = wd.dir;
      fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
      fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
      write(hermit(dir, 'config.json'), '{}');
      write(hermit(dir, 'compiled', 'review-heartbeat-2026-05-01.md'),
        '---\ntitle: Heartbeat design\ntype: review\ncreated: 2026-05-01T00:00:00+00:00\n---\nThe zero-token heartbeat is the best idea in the repo.');
      write(hermit(dir, 'compiled', 'briefing-2026-05-10.md'),
        '---\ntitle: Weekly summary\ntype: briefing\ncreated: 2026-05-10T00:00:00+00:00\n---\nNo relevant content here about the search term.');
      out = await runSearch(dir, 'heartbeat');
    });
    afterAll(() => wd.cleanup());

    test('search (finds compiled artifact by keyword)', () => {
      expect(out).toContain('review-heartbeat-2026-05-01');
    });
    test('search (irrelevant file excluded)', () => {
      expect(out).not.toContain('briefing-2026-05-10');
    });
    test('search (returns file:line snippet)', () => {
      expect(out).toContain(':');
    });
  });

  // search: topic page result date reflects `updated`, not `created`
  test('search (updated wins over created for result date)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    write(hermit(dir, 'compiled', 'topic-rota.md'),
      '---\ntitle: Support rota\ntype: topic\ncreated: 2024-01-01T00:00:00+00:00\nupdated: 2026-06-05T00:00:00+00:00\n---\nThe on-call rota rotates weekly.');
    const out = await runSearch(dir, 'rota');
    expect(out).toContain('topic-rota');
    expect(out).toContain('2026-06-05');
    expect(out).not.toContain('2024-01-01');
  }));

  // search: session and proposal scope — finds hits across directories
  describe('session and proposal scope', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      const dir = wd.dir;
      fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
      fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
      write(hermit(dir, 'config.json'), '{}');
      write(hermit(dir, 'sessions', 'S-001-REPORT.md'),
        '---\nid: S-001\ndate: 2026-05-01T00:00:00+00:00\ntask: Set up deployment pipeline\n---\n## Completed\n- Configured deployment pipeline for staging.');
      write(hermit(dir, 'proposals', 'PROP-001-deploy-check-120000.md'),
        '---\nid: PROP-001\ntitle: Add deployment health check\nstatus: proposed\ndate: 2026-05-02T00:00:00+00:00\n---\nProposal: add a deployment health check.\n');
      out = await runSearch(dir, 'deployment');
    });
    afterAll(() => wd.cleanup());

    test('search (finds session report)', () => {
      expect(out).toContain('S-001-REPORT');
    });
    test('search (finds proposal)', () => {
      expect(out).toContain('PROP-001');
    });
  });

  // search: title-hit outranks body-only hit
  test('search (title hit ranks first)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    write(hermit(dir, 'compiled', 'review-memory-2026-05-10.md'),
      '---\ntitle: Memory architecture review\ntype: review\ncreated: 2026-05-10T00:00:00+00:00\n---\nSome other content.');
    write(hermit(dir, 'compiled', 'briefing-2026-05-11.md'),
      '---\ntitle: Unrelated briefing\ntype: briefing\ncreated: 2026-05-11T00:00:00+00:00\n---\nThis file mentions memory in the body once.');
    const out = await runSearch(dir, 'memory');
    // First line mentioning review-memory must be within the first 3 output lines.
    const idx = out.split('\n').findIndex((l) => l.includes('review-memory'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(3);
  }));

  // search: no results case
  test('search (no results)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    write(hermit(dir, 'compiled', 'review-some-2026-05-01.md'),
      '---\ntitle: Some artifact\ntype: review\ncreated: 2026-05-01T00:00:00+00:00\n---\nSome content.');
    const out = await runSearch(dir, 'zzznomatch');
    expect(out).toContain('No results found');
  }));

  // search: snippet :line matches the real file line (frontmatter offset included)
  // 5-line frontmatter (---/title/type/created/---) then body; "zebra" lands on file line 8.
  test('search (:line matches real file line, frontmatter offset)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    write(hermit(dir, 'compiled', 'review-offset-2026-05-01.md'),
      '---\ntitle: Offset check\ntype: review\ncreated: 2026-05-01T00:00:00+00:00\n---\nalpha\nbeta\nthe keyword zebra lives here\ngamma');
    const out = await runSearch(dir, 'zebra');
    expect(out).toContain(':8  the keyword zebra lives here');
  }));

  // lib/search.ts: TF+frontmatter boost verified in-process
  test('lib/search: title hit outranks body-only hit (unit)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-'));
    try {
      const dir = path.join(tmp, '.claude-code-hermit');
      const comp = path.join(dir, 'compiled');
      fs.mkdirSync(comp, { recursive: true });
      write(path.join(comp, 'review-a.md'),
        '---\ntitle: deployment pipeline\ntype: review\ncreated: 2026-05-10T00:00:00+00:00\n---\nUnrelated body.');
      write(path.join(comp, 'briefing-b.md'),
        '---\ntitle: weekly update\ntype: briefing\ncreated: 2026-05-11T00:00:00+00:00\n---\nMentions deployment in the body here.');
      const results = search(dir, 'deployment');
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].relPath).toContain('review-a');
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});

// -------------------------------------------------------
// proposal-metrics-report.ts (subprocess — argv/stdout CLI contract)
// -------------------------------------------------------

describe('proposal-metrics-report', () => {
  const runReport = async (dir: string, ...extra: string[]) => {
    const r = await runScript('proposal-metrics-report.ts', { args: [hermit(dir), ...extra] });
    expect(r.exitCode).toBe(0);
    return r.stdout + r.stderr;
  };
  const metricsFile = (dir: string) => hermit(dir, 'state', 'proposal-metrics.jsonl');

  // Missing / empty file — fails open
  test('proposal-metrics-report (missing file exits 0)', withDir(async (dir) => {
    expect(await runReport(dir)).toContain('No proposal metrics');
  }));

  test('proposal-metrics-report (empty file exits 0)', withDir(async (dir) => {
    write(metricsFile(dir), '');
    expect(await runReport(dir)).toContain('No proposal metrics');
  }));

  // Insufficient sample (<8) — INSUFFICIENT output
  test('proposal-metrics-report --source (INSUFFICIENT, n<8)', withDir(async (dir) => {
    // 3 triage-verdicts from brainstorm + 2 created tagged brainstorm, 1 accepted
    write(metricsFile(dir), [
      '{"ts":"2026-01-01T00:00:00Z","type":"triage-verdict","verdict":"CREATE","caller":"proposal-create","evidence_source":"capability-brainstorm","tags":["capability-brainstorm"]}',
      '{"ts":"2026-01-01T00:01:00Z","type":"triage-verdict","verdict":"SUPPRESS","caller":"proposal-create","evidence_source":"capability-brainstorm","tags":["capability-brainstorm"]}',
      '{"ts":"2026-01-01T00:02:00Z","type":"triage-verdict","verdict":"SUPPRESS","caller":"proposal-create","evidence_source":"capability-brainstorm","tags":["capability-brainstorm"]}',
      '{"ts":"2026-01-01T01:00:00Z","type":"created","proposal_id":"PROP-001","source":"auto-detected","category":"capability","tags":["capability-brainstorm"]}',
      '{"ts":"2026-01-01T02:00:00Z","type":"created","proposal_id":"PROP-002","source":"auto-detected","category":"capability","tags":["capability-brainstorm"]}',
      '{"ts":"2026-01-01T03:00:00Z","type":"responded","proposal_id":"PROP-001","action":"accept"}',
      '',
    ].join('\n'));
    expect(await runReport(dir, '--source=capability-brainstorm')).toContain('INSUFFICIENT');
  }));

  // Full sample (>=8) — correct rates and kill verdict
  // 10 triage-verdicts: 4 CREATE, 6 SUPPRESS → survival 40%
  // 4 created tagged, 1 accepted → acceptance 25% → KILL (acceptance < 30%)
  describe('full sample', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      const lines: string[] = [];
      for (let i = 1; i <= 4; i++) {
        lines.push(`{"ts":"2026-01-01T00:0${i}Z","type":"triage-verdict","verdict":"CREATE","caller":"proposal-create","evidence_source":"capability-brainstorm","tags":["capability-brainstorm"]}`);
      }
      for (let i = 5; i <= 10; i++) {
        lines.push(`{"ts":"2026-01-01T00:0${i}Z","type":"triage-verdict","verdict":"SUPPRESS","caller":"proposal-create","evidence_source":"capability-brainstorm","tags":["capability-brainstorm"]}`);
      }
      for (let i = 1; i <= 4; i++) {
        lines.push(`{"ts":"2026-01-01T01:0${i}Z","type":"created","proposal_id":"PROP-00${i}","source":"auto-detected","category":"capability","tags":["capability-brainstorm"]}`);
      }
      lines.push('{"ts":"2026-01-01T02:00:00Z","type":"responded","proposal_id":"PROP-001","action":"accept"}');
      write(metricsFile(wd.dir), lines.join('\n') + '\n');
      const r = await runScript('proposal-metrics-report.ts', {
        args: [hermit(wd.dir), '--source=capability-brainstorm'],
      });
      out = r.stdout + r.stderr;
    });
    afterAll(() => wd.cleanup());

    test('proposal-metrics-report --source (survival 40%)', () => {
      expect(out).toContain('triage-survival 40%');
    });
    test('proposal-metrics-report --source (acceptance 25%)', () => {
      expect(out).toContain('acceptance 25%');
    });
    test('proposal-metrics-report --source (KILL verdict)', () => {
      expect(out).toContain('KILL');
    });
  });

  // Default table mode — all segments appear, known rate in table
  describe('table mode', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      write(metricsFile(wd.dir), [
        '{"ts":"2026-01-01T00:01:00Z","type":"triage-verdict","verdict":"CREATE","caller":"reflect"}',
        '{"ts":"2026-01-01T00:02:00Z","type":"triage-verdict","verdict":"SUPPRESS","caller":"reflect"}',
        '{"ts":"2026-01-01T01:00:00Z","type":"created","proposal_id":"PROP-R1","source":"auto-detected","category":"improvement","tags":[]}',
        '{"ts":"2026-01-01T02:00:00Z","type":"responded","proposal_id":"PROP-R1","action":"accept"}',
        '',
      ].join('\n'));
      const r = await runScript('proposal-metrics-report.ts', { args: [hermit(wd.dir)] });
      out = r.stdout + r.stderr;
    });
    afterAll(() => wd.cleanup());

    test('proposal-metrics-report table (header present)', () => {
      expect(out).toContain('Proposal acceptance by source');
    });
    test('proposal-metrics-report table (reflect row present)', () => {
      expect(out).toContain('| reflect |');
    });
    test('proposal-metrics-report table (capability-brainstorm row present)', () => {
      expect(out).toContain('| capability-brainstorm |');
    });
  });

  // Malformed line is skipped; valid events still counted
  test('proposal-metrics-report (malformed line skipped)', withDir(async (dir) => {
    write(metricsFile(dir), [
      'this is not json at all',
      '{"ts":"2026-01-01T00:01:00Z","type":"triage-verdict","verdict":"CREATE","caller":"reflect"}',
      '',
    ].join('\n'));
    expect(await runReport(dir)).toContain('Proposal acceptance');
  }));

  // --source with unknown key reports error gracefully
  test('proposal-metrics-report (unknown --source key)', withDir(async (dir) => {
    write(metricsFile(dir),
      '{"ts":"2026-01-01T00:01:00Z","type":"triage-verdict","verdict":"CREATE","caller":"reflect"}\n');
    expect(await runReport(dir, '--source=nonexistent')).toContain('Unknown source key');
  }));
});

// -------------------------------------------------------
// weekly-review.ts (subprocess — argv/file-write CLI contract)
// -------------------------------------------------------

describe('weekly-review', () => {
  const runWeeklyReview = (dir: string) =>
    runScript('weekly-review.ts', { args: [hermit(dir)] });

  function seedWeeklyReview(dir: string) {
    // Minimal hermit layout weekly-review.ts needs to not crash
    fs.mkdirSync(hermit(dir, 'sessions'), { recursive: true });
    fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
    fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  }

  // weekly-review: observations.jsonl entries surface in ### Reflect
  test('weekly-review (observations.jsonl count in Reflect line)', withDir(async (dir) => {
    seedWeeklyReview(dir);
    // Session report requires id + date (weekly-review filters on fm.id && fm.date)
    const now = new Date();
    const dateStr = utcDate(now);
    const hhmm = now.toISOString().slice(11, 16);
    write(hermit(dir, 'sessions', 'S-001-REPORT.md'), [
      '---',
      'id: S-001',
      'type: report',
      `date: ${dateStr}`,
      'operator_turns: 0',
      '---',
      '## Progress Log',
      `- [${hhmm}] reflect (adult) — 1 candidates; verdicts: accept=1 downgrade=0 suppress=0; outcomes: none`,
    ].join('\n'));
    // Seed 2 observations entries timestamped in the current week
    const ts = now.toISOString();
    write(hermit(dir, 'state', 'observations.jsonl'), [
      JSON.stringify({ ts, pattern: 'p1', session_id: 'S-000', source: 'reflect' }),
      JSON.stringify({ ts, pattern: 'p2', session_id: 'S-001', source: 'reflect' }),
      '',
    ].join('\n'));
    const r = await runWeeklyReview(dir);
    expect(r.exitCode).toBe(0);
    // Report written to compiled/
    const compiledDir = hermit(dir, 'compiled');
    const files = fs.readdirSync(compiledDir);
    const reportFile = files.find(f => f.startsWith('review-weekly-'));
    expect(reportFile).toBeTruthy();
    const content = fs.readFileSync(path.join(compiledDir, reportFile!), 'utf-8');
    // Frontmatter counter
    expect(content).toContain('reflect_observations: 2');
    // Body line: obs count + this-week increment
    expect(content).toContain('obs: 2 ledger (+2 this week)');
  }));

  // weekly-review: missing observations.jsonl fails open (obs: 0)
  test('weekly-review (missing observations.jsonl shows obs: 0)', withDir(async (dir) => {
    seedWeeklyReview(dir);
    const now = new Date();
    const dateStr = utcDate(now);
    const hhmm = now.toISOString().slice(11, 16);
    write(hermit(dir, 'sessions', 'S-001-REPORT.md'), [
      '---',
      'id: S-001',
      'type: report',
      `date: ${dateStr}`,
      'operator_turns: 0',
      '---',
      '## Progress Log',
      `- [${hhmm}] reflect (adult) — 0 candidates; verdicts: accept=0 downgrade=0 suppress=0; outcomes: none`,
    ].join('\n'));
    // No observations.jsonl seeded
    const r = await runWeeklyReview(dir);
    expect(r.exitCode).toBe(0);
    const compiledDir = hermit(dir, 'compiled');
    const files = fs.readdirSync(compiledDir);
    const reportFile = files.find(f => f.startsWith('review-weekly-'));
    expect(reportFile).toBeTruthy();
    const content = fs.readFileSync(path.join(compiledDir, reportFile!), 'utf-8');
    expect(content).toContain('reflect_observations: 0');
    expect(content).toContain('obs: 0 ledger');
  }));
});
