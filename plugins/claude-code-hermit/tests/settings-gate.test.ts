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

  for (const [key, value] of [['isolate_chats', 'false'], ['shared_chats', "'[]'"], ['operators', "'[]'"]]) {
    test(`channel ${key} asks`, async () => {
      const dir = fixture();
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(`set channels.discord.${key} ${value}`) } }), dir);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
    });
  }

  test('channel recording and piped hatch-config remain silent', async () => {
    const dir = fixture();
    for (const command of [cmd('set channels.discord.log_chats false'),
      `echo '{"channels":{"discord":{"shared_chats":["C1"]}}}' | bun /p/scripts/hatch-config.ts .claude-code-hermit --reinit`]) {
      expectSilent(await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir));
    }
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

test('resident instructions and operator overlay are protected for every write tool', async () => {
  const dir = fixture();
  for (const name of ['RESIDENT.md', 'claude-settings.json']) {
    const file = `.claude-code-hermit/${name}`;
    for (const tool of ['Edit', 'Write'] as const) {
      const result = await runGate(payload({ dir, tool, input: { file_path: file, content: '{}' } }), dir);
      expectAsk(result.stdout, `Hermit setting: ${name}`);
    }
    for (const command of [`echo x > ${file}`, `sed -i s/a/b/ ${file}`, `cp other ${file}`]) {
      const result = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expectAsk(result.stdout, `Hermit setting: ${name}`);
    }
  }
});

describe('static settings policy', () => {
  test('new protected paths ask for both directions and unset', async () => {
    const dir = fixture();
    for (const field of ['operator_profile', 'channels.primary', 'channels.discord.state_dir',
      'channels.discord.marketplace', 'channels.discord.enabled', 'channels.discord.passive_chats',
      'telemetry_export.enabled',
      'telemetry_export.destination.url', 'telemetry_export.destination.bearer_env',
      'telemetry_export.redact_operator_text', 'artifacts.publish_authorized', 'artifacts.backend',
      'docker.packages', 'docker.recommended_plugins.0.enabled', 'docker.fleet_mesh', 'remote', 'chrome', 'auth_mode']) {
      for (const rest of [`set ${field} true`, `set ${field} false`, `unset ${field}`, `toggle ${field}`]) {
        const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
        expectAsk(r.stdout, `Hermit setting: ${field}${rest.startsWith('set ') ? '=' + rest.split(' ').at(-1) : ''}`);
      }
    }
  });

  test('ordinary preferences and routine commands stay silent', async () => {
    const dir = fixture();
    for (const field of ['agent_name', 'language', 'timezone', 'model', 'effort', 'escalation',
      'always_on', 'auto_session', 'ask_gate', 'budget.daily_usd', 'budget.action',
      'heartbeat.enabled', 'watchdog.scheduler_enabled', 'knowledge.channel_log_enabled',
      'channels.discord.log_chats', 'routines.0.skill', 'routines.0.enabled',
      'routines.0.schedule', 'scheduled_checks.0.skill', 'scheduled_checks']) {
      expectSilent(await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(`unset ${field}`) } }), dir));
    }
  });

  test('parent replacements compare protected content and show paths only', async () => {
    const dir = fixture({
      voice: { prose: 'private instructions', style: 'Concise' },
      channels: { discord: { enabled: true, allowed_users: ['a', 'b'], morning_brief: { time: '07:00' } } },
      artifacts: { backend: 'claude', dashboard: true },
      telemetry_export: { destination: { url: 'https://private.example', type: 'webhook' }, interval_hours: 24 },
      docker: { packages: ['git'], fleet_mesh: false },
    });
    const cases: Array<[string, any, string | null]> = [
      ['voice', { style: 'Detailed', prose: 'private instructions' }, null],
      ['voice', { style: 'Detailed' }, 'voice.prose'],
      ['channels.discord', { morning_brief: { time: '08:00' }, allowed_users: ['a', 'b'], enabled: true }, null],
      ['channels.discord', { enabled: false, allowed_users: ['a', 'b'] }, 'channels.discord.enabled'],
      ['channels.discord', { enabled: true, allowed_users: ['b', 'a'] }, 'channels.discord.allowed_users'],
      ['channels.discord', { enabled: true, allowed_users: ['a', 'b'], passive_chats: ['C9'] },
        'channels.discord.passive_chats'],
      ['channels.telegram', {}, 'channels.telegram'],
      ['channels', { discord: { enabled: true, allowed_users: ['a', 'b'] }, telegram: {} }, 'channels.telegram'],
      ['channels', {}, 'channels.discord.allowed_users, channels.discord.enabled'],
      ['artifacts', { backend: 'claude', dashboard: false }, null],
      ['artifacts', {}, 'artifacts.backend'],
      ['telemetry_export', { interval_hours: 12, destination: { type: 'webhook', url: 'https://private.example' } }, null],
      ['telemetry_export', { destination: { url: 'https://changed.example' } }, 'telemetry_export.destination'],
      ['docker', { packages: ['git'], fleet_mesh: false }, null],
      ['docker', { packages: ['curl'], fleet_mesh: false }, 'docker.packages'],
    ];
    for (const [field, value, asked] of cases) {
      const command = cmd(`set ${field} '${JSON.stringify(value)}'`);
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      if (asked) expectAsk(r.stdout, `Hermit setting: ${asked}`);
      else expectSilent(r);
      expect(r.stdout).not.toContain('private.example');
      expect(r.stdout).not.toContain('private instructions');
    }
    for (const rest of ['unset voice', 'set voice none', 'set voice clear']) {
      expectAsk((await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir)).stdout,
        'Hermit setting: voice.prose');
    }
  });

  test('missing, null, and opaque parent writes stay distinct', async () => {
    const dir = fixture();
    for (const [rest, asked] of [
      [`set voice '{"style":"Concise"}'`, null],
      [`set voice '{"prose":null}'`, 'voice.prose'],
      ['unset voice', null], ['set voice malformed', 'voice'], ['set voice "$VALUE"', 'voice'],
      ['toggle voice', 'voice'], ['set voice', 'voice'],
      ['set voice {"style":"Concise","prose":"x"}', 'voice'],
    ] as const) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
      if (asked) expectAsk(r.stdout, `Hermit setting: ${asked}`);
      else expectSilent(r);
    }
    fs.writeFileSync(path.join(dir, '.claude-code-hermit/config.json'), '{');
    expectAsk((await runGate(payload({ dir, tool: 'Bash', input: { command: cmd('unset voice') } }), dir)).stdout,
      'Hermit setting: voice');
  });

  test('the named target and tool cwd determine the parent baseline', async () => {
    const dir = fixture({ voice: { prose: 'resident' } });
    fs.writeFileSync(path.join(dir, 'other config.json'), JSON.stringify({ voice: { style: 'Concise' } }));
    const command = `bun /p/scripts/settings-edit.ts 'other config.json' set voice '{"style":"Detailed"}'`;
    expectSilent(await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir));
    for (const command of [
      `bun /p/scripts/settings-edit.ts "$CONFIG" unset voice`,
      `bun /p/scripts/settings-edit.ts *.json unset voice`,
      `cd elsewhere && ${cmd('unset voice')}`,
    ]) expectAsk((await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir)).stdout, 'Hermit setting: voice');
  });

  test('routine commands and precheck removal preserve the existing exception', async () => {
    const dir = fixture({ routines: [{ id: 'custom', skill: 'old', precheck: 'tools/check.sh', precheck_timeout_s: 30 }] });
    for (const rest of [
      `set routines '[{"id":"custom","skill":"new"}]'`,
      `set routines.0 '{"id":"custom","skill":"new","precheck":"tools/check.sh","precheck_timeout_s":30}'`,
      'unset routines',
    ]) expectSilent(await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir));
    for (const field of ['precheck', 'precheck_timeout_s']) {
      expectAsk((await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(`unset routines.0.${field}`) } }), dir)).stdout,
        `Hermit setting: routines.0.${field}`);
    }
  });
});
