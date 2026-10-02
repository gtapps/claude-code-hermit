// The hermit's voice carrier: a native Claude Code output style.
//
// Claude Code builds `.claude/output-styles/<outputStyle>.md` into the SYSTEM
// PROMPT at session start, which is why tone lives here rather than in
// SessionStart context — the system prompt is re-read on every API call and
// survives compaction, while injected context ages and is dropped.
//
// Two surfaces need these values — apply-settings' voice-render op (which writes
// both artifacts) and the hermit-doctor check (which compares them to config) —
// so they are defined once here. The operator's answer itself lives in
// config.json's `voice` block; nothing in this file holds tone.

import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './cli';
import { defaultConfigDir } from './setup-token';

/** The style name, and therefore the basename of the file Claude Code loads. */
export const HERMIT_OUTPUT_STYLE = 'hermit-voice';

/**
 * The `outputStyle` value config's `voice` block resolves to, or null when the hermit
 * does not own the key.
 *
 * Null is the load-bearing case: it means the operator never answered the voice
 * question (or cleared it), so whatever they picked in /config is theirs and the
 * render leaves the settings key alone. `custom` is the only value that implies a
 * file — every other one names a style Claude Code ships.
 */
export function outputStyleFor(voice: unknown): string | null {
  const style = (voice as { style?: unknown } | null | undefined)?.style;
  if (typeof style !== 'string' || style.trim() === '') return null;
  return style === 'custom' ? HERMIT_OUTPUT_STYLE : style;
}

/** Project-relative path of the style file hatch renders. */
export const VOICE_FILE_REL = path.join(
  '.claude',
  'output-styles',
  `${HERMIT_OUTPUT_STYLE}.md`,
);

/** Does this project carry the hermit's voice file? */
export function voiceFileExists(projectRoot = '.'): boolean {
  return fs.existsSync(path.join(projectRoot, VOICE_FILE_REL));
}

/** Persisted-settings scopes that can set outputStyle, in Claude Code's precedence order. */
const PROJECT_SETTINGS_SCOPES = ['.claude/settings.local.json', '.claude/settings.json'] as const;
const USER_SETTINGS_SCOPE = 'user' as const;
const SETTINGS_SCOPES = [...PROJECT_SETTINGS_SCOPES, USER_SETTINGS_SCOPE] as const;

export type PersistedStyle = {
  /** The winning outputStyle value, or null when no persisted scope sets one. */
  value: string | null;
  /** Which scope supplied it. */
  source: typeof SETTINGS_SCOPES[number] | null;
};

// readJson returns null for a missing, unreadable or malformed file, so a broken
// settings file falls through to the next scope rather than taking the whole
// check down.
function readOutputStyle(settingsFile: string): string | null {
  const value = readJson(settingsFile)?.outputStyle;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The two project scopes, local over project — the half of the precedence chain
 * that outranks user scope. Only resolvePersistedStyle calls it. */
function resolveProjectStyle(projectRoot = '.'): PersistedStyle {
  for (const rel of PROJECT_SETTINGS_SCOPES) {
    const value = readOutputStyle(path.join(projectRoot, rel));
    if (value !== null) return { value, source: rel };
  }
  return { value: null, source: null };
}

/**
 * Resolve the outputStyle a session in `projectRoot` reads from disk, across every
 * persisted scope in Claude Code's precedence order: local, then project, then user.
 *
 * This is the reporting question — "what is this install actually going to use?" —
 * and is for hermit-doctor, not for deciding whether to write. It does NOT see
 * managed settings or a launch-time `--settings` overlay; both outrank every scope
 * here, and hermitd-start ships such an overlay for the classifier, so this reports
 * what is persisted, not necessarily what a given session's system prompt ends up
 * using.
 */
export function resolvePersistedStyle(projectRoot = '.'): PersistedStyle {
  const project = resolveProjectStyle(projectRoot);
  if (project.value !== null) return project;
  const userValue = readOutputStyle(path.join(defaultConfigDir(), 'settings.json'));
  if (userValue !== null) return { value: userValue, source: USER_SETTINGS_SCOPE };
  return { value: null, source: null };
}
