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
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({
    'claude-code-dev-hermit': { commands: { test: testCmd } },
  }));
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
assert('records duration_ms', s && s.duration_ms === 1234);
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
assert('records unknown when no exit_code in response', s !== null && s.status === 'unknown' && s.exit_code === null);
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

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
