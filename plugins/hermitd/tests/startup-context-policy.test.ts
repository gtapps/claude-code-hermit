import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { runScript } from './helpers/run';
import { contextPolicyHash } from '../scripts/lib/context-policy';

test('full resident loads refresh policy while compaction and guests preserve the baseline', async () => {
  const f = taskFixture();
  try {
    const policyFile = path.join(f.dir, 'state/context-clear.json');
    const runtime = { version: 1, updated_at: 'sentinel' };
    f.put('state/runtime.json', runtime);
    const run = (source: string, resident = '1') => runScript('startup-context.ts', {
      cwd: path.dirname(f.dir),
      env: { AGENT_DIR: f.dir, HERMIT_RESIDENT: resident, HERMIT_MANAGED: '', CLAUDE_CONFIG_DIR: path.join(f.dir, 'registry') },
      stdin: JSON.stringify({ source, session_id: resident ? 'resident' : 'guest' }),
    });

    expect((await run('startup', '')).exitCode).toBe(0);
    expect(fs.existsSync(policyFile)).toBe(false);
    expect((await run('startup')).exitCode).toBe(0);
    const baseline = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    expect(baseline.policy_hash).toBe(contextPolicyHash(f.dir));

    const trigger = { reason: 'quiet', reset_at: '2026-01-01T00:00:00.000Z' };
    f.put('state/context-clear.json', { ...baseline, last_trigger: trigger });
    fs.writeFileSync(path.join(f.dir, 'TASKS.md'), 'Changed confirmation policy');
    for (const [source, resident] of [['compact', '1'], ['startup', ''], ['clear', '']]) {
      expect((await run(source, resident)).exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(policyFile, 'utf8'))).toEqual({ ...baseline, last_trigger: trigger });
    }
    for (const source of ['clear', 'resume']) {
      fs.appendFileSync(path.join(f.dir, 'TASKS.md'), `\nLoaded on ${source}`);
      const result = await run(source);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Changed confirmation policy');
      expect(JSON.parse(fs.readFileSync(policyFile, 'utf8'))).toEqual({ policy_hash: contextPolicyHash(f.dir), last_trigger: trigger });
    }
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'state/runtime.json'), 'utf8'))).toEqual(runtime);
  } finally { f.cleanup(); }
});

test('a failed baseline write does not suppress resident context', async () => {
  const f = taskFixture();
  try {
    fs.mkdirSync(path.join(f.dir, 'state/context-clear.json'));
    fs.writeFileSync(path.join(f.dir, 'TASKS.md'), 'Policy is still delivered.');
    const result = await runScript('startup-context.ts', {
      cwd: path.dirname(f.dir),
      env: { AGENT_DIR: f.dir, HERMIT_RESIDENT: '1', HERMIT_MANAGED: '', CLAUDE_CONFIG_DIR: path.join(f.dir, 'registry') },
      stdin: JSON.stringify({ source: 'startup', session_id: 'resident' }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Policy is still delivered.');
  } finally { f.cleanup(); }
});
