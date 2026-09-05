// Spawns the settings-gate hook: the stdout JSON and exit code are the thing
// Claude Code actually consumes (tests/helpers/run.ts).
import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-settings-gate-');
afterAll(cleanup);

function fixture(config?: any): string {
  const dir = freshDir();
  const hermit = path.join(dir, '.claude-code-hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  if (config) fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify(config));
  return dir;
}

function payload(opts: {
  dir: string;
  tool: 'Bash' | 'Edit' | 'Write';
  input: any;
}): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: opts.tool,
    tool_input: opts.input,
    cwd: opts.dir,
  });
}

async function runGate(stdin: string, dir: string) {
  return runScript('settings-gate.ts', {
    stdin,
    cwd: dir,
    env: { AGENT_DIR: path.join(dir, '.claude-code-hermit') },
  });
}

function cmd(rest: string): string {
  return `bun /p/scripts/settings-edit.ts .claude-code-hermit/config.json ${rest}`;
}

function expectAsk(stdout: string, reason: string) {
  expect(JSON.parse(stdout.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  });
}

function expectSilent(r: { exitCode: number; stdout: string }) {
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('');
}

describe('settings-gate ask list', () => {
  test('each ask path as leaf and as container', async () => {
    const dir = fixture();
    const cases: Array<[string, string]> = [
      ['set env \'{"A":"x"}\'', 'Hermit setting: env.A=[set]'],
      ['set env.X foo', 'Hermit setting: env.X=[set]'],
      ['set monitors \'[]\'', 'Hermit setting: monitors=[]'],
      ['set channels.discord.allowed_users \'["u"]\'', 'Hermit setting: channels.discord.allowed_users=["u"]'],
      ['set routines.0.precheck tools/x.sh', 'Hermit setting: routines.0.precheck=tools/x.sh'],
      ['set permission_mode default', 'Hermit setting: permission_mode=default'],
      ['set boot_skill /x:boot', 'Hermit setting: boot_skill=/x:boot'],
      ['set shutdown_skill /x:stop', 'Hermit setting: shutdown_skill=/x:stop'],
      ['set backup.enabled true', 'Hermit setting: backup.enabled=true'],
      ['set voice.prose \'"be brief"\'', 'Hermit setting: voice.prose="be brief"'],
    ];
    for (const [rest, reason] of cases) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
      expect(r.exitCode).toBe(0);
      expectAsk(r.stdout, reason);
    }
  });

  test('apply-known permissions asks', async () => {
    const dir = fixture();
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd('apply-known permissions default') } }),
      dir,
    );
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: permission_mode=default');
  });

  test('set voice.style Concise allows', async () => {
    const dir = fixture();
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd('set voice.style Concise') } }),
      dir,
    );
    expectSilent(r);
  });

  test('per-channel everyday keys and retired dials allow', async () => {
    const dir = fixture();
    for (const rest of [
      'set channels.discord.morning_brief \'{"enabled":true,"time":"07:00"}\'',
      'unset channels.discord.settings_policy',
      'unset settings_permissions',
      'unset settings_from_chat',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
      expectSilent(r);
    }
  });

  test('a quoted script or config path still asks', async () => {
    const dir = fixture();
    for (const command of [
      'bun "/home/x y/scripts/settings-edit.ts" .claude-code-hermit/config.json set permission_mode default',
      'bun /p/scripts/settings-edit.ts "/home/x y/.claude-code-hermit/config.json" set permission_mode default',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expect(r.exitCode).toBe(0);
      expectAsk(r.stdout, 'Hermit setting: permission_mode=default');
    }
  });

  test('a target the shell would expand asks', async () => {
    const dir = fixture();
    const command = 'P=permission_mode; ' + cmd('set $P default');
    const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: $P');
  });
});

describe('settings-gate routines container', () => {
  const current = [
    { id: 'reflect', precheck: 'reflect' },
    { id: 'brief' },
  ];

  test('set routines.0 with a precheck asks, without one allows', async () => {
    const dir = fixture({ routines: current });
    const withGate = JSON.stringify({ id: 'brief', precheck: 'tools/x.sh' });
    const asked = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd(`set routines.0 '${withGate}'`) } }),
      dir,
    );
    expect(asked.exitCode).toBe(0);
    expectAsk(asked.stdout, `Hermit setting: routines.0=${withGate}`);

    const without = JSON.stringify({ id: 'brief' });
    const allowed = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd(`set routines.0 '${without}'`) } }),
      dir,
    );
    expectSilent(allowed);
  });

  test('a reorder with the same gates allows', async () => {
    const dir = fixture({ routines: current });
    const reordered = JSON.stringify([{ id: 'brief' }, { id: 'reflect', precheck: 'reflect' }]);
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd(`set routines '${reordered}'`) } }),
      dir,
    );
    expectSilent(r);
  });

  test('an unparseable routines value asks', async () => {
    const dir = fixture({ routines: current });
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd("set routines 'not json'") } }),
      dir,
    );
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: routines=not json');
  });
});

describe('settings-gate reason shape', () => {
  test('a chained safe write plus an asked write names only the asked target', async () => {
    const dir = fixture();
    const command =
      cmd('set model haiku') + ' && ' + cmd('set permission_mode default');
    const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: permission_mode=default');
  });

  test('a secret env value renders [set]', async () => {
    const dir = fixture();
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd('set env.KEY sk-x') } }),
      dir,
    );
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: env.KEY=[set]');
  });

  test('a bare integer env value passes through', async () => {
    const dir = fixture();
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd('set env.N 20000') } }),
      dir,
    );
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: env.N=20000');
  });
});

describe('settings-gate file writes', () => {
  test('Edit and Write on config.json ask', async () => {
    const dir = fixture();
    const fp = path.join(dir, '.claude-code-hermit', 'config.json');
    for (const tool of ['Edit', 'Write'] as const) {
      const r = await runGate(payload({ dir, tool, input: { file_path: fp } }), dir);
      expect(r.exitCode).toBe(0);
      expectAsk(r.stdout, 'Hermit setting: config.json');
    }
  });

  test('a shell write onto config.json asks', async () => {
    const dir = fixture();
    for (const command of [
      'cat > .claude-code-hermit/config.json <<EOF\n{}\nEOF',
      'cat /tmp/new.json > "$HERMIT_DIR/config.json"',
      'cp /tmp/new.json .claude-code-hermit/config.json',
      'jq . /tmp/new.json | tee .claude-code-hermit/config.json',
      'sed -i \'s/haiku/opus/\' .claude-code-hermit/config.json',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expect(r.exitCode).toBe(0);
      expectAsk(r.stdout, 'Hermit setting: config.json');
    }
  });

  test('reading config.json through the shell prints nothing', async () => {
    const dir = fixture();
    for (const command of [
      'jq .model .claude-code-hermit/config.json > /tmp/out.txt',
      'sed -n 5p .claude-code-hermit/config.json',
      'cp .claude-code-hermit/config.json /tmp/backup.json',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expectSilent(r);
    }
  });
});

describe('settings-gate silent paths', () => {
  test('reads print nothing', async () => {
    const dir = fixture();
    for (const rest of ['show', 'get permission_mode', 'history']) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
      expectSilent(r);
    }
  });

  test('ls prints nothing', async () => {
    const dir = fixture();
    const r = await runGate(payload({ dir, tool: 'Bash', input: { command: 'ls' } }), dir);
    expectSilent(r);
  });

  test('malformed stdin exits 0 printing nothing', async () => {
    const dir = fixture();
    const r = await runGate('not json at all', dir);
    expectSilent(r);
  });

  test('oversized stdin asks', async () => {
    const dir = fixture();
    const r = await runGate('x'.repeat(1.5 * 1024 * 1024), dir);
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: tool call too large to inspect');
  });
});
