'use strict';

// Tests for git-push-guard.js
// Run with: node scripts/git-push-guard.test.js

const { execSync, spawnSync } = require('child_process');
const path = require('path');

const GUARD = path.join(__dirname, 'git-push-guard.js');

let passed = 0;
let failed = 0;

function makeInput(command) {
  return JSON.stringify({ tool_input: { command } });
}

function run(command, env = {}) {
  return runRaw(makeInput(command), env);
}

function runRaw(rawInput, env = {}) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: rawInput,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  return result.status;
}

function assert(description, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description} — expected exit ${expected}, got ${actual}`);
    failed++;
  }
}

// --- Non-strict profile: everything passes through ---
console.log('\nNon-strict profile (AGENT_HOOK_PROFILE=standard):');
assert('push to main passes through', run('git push origin main', { AGENT_HOOK_PROFILE: 'standard' }), 0);
assert('--no-verify passes through', run('git commit --no-verify', { AGENT_HOOK_PROFILE: 'standard' }), 0);
assert('force push passes through', run('git push --force origin feature/x', { AGENT_HOOK_PROFILE: 'standard' }), 0);

console.log('\nNon-strict profile (AGENT_HOOK_PROFILE unset):');
assert('push to main passes through when unset', (() => {
  const env = { ...process.env };
  delete env.AGENT_HOOK_PROFILE;
  return runRaw(makeInput('git push origin main'), env);
})(), 0);

// --- Strict profile: blocked commands ---
console.log('\nStrict profile — blocked:');
assert('--no-verify on commit is blocked', run('git commit --no-verify', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--no-verify on push is blocked', run('git push --no-verify origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('push to main is blocked', run('git push origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('push to master is blocked', run('git push origin master', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--force push to feature branch is blocked', run('git push --force origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('-f push to feature branch is blocked', run('git push -f origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--force-with-lease to main is blocked', run('git push --force-with-lease origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--force-with-lease to master is blocked', run('git push --force-with-lease origin master', { AGENT_HOOK_PROFILE: 'strict' }), 2);

// --- Strict profile: allowed commands ---
console.log('\nStrict profile — allowed:');
assert('push to feature branch is allowed', run('git push origin feature/my-feature', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('--force-with-lease to feature branch is allowed', run('git push --force-with-lease origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('non-git command is allowed', run('npm test', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('"main" in branch name like main-staging is allowed', run('git push origin main-staging', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Edge cases ---
console.log('\nEdge cases:');
assert('empty stdin exits cleanly', runRaw('', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('malformed JSON exits cleanly', runRaw('not-json', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
