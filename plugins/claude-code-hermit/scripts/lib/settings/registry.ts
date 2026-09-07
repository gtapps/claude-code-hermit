// The scalar/enum settings registry — one row per `/hermit-settings <argument>`
// that resolves to a single config.json leaf.
//
// It replaces two drifting copies: a ~45-line *example* settings dump in
// hermit-settings/SKILL.md whose field list went stale every release, and the
// per-argument prose that spelled out each dotted path by hand. `show` renders
// live values from these rows, and the skill's argument table is generated from
// the same rows, so a new setting is one entry here rather than three edits.
//
// Deliberately NOT in here: the arguments whose work is not "write one leaf" —
// `channels`, `routines`, `env`, `compact`, `docker`, `scheduled-checks` (session checks),
// `brief`, `heartbeat`, `watchdog` (arrays, key deletes, multi-field wizards),
// and `quality-gate` / `artifact-authorization` (bounded asks with a channel
// re-entry path). Those keep their prose in the skill. `language` has a row
// because `show` must render it, but the skill keeps its prose too — changing it
// retranslates `state/artifact-strings.json`, which no table can express.

import { AUTH_MODE, ESCALATION, PERMISSION_MODE, QUALITY_GATE_TIER, VOICE_STYLE } from './enums';

export type Kind = 'string' | 'boolean' | 'enum' | 'int';

export interface Setting {
  /** The `/hermit-settings <arg>` token. */
  arg: string;
  /** Dotted path into config.json. */
  path: string;
  kind: Kind;
  /** Allowed values for `kind: 'enum'`. */
  values?: readonly string[];
  /** Whether 'none'/'clear' is meaningful (maps to null). */
  nullable?: boolean;
  group: 'Identity' | 'Operational' | 'Artifacts';
  label: string;
  /** One line telling the operator what they're choosing. */
  hint: string;
  /** When the change takes effect, if not immediately. */
  applies?: string;
  /** Rendered by `show` but not settable through the table (side effects, or read-only). */
  tableExempt?: boolean;
}

export const SETTINGS: readonly Setting[] = [
  { arg: 'name', path: 'agent_name', kind: 'string', nullable: true, group: 'Identity',
    label: 'Agent name', hint: "any string, or 'none' to clear" },
  { arg: 'language', path: 'language', kind: 'string', nullable: true, group: 'Identity',
    label: 'Language', hint: 'locale code (en, pt, es, fr)', tableExempt: true,
    applies: 'also regenerates the artifact chrome translation table' },
  { arg: 'timezone', path: 'timezone', kind: 'string', nullable: true, group: 'Identity',
    label: 'Timezone', hint: 'IANA tz (UTC, Europe/Lisbon, America/New_York)' },
  { arg: 'escalation', path: 'escalation', kind: 'enum', values: ESCALATION, group: 'Identity',
    label: 'Escalation', hint: 'how much it acts without asking' },
  // `custom` needs voice.prose written first and renders a file, so the skill keeps
  // its own branch — but the row is real: `show` renders it, and `apply-known voice
  // <style>` is how the branch writes a built-in.
  { arg: 'voice', path: 'voice.style', kind: 'enum', values: VOICE_STYLE, nullable: true,
    group: 'Identity', label: 'Voice', hint: 'how it talks to you', tableExempt: true,
    applies: 'next session (a terminal run renders it now; boot renders it otherwise)' },

  { arg: 'remote', path: 'remote', kind: 'boolean', group: 'Operational',
    label: 'Remote control', hint: 'connect from claude.ai/code or phone',
    applies: 'next hermit-start' },
  { arg: 'auth-mode', path: 'auth_mode', kind: 'enum', values: AUTH_MODE, nullable: true,
    group: 'Operational', label: 'Auth method',
    hint: "login (claude.ai sign-in, renew ~monthly) or token (long-lived, renew yearly)",
    applies: 'run /relogin to sign in with the new method' },
  { arg: 'model', path: 'model', kind: 'string', nullable: true, group: 'Operational',
    label: 'Model', hint: "model name passed straight to --model, or 'none' for the Claude Code default",
    applies: 'next hermit-start' },
  { arg: 'boot-skill', path: 'boot_skill', kind: 'string', nullable: true, group: 'Operational',
    label: 'Boot skill', hint: "namespaced skill run at always-on launch, or 'none' for /claude-code-hermit:session",
    applies: 'next hermit-start' },
  { arg: 'permissions', path: 'permission_mode', kind: 'enum', values: PERMISSION_MODE,
    group: 'Operational', label: 'Permission mode', hint: 'how much Claude Code asks before acting',
    applies: 'next hermit-start' },
  { arg: 'push-notifications', path: 'push_notifications', kind: 'boolean', group: 'Operational',
    label: 'Push notifications', hint: 'doorbell when no channel is reachable' },
  { arg: 'quality-gate', path: 'quality_gate.tier', kind: 'enum', values: QUALITY_GATE_TIER,
    group: 'Operational', label: 'Quality gate', hint: 'cleanup pass after an accepted-proposal build',
    tableExempt: true },
  { arg: 'reflection', path: 'reflection.graduation_min_sessions', kind: 'int', group: 'Operational',
    label: 'Graduation threshold', hint: 'distinct sessions before a pattern becomes a proposal candidate',
    applies: 'next reflect run' },

  { arg: 'artifact-dashboard', path: 'artifacts.dashboard', kind: 'boolean', group: 'Artifacts',
    label: 'Dashboard page', hint: 'status, proposal queue, weekly evolution' },
  { arg: 'artifact-proposals', path: 'artifacts.proposals', kind: 'boolean', group: 'Artifacts',
    label: 'Proposals page', hint: 'full text of open proposals' },
  { arg: 'artifact-weekly-review', path: 'artifacts.weekly_review', kind: 'boolean', group: 'Artifacts',
    label: 'Weekly-review page', hint: 'the compiled weekly report at a stable URL' },
  { arg: 'artifact-backend', path: 'artifacts.backend', kind: 'string', group: 'Artifacts',
    label: 'Artifact backend', hint: "'claude', or the name of a connected MCP artifact server",
    applies: 'next refresh' },
];

/** Read-only rows `show` renders but no argument sets. */
export const READ_ONLY: ReadonlyArray<{ path: string; group: Setting['group']; label: string }> = [
  { path: 'auto_session', group: 'Operational', label: 'Auto session' },
  { path: 'tmux_session_name', group: 'Operational', label: 'tmux name' },
];

export function byArg(arg: string): Setting | undefined {
  return SETTINGS.find(s => s.arg === arg);
}

/** The rows the skill's argument table is allowed to drive. */
export function tableSettings(): Setting[] {
  return SETTINGS.filter(s => !s.tableExempt);
}
