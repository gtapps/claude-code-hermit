// Each command's spec, help slot and handler live in one record, so none of
// the three can be added without the others.

import { expect, test } from 'bun:test';

import { COMMANDS, HA_COMMANDS } from '../src/cli';

const KEY = /^(boot|ha) [a-z][a-z0-9-]*$/;

test('every record is complete and self-consistent', () => {
  const keys = Object.keys(COMMANDS);
  expect(keys.length).toBeGreaterThan(0);

  for (const key of keys) {
    const record = COMMANDS[key]!;
    expect(key).toMatch(KEY);
    expect(record.spec.prog).toBe(`ha_agent_lab ${key}`);
    expect(record.spec.usage.startsWith(`usage: ha_agent_lab ${key}`)).toBe(true);
    expect(Array.isArray(record.spec.positionals)).toBe(true);
    expect(typeof record.spec.flags).toBe('object');
    expect(typeof record.help).toBe('string');
    expect(typeof record.run).toBe('function');
    // A help block, when present, must describe its own command: argparse
    // opens the block with the command name in the description column.
    if (record.help) {
      const name = key.slice(key.indexOf(' ') + 1);
      expect(record.help.split('\n')[0]!.startsWith(`    ${name}`)).toBe(true);
    }
  }
});

test('HA_COMMANDS is exactly the ha half of the table, in table order', () => {
  const fromTable = Object.keys(COMMANDS)
    .filter((key) => key.startsWith('ha '))
    .map((key) => key.slice(3));
  expect(HA_COMMANDS).toEqual(fromTable);
  expect(new Set(HA_COMMANDS).size).toBe(HA_COMMANDS.length);
});

test('both boot commands are present', () => {
  expect(Object.keys(COMMANDS)).toContain('boot status');
  expect(Object.keys(COMMANDS)).toContain('boot store');
});
