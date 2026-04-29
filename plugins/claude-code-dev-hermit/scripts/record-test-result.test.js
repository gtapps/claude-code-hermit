'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, 'record-test-result.js');

let passed = 0;
let failed = 0;

const { execSync } = require('child_process');

function setupProject(testCmd) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-'));
  const hermit = path.join(tmp, '.claude-code-hermit');
  fs.mkdirSync(hermit, { recursive: true });
  const cfg = testCmd !== null
    ? { 'claude-code-dev-hermit': { commands: { test: testCmd } } }
    : {};
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify(cfg));
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execSync('git init -q && git commit -q --allow-empty -m init', { cwd: tmp, env: gitEnv, stdio: 'ignore' });
  return tmp;
}

function runHook(cwd, payload) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf-8',
  });
  return result.status;
}

function readState(cwd) {
  const file = path.join(cwd, '.claude-code-hermit', 'state', 'last-test.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function assert(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\nRecord test result hook:');

let proj = setupProject('npm test');
runHook(proj, { tool_input: { command: 'npm test' }, tool_response: { exit_code: 0, duration_ms: 1234 } });
let s = readState(proj);
assert('records pass with exit_code 0', s !== null && s.status === 'pass' && s.exit_code === 0);
assert('hook path writes duration_ms null (run subcommand provides timing)', s && s.duration_ms === null);
assert('records command', s && s.command === 'npm test');
assert('records ts', s && typeof s.ts === 'string' && s.ts.includes('T'));
cleanup(proj);

proj = setupProject('pytest -q');
runHook(proj, { tool_input: { command: 'pytest -q tests/test_auth.py' }, tool_response: { exit_code: 1 } });
s = readState(proj);
assert('records fail when exit_code != 0', s !== null && s.status === 'fail' && s.exit_code === 1);
assert('substring match (subset args allowed)', s !== null);
cleanup(proj);

proj = setupProject('npm test');
runHook(proj, { tool_input: { command: 'ls -la' }, tool_response: { exit_code: 0 } });
s = readState(proj);
assert('does not record for non-test commands', s === null);
cleanup(proj);

proj = setupProject('npm test');
runHook(proj, { tool_input: { command: 'npm test' }, tool_response: {} });
s = readState(proj);
assert('does not write when no exit_code in response', s === null);
cleanup(proj);

proj = setupProject('npm test');
runHook(proj, { tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } });
s = readState(proj);
assert('records git HEAD sha', s !== null && typeof s.sha === 'string' && s.sha.length === 40);
cleanup(proj);

const tmpNoGit = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-nogit-'));
const hermitNoGit = path.join(tmpNoGit, '.claude-code-hermit');
fs.mkdirSync(hermitNoGit);
fs.writeFileSync(path.join(hermitNoGit, 'config.json'), JSON.stringify({ 'claude-code-dev-hermit': { commands: { test: 'npm test' } } }));
runHook(tmpNoGit, { tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } });
assert('does not write last-test.json when not in a git repo', !fs.existsSync(path.join(hermitNoGit, 'state', 'last-test.json')));
fs.rmSync(tmpNoGit, { recursive: true, force: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-noproj-'));
const rc = runHook(tmp, { tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } });
assert('exits 0 cleanly when no .claude-code-hermit/ found', rc === 0);
fs.rmSync(tmp, { recursive: true, force: true });

const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-notestcmd-'));
fs.mkdirSync(path.join(tmp2, '.claude-code-hermit'));
fs.writeFileSync(path.join(tmp2, '.claude-code-hermit', 'config.json'), JSON.stringify({}));
const rc2 = runHook(tmp2, { tool_input: { command: 'anything' }, tool_response: { exit_code: 0 } });
assert('exits 0 when commands.test is not configured', rc2 === 0);
assert('does not write last-test.json without configured command', !fs.existsSync(path.join(tmp2, '.claude-code-hermit', 'state', 'last-test.json')));
fs.rmSync(tmp2, { recursive: true, force: true });

// interrupted guard
proj = setupProject('npm test');
runHook(proj, { tool_input: { command: 'npm test' }, tool_response: { interrupted: true } });
s = readState(proj);
assert('does not write when tool_response.interrupted is true', s === null);
cleanup(proj);

// write subcommand — pass
proj = setupProject('npm test');
spawnSync(process.execPath, [HOOK, 'write', '0', '1234'], { cwd: proj });
s = readState(proj);
const expectedSha = execSync('git rev-parse HEAD', { cwd: proj, encoding: 'utf-8' }).trim();
assert('write: records pass with exit_code 0', s !== null && s.exit_code === 0 && s.status === 'pass');
assert('write: records duration_ms', s !== null && s.duration_ms === 1234);
assert('write: records git HEAD sha', s !== null && s.sha === expectedSha);
cleanup(proj);

// write subcommand — fail
proj = setupProject('npm test');
spawnSync(process.execPath, [HOOK, 'write', '1', '500'], { cwd: proj });
s = readState(proj);
assert('write: records fail with exit_code 1', s !== null && s.exit_code === 1 && s.status === 'fail');
cleanup(proj);

// write subcommand — invalid args
proj = setupProject('npm test');
spawnSync(process.execPath, [HOOK, 'write', '0abc', '1234'], { cwd: proj });
s = readState(proj);
assert('write: does not write on invalid exit_code arg', s === null);
cleanup(proj);

// run subcommand — pass
proj = setupProject('exit 0');
const runPass = spawnSync(process.execPath, [HOOK, 'run'], { cwd: proj, encoding: 'utf-8' });
s = readState(proj);
const runSha = execSync('git rev-parse HEAD', { cwd: proj, encoding: 'utf-8' }).trim();
assert('run: exits 0 on passing test command', runPass.status === 0);
assert('run: records pass', s !== null && s.status === 'pass');
assert('run: records git HEAD sha', s !== null && s.sha === runSha);
cleanup(proj);

// run subcommand — fail
proj = setupProject('exit 1');
const runFail = spawnSync(process.execPath, [HOOK, 'run'], { cwd: proj, encoding: 'utf-8' });
s = readState(proj);
assert('run: exits 1 on failing test command', runFail.status === 1);
assert('run: records fail', s !== null && s.status === 'fail');
cleanup(proj);

// run subcommand — no commands.test
proj = setupProject(null);
const runNoCmd = spawnSync(process.execPath, [HOOK, 'run'], { cwd: proj, encoding: 'utf-8' });
s = readState(proj);
assert('run: exits 1 when commands.test not configured', runNoCmd.status === 1);
assert('run: does not write when commands.test not configured', s === null);
cleanup(proj);

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
