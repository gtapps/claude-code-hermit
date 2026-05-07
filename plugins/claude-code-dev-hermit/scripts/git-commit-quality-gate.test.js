'use strict';

// Tests for git-commit-quality-gate.js
// Run with: node scripts/git-commit-quality-gate.test.js

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const GATE = path.join(__dirname, 'git-commit-quality-gate.js');

let passed = 0;
let failed = 0;

function makeInput(command) {
  return JSON.stringify({ tool_input: { command } });
}

function run(command, env = {}) {
  return runRaw(makeInput(command), env);
}

function runRaw(rawInput, env = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-test-'));
  try {
    return spawnSync(process.execPath, [GATE], {
      input: rawInput,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      cwd: tmpDir,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assert(description, cond, detail) {
  if (cond) { console.log(`  ✓ ${description}`); passed++; }
  else { console.error(`  ✗ ${description}${detail ? ' — ' + detail : ''}`); failed++; }
}

// --- Standard profile: nudge on commit, silence on everything else ---
console.log('\nStandard profile:');
{
  const r = run('git commit -m "x"', { AGENT_HOOK_PROFILE: 'standard' });
  assert('git commit: exits 0', r.status === 0);
  assert('git commit: stdout contains additionalContext', r.stdout.includes('"additionalContext"'));
}
{
  delete process.env.AGENT_HOOK_PROFILE;
  const r = run('git commit -m "x"');
  assert('unset profile treated as standard: exits 0', r.status === 0);
  assert('unset profile: stdout contains additionalContext', r.stdout.includes('"additionalContext"'));
}

// --- Strict profile: hard-block ---
console.log('\nStrict profile:');
{
  const r = run('git commit -m "x"', { AGENT_HOOK_PROFILE: 'strict' });
  assert('git commit: exits 2', r.status === 2);
  assert('git commit: stderr contains BLOCKED', r.stderr.includes('BLOCKED'));
  assert('git commit: no additionalContext on stdout', !r.stdout.includes('"additionalContext"'));
}

// --- Tokenizer: handles git -C prefix ---
console.log('\nTokenizer — git -C:');
{
  const r = run('git -C modules/foo commit -m "msg"', { AGENT_HOOK_PROFILE: 'standard' });
  assert('git -C path commit: fires correctly', r.stdout.includes('"additionalContext"'));
}
{
  const r = run('git -C modules/foo commit -m "msg"', { AGENT_HOOK_PROFILE: 'strict' });
  assert('git -C path commit: blocks in strict', r.status === 2);
}

// --- Tokenizer: handles -c key=val prefix ---
console.log('\nTokenizer — git -c:');
{
  const r = run('git -c user.email=x@y.com commit -m "msg"', { AGENT_HOOK_PROFILE: 'strict' });
  assert('git -c key=val commit: blocks in strict', r.status === 2);
}

// --- Tokenizer: env var prefix ---
console.log('\nTokenizer — env prefix:');
{
  const r = run('LANG=en git commit -m "msg"', { AGENT_HOOK_PROFILE: 'strict' });
  assert('LANG=en git commit: blocks in strict', r.status === 2);
}

// --- False positives: non-commit git commands ---
console.log('\nFalse positive checks:');
{
  const r = run('git log --grep="commit message"', { AGENT_HOOK_PROFILE: 'strict' });
  assert('git log --grep="commit ...": no false positive', r.status === 0 && !r.stdout.includes('"additionalContext"'));
}
{
  const r = run('git config commit.template ~/.gitmessage', { AGENT_HOOK_PROFILE: 'strict' });
  assert('git config commit.template: no false positive', r.status === 0 && !r.stdout.includes('"additionalContext"'));
}
{
  const r = run('git status', { AGENT_HOOK_PROFILE: 'strict' });
  assert('git status: silent', r.status === 0 && r.stdout === '');
}
{
  const r = run('git push origin main', { AGENT_HOOK_PROFILE: 'strict' });
  assert('git push: silent', r.status === 0 && r.stdout === '');
}
{
  const r = run('git commit-tree abc123', { AGENT_HOOK_PROFILE: 'strict' });
  assert('git commit-tree: no false positive', r.status === 0 && !r.stdout.includes('"additionalContext"'));
}
{
  const r = run('npm test', { AGENT_HOOK_PROFILE: 'strict' });
  assert('non-git command: silent', r.status === 0 && r.stdout === '');
}

// --- Chained commands ---
console.log('\nChained commands:');
{
  const r = run('git add . && git commit -m "x"', { AGENT_HOOK_PROFILE: 'strict' });
  assert('git add && git commit: blocks in strict', r.status === 2);
}
{
  const r = run('git add . && git commit -m "x"', { AGENT_HOOK_PROFILE: 'standard' });
  assert('git add && git commit: nudges in standard', r.stdout.includes('"additionalContext"'));
}

// --- Edge cases ---
console.log('\nEdge cases:');
{
  const r = runRaw('', { AGENT_HOOK_PROFILE: 'strict' });
  assert('empty stdin: exits 0', r.status === 0);
}
{
  const r = runRaw('not-json', { AGENT_HOOK_PROFILE: 'strict' });
  assert('malformed JSON: exits 0', r.status === 0);
}
{
  const r = runRaw(JSON.stringify({}), { AGENT_HOOK_PROFILE: 'strict' });
  assert('no command field: exits 0', r.status === 0);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
