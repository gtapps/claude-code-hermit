'use strict';

// Tests for git-push-guard.js
// Run with: node scripts/git-push-guard.test.js

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

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
    cwd: process.cwd(),
  });
  return result.status;
}

// Run guard with a temporary config that sets custom protected branches
function runWithConfig(command, protectedBranches, env = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  const hermitDir = path.join(tmpDir, '.claude-code-hermit');
  fs.mkdirSync(hermitDir);
  fs.writeFileSync(
    path.join(hermitDir, 'config.json'),
    JSON.stringify({ dev: { protected_branches: protectedBranches } })
  );
  const result = spawnSync(process.execPath, [GUARD], {
    input: makeInput(command),
    env: { ...process.env, AGENT_HOOK_PROFILE: 'strict', ...env },
    encoding: 'utf-8',
    cwd: tmpDir,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

// --- Edge cases (existing) ---
console.log('\nEdge cases:');
assert('empty stdin exits cleanly', runRaw('', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('malformed JSON exits cleanly', runRaw('not-json', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Parser improvements: git -C, env prefix, -c key=val ---
console.log('\nParser improvements:');
assert('git -C /path push origin main is blocked', run('git -C /some/path push origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('git -C /path push to feature is allowed', run('git -C /some/path push origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('env GIT_SSH=x git push origin main is blocked', run('GIT_SSH=x git push origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('git -c http.extraHeader=x push origin main is blocked', run('git -c http.extraHeader=foo push origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);

// --- Chained commands ---
console.log('\nChained commands:');
assert('git checkout main && git push origin feature/x is allowed', run('git checkout main && git push origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('git push origin feature/x && git push origin main is blocked', run('git push origin feature/x && git push origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('git push origin feature/x; git push origin master is blocked', run('git push origin feature/x; git push origin master', { AGENT_HOOK_PROFILE: 'strict' }), 2);

// --- Refspec forms ---
console.log('\nRefspec forms:');
assert('HEAD:main refspec is blocked', run('git push origin HEAD:main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('HEAD:feature is allowed', run('git push origin HEAD:feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('+main force refspec is blocked', run('git push origin +main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('+feature force refspec is allowed', run('git push origin +feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert(':main delete-by-empty-source is blocked', run('git push origin :main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert(':feature delete-by-empty-source is allowed', run('git push origin :feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('refs/heads/main is blocked', run('git push origin refs/heads/main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('refs/heads/feature/x is allowed', run('git push origin refs/heads/feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Delete and dangerous flags ---
console.log('\nDelete and dangerous flags:');
assert('--delete main is blocked', run('git push origin --delete main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--delete feature/x is allowed', run('git push origin --delete feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('-d main is blocked', run('git push origin -d main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--mirror is blocked', run('git push --mirror origin', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--all is blocked', run('git push --all origin', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('-a is blocked', run('git push -a origin', { AGENT_HOOK_PROFILE: 'strict' }), 2);

// --- force-with-lease edge cases ---
console.log('\nForce-with-lease edge cases:');
assert('--force-with-lease with no refspec is blocked (ambiguous)', run('git push --force-with-lease origin', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--force-with-lease to feature branch is allowed', run('git push --force-with-lease origin feature/my-branch', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Plain push (no refspec) ---
console.log('\nPlain push:');
assert('git push (no remote, no refspec) is allowed', run('git push', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('git push origin (remote, no refspec) is allowed', run('git push origin', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Config-driven protected branches ---
console.log('\nConfig-driven protected branches:');
assert('release/1.2 blocked when release/* is protected', runWithConfig('git push origin release/1.2', ['release/*']), 2);
assert('release/1.2 allowed with default config', run('git push origin release/1.2', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('staging blocked when staging is in config', runWithConfig('git push origin staging', ['main', 'staging']), 2);
assert('feature/x allowed with custom config', runWithConfig('git push origin feature/x', ['main', 'staging']), 0);
assert('config still blocks main', runWithConfig('git push origin main', ['main', 'staging']), 2);

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
