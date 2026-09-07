import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, checkVoiceCarrier } from '../scripts/doctor-check';
import { freshDirFactory } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-voice-carrier-');
afterAll(cleanup);

type Fixture = { overlay?: any; voiceFile?: boolean; local?: any; project?: any; user?: any; voice?: any };

// checkVoiceCarrier runs in-process and resolvePersistedStyle() reads
// CLAUDE_CONFIG_DIR/settings.json for the user scope — so every scenario pins
// CLAUDE_CONFIG_DIR to an isolated directory for the duration of the call and
// restores it after. Without this, these tests would read whatever real
// ~/.claude/settings.json happens to exist on the machine running the suite.
function scenario({ voiceFile, local, project, user, voice, overlay }: Fixture) {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, '.claude-code-hermit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-code-hermit', 'config.json'),
    JSON.stringify(voice === undefined ? {} : { voice }, null, 2),
  );

  if (overlay !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude-code-hermit/state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-code-hermit/state/claude-settings.overlay.json'), JSON.stringify(overlay));
  }
  if (voiceFile) {
    fs.mkdirSync(path.join(dir, '.claude', 'output-styles'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude', 'output-styles', 'hermit-voice.md'),
      '---\nname: hermit-voice\n---\n',
    );
  }
  const writeSettings = (name: string, value: any) =>
    fs.writeFileSync(path.join(dir, '.claude', name), JSON.stringify(value, null, 2));

  if (local !== undefined) writeSettings('settings.local.json', local);
  if (project !== undefined) writeSettings('settings.json', project);

  const userConfigDir = freshDir();
  if (user !== undefined) {
    fs.writeFileSync(path.join(userConfigDir, 'settings.json'), JSON.stringify(user, null, 2));
  }

  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = userConfigDir;
  try {
    return checkVoiceCarrier(resolvePaths(path.join(dir, '.claude-code-hermit'), PLUGIN_ROOT));
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  }
}

// config.voice is the operator's answer and the rendered outputStyle (plus, for a
// custom voice, the style file) is its render. This check compares the two, so a
// warn means "not rendered yet" — a hermit that has not restarted since the change,
// or something outside the hermit holding the key. An unset voice is not the
// hermit's key at all, so whatever is persisted is simply reported.
describe('doctor voice-carrier check', () => {
  test('a hermit that never answered the voice question is healthy, not nagged', () => {
    const r = scenario({});
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('no voice configured');
  });

  test("with no voice configured, the operator's own style is reported as theirs", () => {
    const r = scenario({ local: { outputStyle: 'Explanatory' } });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('Explanatory');
    expect(r.detail).toContain('your own');
  });

  test('a built-in this hermit never renders is still just reported, never warned about', () => {
    const r = scenario({ user: { outputStyle: 'Learning' } });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('Learning');
    expect(r.detail).toContain('user');
  });

  test('a configured built-in that is rendered reports the voice active', () => {
    const r = scenario({ voice: { style: 'Concise' }, overlay: { outputStyle: 'Concise' } });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('voice active');
    expect(r.detail).toContain('Concise');
  });

  test('the lowercase Default literal round-trips', () => {
    const r = scenario({ voice: { style: 'default' }, overlay: { outputStyle: 'default' } });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('voice active');
  });

  test('a custom voice with both halves present is active', () => {
    const r = scenario({
      voice: { style: 'custom', prose: 'Short answers.' },
      voiceFile: true,
      overlay: { outputStyle: 'hermit-voice' },
    });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('voice active');
    expect(r.detail).toContain('hermit-voice.md');
  });

  // The everyday case after a chat-driven change: config moved, the hermit has
  // not restarted, so the render has not happened yet.
  test('config changed but not yet rendered is a warn naming both values', () => {
    const r = scenario({ voice: { style: 'Concise' }, overlay: { outputStyle: 'default' } });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('Concise');
    expect(r.detail).toContain('default');
    expect(r.detail).toContain('restart');
  });

  test('a configured voice with no key at all is flagged', () => {
    const r = scenario({ voice: { style: 'Concise' }, local: {} });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('unset');
  });

  test('a custom voice whose style file went missing is flagged', () => {
    const r = scenario({
      voice: { style: 'custom', prose: 'Short answers.' },
      overlay: { outputStyle: 'hermit-voice' },
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('missing');
  });

  // A built-in voice deliberately leaves any earlier hermit-voice.md on disk —
  // it is inert, and warning about it every run was the old check's worst habit.
  test('a leftover voice file alongside a built-in voice is not a warning', () => {
    const r = scenario({ voice: { style: 'Concise' }, voiceFile: true, overlay: { outputStyle: 'Concise' } });
    expect(r.status).toBe('ok');
  });

  // The case a target-file-only check would miss entirely: the hermit's own
  // committed settings look correct while a /config pick in local scope outranks them.
  test('a local-scope override beats the hermit key in committed settings', () => {
    const r = scenario({
      voice: { style: 'custom', prose: 'Short answers.' },
      voiceFile: true,
      project: { outputStyle: 'hermit-voice' },
      overlay: { outputStyle: 'Explanatory' },
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('Explanatory');
    expect(r.detail).toContain('launch overlay');
  });

  test('project scope still wins when local sets no style', () => {
    const r = scenario({
      voice: { style: 'custom', prose: 'Short answers.' },
      voiceFile: true,
      overlay: { outputStyle: 'hermit-voice' },
      local: { env: { FOO: 'bar' } },
    });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('launch overlay');
  });

  test('both project files win over a user-scope style', () => {
    const r = scenario({
      voice: { style: 'custom', prose: 'Short answers.' },
      voiceFile: true,
      overlay: { outputStyle: 'hermit-voice' },
      user: { outputStyle: 'Concise' },
    });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('launch overlay');
  });

  test('an unparseable settings file does not throw the check', () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.claude-code-hermit'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{ broken');
    fs.writeFileSync(path.join(dir, '.claude-code-hermit', 'config.json'), '{}');

    const userConfigDir = freshDir();
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    try {
      const r = checkVoiceCarrier(resolvePaths(path.join(dir, '.claude-code-hermit'), PLUGIN_ROOT));
      expect(r.status).toBe('ok');
    } finally {
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    }
  });
});
