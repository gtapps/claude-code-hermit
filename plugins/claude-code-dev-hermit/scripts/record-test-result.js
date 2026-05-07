'use strict';

// PostToolUse Bash hook: when the configured test command runs, record its
// exit code + duration + sha to .claude-code-hermit/state/last-test.json.
// /dev-pr Gate 0 reads this file to verify tests actually ran on the current
// HEAD (closes the "agent hallucinates a pass" gap from the v0.3.0 ultrareview).
//
// Match policy: substring of `claude-code-dev-hermit.commands.test` appearing
// in the bash command. Operators with very generic test commands (`test`,
// `pytest`) get false positives on unrelated commands; configure a more
// specific command if that's a problem.
//
// Always exits 0 — recording failures must not block subsequent tools.

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const MAX_STDIN = 1024 * 1024;

function findHermitDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude-code-hermit', 'config.json'))) return path.join(dir, '.claude-code-hermit');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadTestCommand(hermitDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(hermitDir, 'config.json'), 'utf-8'));
    return cfg?.['claude-code-dev-hermit']?.commands?.test || null;
  } catch (_) { return null; }
}

function gitHead(cwd) {
  try {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) { return null; }
}

function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function writeRecord(hermitDir, command, exitCode, durationMs, targetDir) {
  const sha = gitHead(targetDir || process.cwd());
  if (!sha) return;
  const record = {
    command,
    exit_code: exitCode,
    duration_ms: durationMs,
    status: exitCode === 0 ? 'pass' : 'fail',
    sha,
    ts: new Date().toISOString(),
  };
  if (exitCode !== 0) {
    const likelyCause = exitCode === 137 ? 'oom'
                      : exitCode === 124 ? 'timeout'
                      : exitCode === 130 ? 'user-interrupt'
                      : null;
    if (likelyCause) record.likely_cause = likelyCause;
  }
  const stateDir = path.join(hermitDir, 'state');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    atomicWrite(path.join(stateDir, 'last-test.json'), JSON.stringify(record, null, 2) + '\n');
  } catch (_) {}
}

const argv = process.argv;

function parseCwdFlag(args) {
  const i = args.indexOf('--cwd');
  if (i === -1) return null;
  const val = args[i + 1];
  if (!val || val.startsWith('--')) {
    console.error('--cwd: missing path argument');
    process.exit(1);
  }
  try {
    execSync('git rev-parse --git-dir', { cwd: val, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (_) {
    console.error(`--cwd: not a git working tree: ${val}`);
    process.exit(1);
  }
  return val;
}

// run subcommand: execute commands.test and record the result
if (argv[2] === 'run') {
  const targetDir = parseCwdFlag(argv.slice(3));
  const hermitDir = findHermitDir(process.cwd());
  if (!hermitDir) { console.error('No .claude-code-hermit/ found'); process.exit(1); }
  const testCmd = loadTestCommand(hermitDir);
  if (!testCmd) { console.error('commands.test not configured'); process.exit(1); }
  const start = Date.now();
  const spawnOpts = { stdio: 'inherit' };
  if (targetDir) spawnOpts.cwd = targetDir;
  const r = spawnSync('bash', ['-c', testCmd], spawnOpts);
  writeRecord(hermitDir, testCmd, r.status ?? 1, Date.now() - start, targetDir);
  process.exit(r.status ?? 1);
}

// write subcommand: record a known exit code (for direct callers / CI)
if (argv[2] === 'write') {
  const ecArg = argv[3];
  const durArg = argv[4];
  if (!/^-?\d+$/.test(ecArg) || !/^-?\d+$/.test(durArg)) process.exit(0);
  const targetDir = parseCwdFlag(argv.slice(5));
  const hermitDir = findHermitDir(process.cwd());
  if (!hermitDir) process.exit(0);
  const testCmd = loadTestCommand(hermitDir) || '';
  writeRecord(hermitDir, testCmd, parseInt(ecArg, 10), parseInt(durArg, 10), targetDir);
  process.exit(0);
}

async function main() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN) process.exit(0);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) process.exit(0);

  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  if (data.tool_response?.interrupted === true) process.exit(0);

  const command = data.tool_input?.command || '';
  if (!command) process.exit(0);

  const hermitDir = findHermitDir(process.cwd());
  if (!hermitDir) process.exit(0);

  const testCmd = loadTestCommand(hermitDir);
  if (!testCmd) process.exit(0);

  if (!command.includes(testCmd)) process.exit(0);

  const tr = data.tool_response || {};
  const exitCode = typeof tr.exit_code === 'number' ? tr.exit_code
                 : typeof tr.exitCode === 'number' ? tr.exitCode : null;
  if (exitCode === null) process.exit(0);

  writeRecord(hermitDir, command, exitCode, null);
  process.exit(0);
}

main();
