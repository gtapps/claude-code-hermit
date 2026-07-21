// Pane-stream parsing for the setup-token mint driver.
//
// The fixtures below are the shapes `claude setup-token` actually produced in a
// tmux pane (captured live against CC 2.1.216), not invented ones. That matters:
// the reason this code reads an escape sequence instead of the visible text is
// that the visible copy of the URL is hard-wrapped and truncated mid-string, so
// scraping what a human sees yields a broken sign-in link.

import { describe, expect, test } from 'bun:test';
import { extractToken, extractUrl, findAck, findCode } from '../scripts/setup-token-mint';

const FULL_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=user%3Ainference&code_challenge=7Y59PHdULkTsKkXw-NE-XnzFSVjcJ4cNhsjYPe7T5OM' +
  '&code_challenge_method=S256&state=6DeG9yq3qjtEYPN1PJaGnMnskjpXeN5UFqMOkii_FjM';

/** OSC-8 hyperlink: complete URL as the target, truncated copy as visible text. */
const TRUNCATED_VISIBLE = FULL_URL.slice(0, 140);
const PANE_STREAM =
  '\x1b[2m Browser didn\'t open? Use the url below to sign in (c to copy)\x1b[0m\r\n' +
  `\x1b]8;;${FULL_URL}\x07${TRUNCATED_VISIBLE}\x1b]8;;\x07\r\n` +
  ' Paste code here if prompted > \r\n';

const TOKEN = 'sk-ant-oat01-QWERTYuiop1234567890asdfghjklZXCVBNM-_abcdefghij';

describe('extractUrl', () => {
  test('recovers the complete URL from the hyperlink target', () => {
    expect(extractUrl(PANE_STREAM)).toBe(FULL_URL);
  });

  test('never returns the truncated visible copy', () => {
    const url = extractUrl(PANE_STREAM)!;
    expect(url).not.toBe(TRUNCATED_VISIBLE);
    // A URL missing its state parameter is unusable — that is exactly what the
    // wrapped visible text loses.
    expect(url).toContain('state=');
  });

  test('falls back to plain text when there is no hyperlink escape', () => {
    expect(extractUrl(`sign in here: ${FULL_URL}\r\n`)).toBe(FULL_URL);
  });

  test('ignores non-oauth URLs and returns null when there is nothing yet', () => {
    expect(extractUrl('Loading https://claude.com/docs ...')).toBeNull();
    expect(extractUrl('')).toBeNull();
    expect(extractUrl('\x1b[2mstarting\x1b[0m\r\n')).toBeNull();
  });

  test('strips trailing punctuation that is not part of the link', () => {
    expect(extractUrl(`open (${FULL_URL}).`)).toBe(FULL_URL);
  });
});

describe('extractToken', () => {
  test('finds the minted token in the stream', () => {
    expect(extractToken(`${PANE_STREAM}\r\n${TOKEN}\r\n`)).toBe(TOKEN);
  });

  test('returns null before the token prints', () => {
    expect(extractToken(PANE_STREAM)).toBeNull();
  });

  test('takes the last token printed', () => {
    const older = 'sk-ant-oat01-OLDEROLDEROLDEROLDEROLDER123456';
    expect(extractToken(`${older}\r\nreissued\r\n${TOKEN}\r\n`)).toBe(TOKEN);
  });

  test('ignores fragments too short to be a real token', () => {
    expect(extractToken('sk-ant-oat01-abc\r\n')).toBeNull();
  });
});

describe('channel reply matching', () => {
  test('ack matches the word regardless of casing or surrounding prose', () => {
    expect(findAck([{ text: 'reauth' }])).toBe(true);
    expect(findAck([{ text: 'ok Reauth now please' }])).toBe(true);
    expect(findAck([{ text: 'what is going on?' }])).toBe(false);
    expect(findAck([])).toBe(false);
  });

  test('code picks the pasted value and skips the ack and prose', () => {
    expect(findCode([{ text: 'reauth' }, { text: 'ABC-123-XYZ' }])).toBe('ABC-123-XYZ');
    expect(findCode([{ text: 'reauth' }])).toBeNull();
    // A sentence is the operator talking, not a code.
    expect(findCode([{ text: 'I opened the link but nothing happened yet' }])).toBeNull();
  });
});
