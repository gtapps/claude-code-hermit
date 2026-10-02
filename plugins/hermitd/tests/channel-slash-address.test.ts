import { describe, test, expect } from 'bun:test';

import { resolveSlashCommand } from '../scripts/lib/channel-slash-address';

/** Most cases care about only one half of the identity; naming both at every
 *  call site would bury which half the case is actually about. */
const bot = (username: string | null, userId: string | null = null) => ({ username, userId });

const SELF_ID = '1503162355876499589';

describe('resolveSlashCommand — slash gating', () => {
  test('resolves an unsuffixed command with an empty rest', () => {
    expect(resolveSlashCommand('!pause', bot('ourbot'))).toEqual({ command: '/pause', rest: '' });
    expect(resolveSlashCommand('!resume', bot(null))).toEqual({ command: '/resume', rest: '' });
  });

  test('lowercases the command head', () => {
    expect(resolveSlashCommand('!PAUSE', bot(null))).toEqual({ command: '/pause', rest: '' });
  });

  test('rejects a body that is not a slash command', () => {
    // The whole point of the change: a bare control word must not resolve.
    expect(resolveSlashCommand('pause', bot('ourbot'))).toBeNull();
    expect(resolveSlashCommand('stop', bot('ourbot'))).toBeNull();
    expect(resolveSlashCommand('status', bot('ourbot'))).toBeNull();
    expect(resolveSlashCommand('snooze 2h', bot('ourbot'))).toBeNull();
    expect(resolveSlashCommand('please !pause the build', bot('ourbot'))).toBeNull();
    expect(resolveSlashCommand('/pause', bot('ourbot'))).toBeNull();
    expect(resolveSlashCommand('/pause@ourbot', bot('ourbot'))).toBeNull();
    expect(resolveSlashCommand(`<@${SELF_ID}> /pause`, bot('ourbot', SELF_ID))).toBeNull();
    expect(resolveSlashCommand('', bot('ourbot'))).toBeNull();
  });

  test('trims surrounding whitespace before matching', () => {
    expect(resolveSlashCommand('  !pause  ', bot(null))).toEqual({ command: '/pause', rest: '' });
  });
});

describe('resolveSlashCommand — rest is byte-for-byte', () => {
  test('preserves multiple spaces before an argument', () => {
    // pause-keyword's own grammar accepts `\s+` before a snooze duration; a
    // shared tokenizer that split on a single space would silently narrow it.
    expect(resolveSlashCommand('!snooze  2h', bot(null))).toEqual({ command: '/snooze', rest: '  2h' });
  });

  test('preserves argument case', () => {
    expect(resolveSlashCommand('!model Opus[1m]', bot(null))).toEqual({
      command: '/model', rest: ' Opus[1m]',
    });
  });

  test('preserves a tab separator', () => {
    expect(resolveSlashCommand('!snooze\t2h', bot(null))).toEqual({ command: '/snooze', rest: '\t2h' });
  });
});

describe('resolveSlashCommand — @botname addressing', () => {
  test('accepts a suffix naming this bot', () => {
    expect(resolveSlashCommand('!pause@ourbot', bot('ourbot'))).toEqual({ command: '/pause', rest: '' });
  });

  test('matches the handle case-insensitively', () => {
    expect(resolveSlashCommand('!pause@OurBot', bot('ourbot'))).toEqual({ command: '/pause', rest: '' });
    expect(resolveSlashCommand('!pause@ourbot', bot('OurBot'))).toEqual({ command: '/pause', rest: '' });
  });

  test('the stored handle is bare — no leading @ — matching channel-bot-id.ts', () => {
    // channel-reply-reminder.ts prepends the '@' itself when matching mentions,
    // so the config value carries no '@'. Comparing against a stored '@handle'
    // would never match and every suffixed command would silently no-op.
    expect(resolveSlashCommand('!pause@ourbot', bot('ourbot'))).not.toBeNull();
  });

  test('tolerates a hand-set @handle in config', () => {
    expect(resolveSlashCommand('!pause@ourbot', bot('@ourbot'))).toEqual({ command: '/pause', rest: '' });
  });

  test('rejects a suffix naming a different bot', () => {
    expect(resolveSlashCommand('!pause@otherbot', bot('ourbot'))).toBeNull();
    expect(resolveSlashCommand('!clear@otherbot', bot('ourbot'))).toBeNull();
  });

  test('rejects any suffix when the handle is unknown', () => {
    expect(resolveSlashCommand('!pause@ourbot', bot(null))).toBeNull();
    expect(resolveSlashCommand('!pause@ourbot', bot(''))).toBeNull();
  });

  test('rejects an empty suffix', () => {
    expect(resolveSlashCommand('!pause@', bot('ourbot'))).toBeNull();
    expect(resolveSlashCommand('!pause@', bot(null))).toBeNull();
  });

  test('keeps the argument when the command is addressed', () => {
    expect(resolveSlashCommand('!snooze@ourbot 2h', bot('ourbot'))).toEqual({
      command: '/snooze', rest: ' 2h',
    });
  });

  test('an @ in the argument is not an address', () => {
    expect(resolveSlashCommand('!model opus@1m', bot('ourbot'))).toEqual({
      command: '/model', rest: ' opus@1m',
    });
  });
});

describe('resolveSlashCommand — leading self-mention addressing', () => {
  test('strips a Discord mention of this bot', () => {
    // A mention-gated server channel delivers the mention verbatim, so without
    // this every control command there is inert.
    expect(resolveSlashCommand(`<@${SELF_ID}> !pause`, bot(null, SELF_ID))).toEqual({
      command: '/pause', rest: '',
    });
  });

  test('strips the older <@!id> nickname form', () => {
    expect(resolveSlashCommand(`<@!${SELF_ID}> !resume`, bot(null, SELF_ID))).toEqual({
      command: '/resume', rest: '',
    });
  });

  test('rest survives the mention byte-for-byte', () => {
    // Only the mention and the whitespace it left behind come off; the
    // argument grammar downstream still sees what the operator typed.
    expect(resolveSlashCommand(`<@${SELF_ID}>  !snooze  2h`, bot(null, SELF_ID))).toEqual({
      command: '/snooze', rest: '  2h',
    });
  });

  test('rejects a mention of anybody else', () => {
    expect(resolveSlashCommand('<@999999999999999999> !pause', bot(null, SELF_ID))).toBeNull();
  });

  test('rejects any mention when the id is unknown', () => {
    expect(resolveSlashCommand(`<@${SELF_ID}> !pause`, bot('ourbot', null))).toBeNull();
  });

  test('a role mention carrying our digits is not our mention', () => {
    // `<@&id>` addresses a role, not this account. The inner text is compared
    // whole, so the leading '&' is what rejects it.
    expect(resolveSlashCommand(`<@&${SELF_ID}> !pause`, bot(null, SELF_ID))).toBeNull();
  });

  test('strips a Telegram @handle mention, case-insensitively', () => {
    // Telegram mentions carry the handle as plain text, never the numeric id.
    expect(resolveSlashCommand('@ourbot !pause', bot('ourbot'))).toEqual({
      command: '/pause', rest: '',
    });
    expect(resolveSlashCommand('@OurBot !pause', bot('ourbot'))).toEqual({
      command: '/pause', rest: '',
    });
  });

  test('rejects a handle mention of a different bot', () => {
    expect(resolveSlashCommand('@otherbot !pause', bot('ourbot'))).toBeNull();
    // Compared as a whole token, so a handle that merely starts with ours misses.
    expect(resolveSlashCommand('@ourbotx !pause', bot('ourbot'))).toBeNull();
  });

  test('a mention with no command is not a command', () => {
    expect(resolveSlashCommand(`<@${SELF_ID}>`, bot(null, SELF_ID))).toBeNull();
    expect(resolveSlashCommand('@ourbot', bot('ourbot'))).toBeNull();
  });

  test('a mention does not rescue a bare control word', () => {
    // Addressing the hermit is not the same as issuing a command — the slash
    // rule this PR introduced must survive being mentioned.
    expect(resolveSlashCommand(`<@${SELF_ID}> pause`, bot(null, SELF_ID))).toBeNull();
    expect(resolveSlashCommand(`<@${SELF_ID}> stop`, bot(null, SELF_ID))).toBeNull();
  });

  test('only one mention is stripped', () => {
    // Which bot a two-mention message addresses is not ours to guess, so it
    // reaches the model as prose instead.
    expect(
      resolveSlashCommand(`<@${SELF_ID}> <@999999999999999999> !pause`, bot(null, SELF_ID)),
    ).toBeNull();
  });

  test('the mention must be leading', () => {
    expect(resolveSlashCommand(`look at <@${SELF_ID}> !pause`, bot(null, SELF_ID))).toBeNull();
  });

  test('a mention prefix and an @botname suffix compose', () => {
    expect(resolveSlashCommand(`<@${SELF_ID}> !pause@ourbot`, bot('ourbot', SELF_ID))).toEqual({
      command: '/pause', rest: '',
    });
  });
});
