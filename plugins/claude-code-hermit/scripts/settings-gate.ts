// PreToolUse hook (matcher "Bash|Edit|Write"): raises Claude Code's native
// permission prompt for execution-adjacent hermit settings, channel enrollment,
// and direct config.json edits. Everyday settings apply without a prompt.
//
// A matching write prints one permissionDecision: "ask" line and exits 0;
// everything else prints nothing and exits 0. The dialog is delivered to the
// channel plugin's allowFrom DMs, or shown in the terminal pane. A No is the
// operator's answer: never retry or route around it, and never edit
// config.json directly. The authoritative list is this file.
//
// This is a policy guard over the command text, not a filesystem boundary: a
// write staged through `bash -c`, `eval`, or a script the hook cannot read is
// invisible here and stays classifier-watched (docs/security.md § Settings from
// chat). What the text does show is judged strictly: a target the shell would
// expand at run time is asked, because the hook cannot know what it names.

import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { readConfigRaw } from './lib/config-read';
import { byArg } from './lib/settings/registry';
import { runHook } from './lib/hook-input';
import { isSecretPath } from './lib/config-audit';

type Json = any;

/** settings-edit verbs that mutate config.json. */
const WRITE_VERBS = new Set(['set', 'unset', 'toggle', 'apply-known']);

/** Write verbs that take a value after the target; see settings-edit.ts's dispatch. */
const TAKES_VALUE = new Set(['set', 'apply-known']);

/**
 * Paths that raise the native ask. `voice.style` is not asked: three sealed
 * values that carry no text. `voice` and `voice.prose` are, because prose
 * becomes every future session's system prompt. Under `channels`, only the
 * enrollment fields (who may reach the hermit, which chat it trusts) and the
 * containers that replace them; per-channel everyday keys such as
 * `morning_brief` apply without a prompt.
 */
const ASK_PATH =
  /^(permission_mode|env|monitors|boot_skill|shutdown_skill|backup)(\..+)?$|^voice(\.prose)?$|^routines\.\d+\.precheck(_timeout_s)?$|^channels(\.[^.]+)?$|^channels\.[^.]+\.(allowed_users|default_chat_id|dm_channel_id|maintainer_channel_id)(\..+)?$/;

/**
 * The container spellings judged by value: the whole array, and one indexed entry.
 * `setPath` splits on `.` and indexes arrays, so `set routines.0 '<object>'`
 * replaces a whole routine, precheck included, without ever naming the field, which
 * a leaf-only rule would wave through without a prompt.
 */
const ROUTINES_CONTAINER = /^routines(\.\d+)?$/;

/**
 * Does this `set routines[.<n>] <json>` add or change any `precheck`?
 *
 * The add/edit flow in hermit-settings writes the entire array back, so a
 * field-level rule alone would be bypassed by every legitimate-looking array
 * write. Compared by id: a reordered array with the same gates is not a change.
 * Unparseable input counts as changed: an opaque write must not skip the ask
 * a legible one would raise.
 */
export function precheckSetChanged(value: string, current: Json[]): boolean {
  const gateOf = (r: Json) => (r && r.precheck != null ? `${String(r.precheck)}\u0000${r.precheck_timeout_s ?? ''}` : null);
  const before = new Map<string, string | null>();
  for (const r of Array.isArray(current) ? current : []) {
    if (r && r.id) before.set(String(r.id), gateOf(r));
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(value);
  } catch {
    return true;
  }
  // A lone routine object (the `routines.<n>` spelling) is judged as an array of
  // one. It has to carry an `id` to be read that way: anything else is not a
  // routine write this can reason about, so it takes the strict answer.
  const next: Json[] | null = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === 'object' && parsed.id) ? [parsed]
    : null;
  if (!next) return true;
  for (const r of next) {
    const gate = gateOf(r);
    if (gate === null) continue; // dropping a gate is a de-escalation, not an arming
    if (!r || !r.id || before.get(String(r.id)) !== gate) return true;
  }
  return false;
}


/**
 * `apply-known`'s registry arg name resolved to its dotted config path; every
 * other verb's target is already dotted and passes through so ASK_PATH matches.
 */
function resolveTarget(verb: string, target: string): string {
  return verb === 'apply-known' ? (byArg(target)?.path ?? target) : target;
}

const CONFIG_SUFFIX = path.join('.claude-code-hermit', 'config.json');

function targetsConfigFile(p: string): boolean {
  return p.replace(/\\/g, '/').endsWith(CONFIG_SUFFIX.replace(/\\/g, '/'));
}

/**
 * The routines array as it stands on disk, for the value-aware precheck rule.
 * An unreadable config yields an empty baseline, which makes every declared gate
 * in the incoming write look new: the strict direction.
 */
function currentRoutines(): Json[] {
  let config: Json = null;
  try {
    config = readConfigRaw(hermitDir());
  } catch {
    config = null;
  }
  const routines = config?.routines;
  return Array.isArray(routines) ? routines : [];
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Display stand-in for a credential value: what it became, never what it was.
 * The same two words as the audit ledger's marker (`presence` in
 * lib/config-audit.ts, keyed on the on-disk null) so a settings-history line and
 * a permission prompt read alike; `none` and `clear` are settings-edit's
 * spellings for a null write.
 */
function presenceOf(value: string): string {
  const v = stripQuotes(value);
  return v === '' || v === 'none' || v === 'clear' ? '[cleared]' : '[set]';
}

/**
 * A bare integer is not a credential, and the env knobs this plugin ships and
 * documents (`MAX_THINKING_TOKENS`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) are all
 * integers. Withholding those would cost the operator the only thing the ask is
 * for (`=[set]` reads identically for `20000` and `200`) and buy nothing, since
 * the redaction exists to keep secrets out of the chat, not numbers.
 */
const BARE_INTEGER = /^\d+$/;

/**
 * What the operator is shown for one write, with any value config-audit refuses
 * to log withheld.
 *
 * A container write (`set env '{"A":"x"}'`) is expanded to one marker per key it
 * sets: redacting it whole yields a bare `env=[set]`, which names no key at all.
 */
function displayFor(dotted: string, value: string): string {
  if (!isSecretPath(dotted)) return `${dotted}=${value}`;
  const bare = stripQuotes(value);
  if (BARE_INTEGER.test(bare)) return `${dotted}=${bare}`;
  let parsed: Json;
  try {
    parsed = JSON.parse(bare);
  } catch {
    return `${dotted}=${presenceOf(value)}`;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `${dotted}=${presenceOf(value)}`;
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0) return `${dotted}=[cleared]`;
  return keys.map((k) => `${dotted}.${k}=${presenceOf(String(parsed[k] ?? ''))}`).join(', ');
}

function ask(reason: string): void {
  fs.writeSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }) + '\n');
}

/**
 * A shell write that lands on config.json without going through settings-edit:
 * a redirect, `cp`/`mv` with it as the destination (the last argument), `tee`
 * onto it, or `sed -i` over it. The path is matched by its
 * `.claude-code-hermit/config.json` tail, or by a `$`-expanded prefix ending in
 * `config.json`, since the hook cannot resolve the variable.
 */
const CONFIG_FILE_PATH = String.raw`(?:\S*\.claude-code-hermit\/|\$\S*\/)config\.json["']?`;
const CONFIG_FILE_WRITE = new RegExp(
  String.raw`>\s*["']?${CONFIG_FILE_PATH}`
  + String.raw`|\b(?:cp|mv)\s[^|;&\n]*?\s["']?${CONFIG_FILE_PATH}(?=\s*(?:[|;&]|$))`
  + String.raw`|\b(?:tee|sed\s+(?:-\S+\s+)*-i\S*)\s[^|;&\n]*?["']?${CONFIG_FILE_PATH}`,
  'm',
);

/** A token the shell would still expand: the hook cannot know what it names. */
const SHELL_EXPANDS = /[$`]/;

/**
 * Does this Bash command mutate an asked hermit setting?
 *
 * Matches both invocation forms, the script path
 * (`bun .../scripts/settings-edit.ts <file> set permission_mode auto`) and the
 * resolver (`.claude-code-hermit/bin/hermit-run settings-edit <file> set ...`),
 * plus direct shell writes onto config.json. Returns null when the command
 * isn't a settings mutation at all, or when every write is off the ask list.
 *
 * EVERY settings-edit invocation in the command is judged, not just the first:
 * one Bash call can chain several (`... set model haiku && ... set
 * permission_mode bypassPermissions`), and a leading safe write must not
 * launder a protected one behind it.
 */
function protectedMutation(command: string): string[] | null {
  // An opaque write of the whole file can replace any asked path, so it
  // raises the native prompt regardless of what it happens to contain.
  if (CONFIG_FILE_WRITE.test(command)) {
    return ['config.json'];
  }

  // The script path and the config path may each be quoted (a plugin root or
  // project under a directory with a space), so both accept a quoted token
  // before the bare-word form. The value alternation does the same: a routines
  // write carries a JSON array, which has spaces in it, and a bare `\S+` would
  // capture only up to the first one. That truncation is not merely cosmetic
  // for the prompt label: precheckSetChanged() would then parse a fragment, fail,
  // and raise a prompt for every routine add.
  const matches = [...command.matchAll(
    /(?:settings-edit(?:\.ts)?)["']?\s+('[^']*'|"[^"]*"|\S+)\s+([a-z-]+)(?:\s+(\S+))?(?:\s+('[^']*'|"[^"]*"|\S+))?/g
  )];
  if (matches.length === 0) return null;

  const shown: string[] = [];
  for (const m of matches) {
    const verb = m[2];
    if (!WRITE_VERBS.has(verb)) continue;
    const t = stripQuotes(m[3] ?? '');
    // `unset` and `toggle` take a path and nothing else, so the token after
    // theirs belongs to the shell (a `&&`, a redirect), not to the setting.
    const value = TAKES_VALUE.has(verb) ? stripQuotes(m[4] ?? '') : '';
    if (SHELL_EXPANDS.test(t)) {
      if (!shown.includes(t)) shown.push(t);
      continue;
    }
    const dotted = resolveTarget(verb, t);
    const needsAsk = ASK_PATH.test(dotted)
      || (ROUTINES_CONTAINER.test(dotted) && value !== ''
        && precheckSetChanged(value, currentRoutines()));
    if (!needsAsk) continue;
    const label = value ? displayFor(dotted, value) : dotted;
    if (!shown.includes(label)) shown.push(label);
  }
  if (shown.length === 0) return null;
  return shown.sort();
}

function main(payload: any): void {
  const tool = typeof payload?.tool_name === 'string' ? payload.tool_name : '';
  if (tool !== 'Bash' && tool !== 'Edit' && tool !== 'Write') return; // defensive

  // Pure string matching first, no I/O: this hook fires on every Bash, Edit
  // and Write, and almost none of them are settings mutations.
  const input = payload?.tool_input ?? {};
  let asked: string[] | null = null;

  if (tool === 'Bash') {
    asked = protectedMutation(typeof input.command === 'string' ? input.command : '');
  } else {
    const fp = typeof input.file_path === 'string' ? input.file_path : '';
    asked = targetsConfigFile(fp) ? ['config.json'] : null;
  }

  if (!asked) return;
  ask(`Hermit setting: ${asked.join(', ')}`);
}

if (import.meta.main) runHook(main, () => {
  ask('Hermit setting: tool call too large to inspect');
});
