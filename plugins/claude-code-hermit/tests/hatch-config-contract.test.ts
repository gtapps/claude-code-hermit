import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template');
const OWN_PLUGIN_JSON = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
);
const CORE_VERSION: string = OWN_PLUGIN_JSON.version;

const { freshDir, cleanup } = freshDirFactory('hermit-hatch-config-');
afterAll(cleanup);

function configPathFor(projectRoot: string): string {
  return path.join(projectRoot, '.claude-code-hermit', 'config.json');
}

function seedConfig(projectRoot: string, config: any): void {
  const hermit = path.join(projectRoot, '.claude-code-hermit');
  fs.mkdirSync(hermit, { recursive: true });
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

async function runHatchConfig(projectRoot: string, answers: any, reinit = false) {
  const args = reinit ? [projectRoot, '--reinit'] : [projectRoot];
  // Pin CLAUDE_PLUGIN_ROOT to the plugin-under-test so hatch-config resolves its
  // template + plugin.json from this worktree, not an ambient installed plugin — a
  // live hermit session sets CLAUDE_PLUGIN_ROOT to the marketplace copy, whose
  // template can lag this branch and drift the assembled config.
  return runScript('hatch-config.ts', { args, stdin: JSON.stringify(answers), env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
}

describe('hatch-config.ts', () => {
  test('template ships watchdog.scheduler_enabled true', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    expect(template.watchdog.scheduler_enabled).toBe(true);
  });

  test('fresh hatch: full answers produce the exact expected config.json', async () => {
    const dir = freshDir();
    const answers = {
      project_name: 'my-project',
      activated_hermit: {
        slug: 'claude-code-dev-hermit',
        boot_skill: '/claude-code-dev-hermit:dev-boot',
      },
      agent_name: 'Aria', language: 'en', timezone: 'Europe/London', sign_off: 'Aria out.',
      escalation: 'balanced', remote: true, idle_behavior: 'discover', permission_mode: 'auto',
      routines: { enabled: true, morning_time: '08:30', evening_time: '22:30' },
      channels: { discord: { enabled: true, allowed_users: ['12345'], morning_brief_time: '07:00' } },
    };
    const r = await runHatchConfig(dir, answers);
    expect(r.exitCode).toBe(0);

    const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    const expected = {
      ...template,
      tmux_session_name: 'hermit-my-project',
      agent_name: 'Aria', language: 'en', timezone: 'Europe/London', sign_off: 'Aria out.',
      escalation: 'balanced', operator_profile: 'technical', remote: true, idle_behavior: 'discover', permission_mode: 'auto',
      boot_skill: '/claude-code-dev-hermit:dev-boot',
      _hermit_versions: { 'claude-code-hermit': CORE_VERSION },
      routines: [
        ...template.routines,
        { id: 'morning', schedule: '30 8 * * *', skill: 'claude-code-hermit:brief --morning', enabled: true, run_during_waiting: true },
        { id: 'evening', schedule: '30 22 * * *', skill: 'claude-code-hermit:brief --evening', enabled: true, run_during_waiting: true },
      ],
      channels: {
        discord: { enabled: true, dm_channel_id: null, default_chat_id: null, state_dir: '.claude.local/channels/discord', allowed_users: ['12345'], morning_brief: { enabled: true, time: '07:00' } },
      },
    };

    const onDisk = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
    expect(onDisk).toEqual(expected);
    expect(JSON.parse(r.stdout)).toEqual(expected);
  });

  test('fresh hatch: refuses if config.json already exists (no --reinit)', async () => {
    const dir = freshDir();
    seedConfig(dir, { existing: true });
    const r = await runHatchConfig(dir, { project_name: 'x' });
    expect(r.exitCode).not.toBe(0);
    // untouched
    expect(JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'))).toEqual({ existing: true });
  });

  test('--reinit refuses if no existing config.json is found', async () => {
    const dir = freshDir();
    const r = await runHatchConfig(dir, {}, true);
    expect(r.exitCode).not.toBe(0);
    expect(fs.existsSync(configPathFor(dir))).toBe(false);
  });

  test('re-init: preserves custom keys, learned channel state, unrelated routines/checks; does not advance _hermit_versions', async () => {
    const dir = freshDir();
    const seed = {
      ...JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')),
      foo_custom: true,
      push_notifications: false,
      _hermit_versions: { 'claude-code-hermit': '1.0.0' },
      routines: [
        { id: 'heartbeat-restart', schedule: '0 4 * * *', skill: 'claude-code-hermit:heartbeat start', run_during_waiting: true, enabled: true },
        { id: 'reflect', schedule: '0 9 * * *', skill: 'claude-code-hermit:reflect', enabled: true },
        { id: 'custom-routine', schedule: '0 5 * * *', skill: 'foo', enabled: true },
      ],
      scheduled_checks: [
        { id: 'automation-recommender', plugin: 'claude-code-setup', skill: '/claude-code-setup:claude-automation-recommender', enabled: true, trigger: 'interval', interval_days: 7 },
        { id: 'my-custom-check', plugin: 'my-plugin', skill: '/my-plugin:check', enabled: true, trigger: 'session' },
      ],
      channels: {
        primary: 'discord',
        discord: { enabled: true, dm_channel_id: 'D999', state_dir: '.claude.local/channels/discord' },
        mycustom: { enabled: true, marketplace: 'someorg', dm_channel_id: 'X1', state_dir: '.claude.local/channels/mycustom' },
      },
    };
    seedConfig(dir, seed);

    const answers = {
      agent_name: 'Aria2',
      routines: { enabled: true, morning_time: '09:00', evening_time: '21:00' },
      channels: { discord: { allowed_users: ['999'] } },
      activated_hermit: { slug: 'claude-code-dev-hermit', boot_skill: '/claude-code-dev-hermit:dev-boot' },
    };
    const r = await runHatchConfig(dir, answers, true);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));

    // custom / untouched state preserved
    expect(out.foo_custom).toBe(true);
    expect(out.push_notifications).toBe(false);

    // _hermit_versions: not advanced; activated sibling is not stamped by core
    expect(out._hermit_versions['claude-code-hermit']).toBe('1.0.0');
    expect(out._hermit_versions['claude-code-dev-hermit']).toBeUndefined();

    // channels: discord field-merged (dm_channel_id preserved, allowed_users updated),
    // mycustom + primary fully preserved
    expect(out.channels.discord.dm_channel_id).toBe('D999');
    expect(out.channels.discord.state_dir).toBe('.claude.local/channels/discord');
    expect(out.channels.discord.allowed_users).toEqual(['999']);
    expect(out.channels.mycustom).toEqual(seed.channels.mycustom);
    expect(out.channels.primary).toBe('discord');

    // scheduled_checks: untouched by hatch-config re-init (no plugin-seeding logic remains)
    const ids = out.scheduled_checks.map((c: any) => c.id).sort();
    expect(ids).toEqual(['automation-recommender', 'my-custom-check'].sort());

    // routines: custom routine + heartbeat-restart + reflect preserved, morning/evening upserted once
    const routineIds = out.routines.map((r: any) => r.id);
    expect(routineIds).toEqual(['heartbeat-restart', 'reflect', 'custom-routine', 'morning', 'evening']);
    const morning = out.routines.find((r: any) => r.id === 'morning');
    const evening = out.routines.find((r: any) => r.id === 'evening');
    expect(morning.schedule).toBe('0 9 * * *');
    expect(evening.schedule).toBe('0 21 * * *');

    expect(out.boot_skill).toBe('/claude-code-dev-hermit:dev-boot');
    expect(out.agent_name).toBe('Aria2');
  });

  test('re-init: routines.enabled=false removes morning/evening, leaves other routines intact', async () => {
    const dir = freshDir();
    const seed = {
      ...JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')),
      routines: [
        { id: 'heartbeat-restart', schedule: '0 4 * * *', skill: 'claude-code-hermit:heartbeat start', run_during_waiting: true, enabled: true },
        { id: 'morning', schedule: '30 8 * * *', skill: 'claude-code-hermit:brief --morning', enabled: true, run_during_waiting: true },
        { id: 'evening', schedule: '30 22 * * *', skill: 'claude-code-hermit:brief --evening', enabled: true, run_during_waiting: true },
      ],
    };
    seedConfig(dir, seed);

    const r = await runHatchConfig(dir, { routines: { enabled: false } }, true);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
    expect(out.routines.map((x: any) => x.id)).toEqual(['heartbeat-restart']);
  });

  test('remote:false overlay applies (hasOwn, not truthiness)', async () => {
    const dir = freshDir();
    const r = await runHatchConfig(dir, { project_name: 'x', remote: false });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
    expect(out.remote).toBe(false);
  });

  test('re-init: explicit null overlay clears an existing scalar value', async () => {
    const dir = freshDir();
    const seed = { ...JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')), sign_off: 'previous sign-off' };
    seedConfig(dir, seed);
    const r = await runHatchConfig(dir, { sign_off: null }, true);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
    expect(out.sign_off).toBeNull();
  });

  test('invalid remote/idle_behavior values are rejected by validate(config); no file written', async () => {
    for (const answers of [
      { project_name: 'x', remote: 'yes' },
      { project_name: 'x', idle_behavior: 'bogus' },
    ]) {
      const dir = freshDir();
      const r = await runHatchConfig(dir, answers);
      expect(r.exitCode).not.toBe(0);
      expect(fs.existsSync(configPathFor(dir))).toBe(false);
    }
  });

  test('permission_mode is NOT enum-checked — an unrecognized value still passes (documented boundary)', async () => {
    const dir = freshDir();
    const r = await runHatchConfig(dir, { project_name: 'x', permission_mode: 'bogus' });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
    expect(out.permission_mode).toBe('bogus');
  });

  test('malformed existing config.json under --reinit is refused, bytes left unchanged', async () => {
    const dir = freshDir();
    const hermit = path.join(dir, '.claude-code-hermit');
    fs.mkdirSync(hermit, { recursive: true });
    const malformed = '{ not valid json !!';
    fs.writeFileSync(path.join(hermit, 'config.json'), malformed);

    const r = await runHatchConfig(dir, { agent_name: 'x' }, true);
    expect(r.exitCode).not.toBe(0);
    expect(fs.readFileSync(path.join(hermit, 'config.json'), 'utf8')).toBe(malformed);
  });

  test('malformed activated_hermit (missing or empty slug) is refused, no file written', async () => {
    for (const activated_hermit of [
      { version: '1.2.3' },                       // missing slug
      { slug: '', version: '1.2.3' },             // empty slug
    ]) {
      const dir = freshDir();
      const r = await runHatchConfig(dir, { project_name: 'x', activated_hermit });
      expect(r.exitCode).not.toBe(0);
      expect(fs.existsSync(configPathFor(dir))).toBe(false);
    }
  });

  test('activated_hermit with a stray version key is tolerated and not stamped', async () => {
    const dir = freshDir();
    const r = await runHatchConfig(dir, {
      project_name: 'x',
      activated_hermit: {
        slug: 'claude-code-dev-hermit', version: '9.9.9',
        boot_skill: '/claude-code-dev-hermit:dev-boot',
      },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
    expect(out._hermit_versions).toEqual({ 'claude-code-hermit': CORE_VERSION });
    expect(out.boot_skill).toBe('/claude-code-dev-hermit:dev-boot');
  });

  test('null channels payload is refused cleanly, not crashed', async () => {
    const dir = freshDir();
    const r = await runHatchConfig(dir, { project_name: 'x', channels: null });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('hatch-config:');
    expect(fs.existsSync(configPathFor(dir))).toBe(false);
  });

  test('an unknown answers key (e.g. a retired scheduled_checks_plugins) is ignored, not an error', async () => {
    const dir = freshDir();
    const r = await runHatchConfig(dir, { project_name: 'x', scheduled_checks_plugins: ['claude-md-management'] });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
    expect(out.scheduled_checks).toEqual([]);
  });

  test('a null per-channel entry is tolerated (treated as empty)', async () => {
    const dir = freshDir();
    const r = await runHatchConfig(dir, { project_name: 'x', channels: { discord: null } });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
    expect(out.channels.discord.enabled).toBe(true);
    expect(out.channels.discord.state_dir).toBe('.claude.local/channels/discord');
  });

  test('re-init: morning_brief_time=null disables an existing morning brief', async () => {
    const dir = freshDir();
    const seed = {
      ...JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')),
      channels: { discord: { enabled: true, dm_channel_id: 'D1', state_dir: '.claude.local/channels/discord', morning_brief: { enabled: true, time: '07:00' } } },
    };
    seedConfig(dir, seed);
    const r = await runHatchConfig(dir, { channels: { discord: { morning_brief_time: null } } }, true);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
    expect(out.channels.discord.morning_brief).toEqual({ enabled: false });
    expect(out.channels.discord.dm_channel_id).toBe('D1');
  });

  // /channel-setup writes a channels-only payload through --reinit to add a channel
  // to a hermit hatched with `channels: {}`. Creation (as opposed to merging onto an
  // existing entry) is the path that skill depends on.
  test('re-init: a channels-only payload creates an absent channel with full defaults', async () => {
    const dir = freshDir();
    const seed = {
      ...JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')),
      agent_name: 'Keeper',
      foo_custom: true,
      channels: {},
    };
    seedConfig(dir, seed);

    const r = await runHatchConfig(dir, { channels: { telegram: { enabled: true } } }, true);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));

    expect(out.channels.telegram).toEqual({
      enabled: true,
      dm_channel_id: null,
      default_chat_id: null,
      state_dir: '.claude.local/channels/telegram',
    });
    // nothing else moved
    expect(out.agent_name).toBe('Keeper');
    expect(out.foo_custom).toBe(true);
    expect(Object.keys(out.channels)).toEqual(['telegram']);
  });

  // Re-enabling a disabled channel must not clear state learned at pairing time.
  test('re-init: enabling a disabled channel preserves its learned state', async () => {
    const dir = freshDir();
    const seed = {
      ...JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')),
      channels: {
        telegram: {
          enabled: false,
          dm_channel_id: 'T42',
          default_chat_id: 'T42',
          state_dir: '.claude.local/channels/telegram',
          allowed_users: ['777'],
          settings_policy: 'ask',
        },
      },
    };
    seedConfig(dir, seed);

    const r = await runHatchConfig(dir, { channels: { telegram: { enabled: true } } }, true);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));

    expect(out.channels.telegram.enabled).toBe(true);
    expect(out.channels.telegram.dm_channel_id).toBe('T42');
    expect(out.channels.telegram.default_chat_id).toBe('T42');
    expect(out.channels.telegram.allowed_users).toEqual(['777']);
    expect(out.channels.telegram.state_dir).toBe('.claude.local/channels/telegram');
    // A leftover key rides the existing spread until hermit-evolve unsets it.
    expect(out.channels.telegram.settings_policy).toBe('ask');
  });

  test('re-init does not stamp the retired settings_policy key', async () => {
    const dir = freshDir();
    seedConfig(dir, {
      ...JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')),
      channels: {
        telegram: { enabled: false, dm_channel_id: 'T42', default_chat_id: 'T42', state_dir: '.claude.local/channels/telegram' },
      },
    });

    const r = await runHatchConfig(dir, { channels: { telegram: { enabled: true } } }, true);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));

    expect(out.channels.telegram.enabled).toBe(true);
    expect(out.channels.telegram.settings_policy).toBeUndefined();
  });

  test('a new entry is not stamped with settings_policy', async () => {
    const dir = freshDir();
    const r = await runHatchConfig(dir, {
      project_name: 'my-project',
      channels: {
        discord: { enabled: true },
      },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
    expect(out.channels.discord.settings_policy).toBeUndefined();
  });

});
