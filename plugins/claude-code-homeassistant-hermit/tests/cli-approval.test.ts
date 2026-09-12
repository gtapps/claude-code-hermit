import { test, expect, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decision } from '../hooks/cli-approval';
import { shellCommands } from '../hooks/shell-words';
import { safetyMode, clearPolicyCaches } from '../src/policy';
import { tmpPath, cleanupTmp } from './helpers';
afterAll(cleanupTmp);
function fixture(mode?: string) {
  const root = tmpPath('cli-approval-'); mkdirSync(join(root, '.claude-code-hermit'), { recursive: true });
  writeFileSync(join(root, '.claude-code-hermit/config.json'), JSON.stringify(mode ? { ha_safety_mode: mode } : {})); return root;
}
test('valid config defaults to ask; invalid config stays strict', () => {
  const root = fixture(); expect(safetyMode(root)).toBe('ask');
  writeFileSync(join(root, '.claude-code-hermit/config.json'), '{"ha_safety_mode":null}'); clearPolicyCaches(); expect(safetyMode(root)).toBe('strict');
  writeFileSync(join(root, '.claude-code-hermit/config.json'), '{bad'); clearPolicyCaches(); expect(safetyMode(root)).toBe('strict');
});
test('service targeting reuses policy without a confirmation flag', async () => {
  const root = fixture();
  const cmd = (entity: string) => `"/plugin/bin/ha-agent-lab" ha call-service homeassistant.turn_on --data '{"entity_id":"${entity}"}'`;
  expect((await decision(cmd('lock.front'), root, root))?.decision).toBe('ask');
  expect(await decision(cmd('light.room'), root, root)).toBeNull();
  expect((await decision(`/plugin/bin/ha-agent-lab ha call-service homeassistant.turn_on --data '{"area_id":"room"}'`, root, root))?.decision).toBe('deny');
  const strict = fixture('strict'); expect((await decision(cmd('lock.front'), strict, strict))?.decision).toBe('deny');
  expect(await decision('git status', root, root)).toBeNull();
  expect(await decision('echo ' + cmd('lock.front'), root, root)).toBeNull();
});
test('snapshot approval depends on entities and does not execute restoration', async () => {
  const root = fixture();
  const file = join(root, 'snapshot.json');
  writeFileSync(file, JSON.stringify({ name: 'test', generated: 'now', entities: { 'lock.front': { state: 'locked', attributes: {} } } }));
  expect((await decision(`/plugin/bin/ha-agent-lab ha restore-states "${file}"`, root, root))?.decision).toBe('ask');
  writeFileSync(file, JSON.stringify({ name: 'test', generated: 'now', entities: { 'light.room': { state: 'on', attributes: {} } } }));
  expect(await decision(`/plugin/bin/ha-agent-lab ha restore-states "${file}"`, root, root)).toBeNull();
});

test('wrapped service calls retain native approval and policy denials', async () => {
  const root = fixture();
  const strict = fixture('strict');
  for (const executable of [
    'FOO=bar /plugin/bin/ha-agent-lab',
    'FOO=bar bun /plugin/claude-code-homeassistant-hermit/src/cli.ts',
    'bun run /plugin/claude-code-homeassistant-hermit/src/cli.ts',
    'bun src/cli.ts',
    'bun run "src/cli.ts"',
    'FOO=bar OTHER="two words" bun run /plugin/claude-code-homeassistant-hermit/src/cli.ts',
    // The command string reaches the hook unexpanded, so the documented
    // ${CLAUDE_PLUGIN_ROOT} form never carries the plugin directory name.
    'bun ${CLAUDE_PLUGIN_ROOT}/src/cli.ts',
    // Line continuation and nested commands must not hide the invocation.
    '/plugin/bin/ha-agent-lab \\\n ',
    '( /plugin/bin/ha-agent-lab',
  ]) {
    const command = `${executable} ha call-service lock.lock --data '{"entity_id":"lock.front"}'`;
    expect((await decision(command, root, root))?.decision).toBe('ask');
    expect((await decision(command, strict, strict))?.decision).toBe('deny');
  }
});

test('snapshot decisions request approval and preserve denials', async () => {
  const root = fixture();
  const strict = fixture('strict');
  const file = join(root, 'snapshot.json');
  writeFileSync(file, JSON.stringify({ name: 'test', generated: 'now', entities: { 'lock.front': { state: 'locked', attributes: {} } } }));
  const command = `FOO=bar bun run /plugin/claude-code-homeassistant-hermit/src/cli.ts ha restore-states "${file}"`;
  expect((await decision(command, root, root))?.decision).toBe('ask');
  expect((await decision(command, strict, strict))?.decision).toBe('deny');
});


test('redirections preserve service approval and denial decisions', async () => {
  const root = fixture();
  const strict = fixture('strict');
  const safe = '/plugin/bin/ha-agent-lab ha call-service homeassistant.reload_core_config';
  const sensitive = `/plugin/bin/ha-agent-lab ha call-service lock.lock --data '{"entity_id":"lock.front"}'`;
  for (const redirection of [
    '> /tmp/result.json', '>/tmp/result.json', '>>/tmp/result.json',
    '2> /tmp/errors.log', '2>>/tmp/errors.log', '> /tmp/result.json 2>&1',
    '&>/tmp/result.json', '&>>/tmp/result.json', '>"/tmp/a > b.json"',
    '< /tmp/input.json', '0<&3', '2>&-', '>|/tmp/result.json',
  ]) {
    expect(await decision(`${safe} ${redirection}`, root, root)).toBeNull();
    expect((await decision(`${sensitive} ${redirection}`, root, root))?.decision).toBe('ask');
    expect((await decision(`${sensitive} ${redirection}`, strict, strict))?.decision).toBe('deny');
  }
  expect(await decision(`>/tmp/result.json ${safe}`, root, root)).toBeNull();
  expect((await decision(`${sensitive} >result.json`, root, root))?.decision).toBe('ask');
  expect((await decision(`${safe} >/tmp/result.json; ${sensitive}`, strict, strict))?.decision).toBe('deny');
});

test('redirected snapshot restoration still requests approval', async () => {
  const root = fixture();
  const file = join(root, 'snapshot > original.json');
  writeFileSync(file, JSON.stringify({ entities: { 'lock.front': { state: 'locked', attributes: {} } } }));
  expect((await decision(`/plugin/bin/ha-agent-lab ha restore-states "${file}" >/tmp/result.json`, root, root))?.decision).toBe('ask');
});

test('redirection tokenization preserves quoted arguments and rejects missing targets', () => {
  expect(shellCommands(`cmd --data '{"value":"a > b"}' 2>/tmp/error.log`)).toEqual([['cmd', '--data', '{"value":"a > b"}']]);
  expect(shellCommands(`cmd "2">/tmp/result.json`)).toEqual([['cmd', '2']]);
  expect(shellCommands(`cmd '>' /tmp/result.json`)).toEqual([['cmd', '>', '/tmp/result.json']]);
  for (const command of ['cmd >', 'cmd > ; next', 'cmd > > file', 'cmd <<EOF']) {
    expect(() => shellCommands(command)).toThrow();
  }
});

test('update approval requires eligibility and never overrides a sensitive denial', async () => {
  for (const mode of ['ask', 'strict']) {
    const root = fixture(mode);
    const command = `/plugin/bin/ha-agent-lab ha call-service update.install --data '{"entity_id":"update.core"}'`;
    expect((await decision(command, root, root))?.decision).toBe('deny');
    writeFileSync(join(root, '.claude-code-hermit/config.json'), JSON.stringify({ ha_safety_mode: mode, ha_update_auto_apply: true }));
    clearPolicyCaches();
    expect((await decision(command, root, root))?.decision).toBe('ask');
    const mixed = command.replace('"update.core"', '["update.core","lock.front"]');
    expect((await decision(mixed, root, root))?.decision).toBe(mode === 'strict' ? 'deny' : 'ask');
  }
});

test('malformed snapshot targets fail closed before restoration', async () => {
  const root = fixture();
  const file = join(root, 'invalid.json');
  writeFileSync(file, JSON.stringify({ entities: { '.lock': { state: 'locked' } } }));
  await expect(decision(`/plugin/bin/ha-agent-lab ha restore-states "${file}"`, root, root)).rejects.toThrow('Unresolvable snapshot targets');
});
