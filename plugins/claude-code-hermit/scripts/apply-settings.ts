/**
 * apply-settings.ts — additive, non-weakening settings.json helper for hatch/docker-setup.
 *
 * Usage: bun apply-settings.ts <target-file> <op> [args...]
 *
 * Operations:
 *   allow                    Merge hermit's fixed permissions.allow list
 *   permissions-plan         Print {"missing":[],"obsolete":[],"obsolete_deny":[]} for the
 *                            target — read-only, writes nothing. `missing` is the sealed
 *                            HERMIT_ALLOW entries the target lacks; `obsolete` is the sealed
 *                            HERMIT_OBSOLETE entries it still carries in permissions.allow;
 *                            `obsolete_deny` the sealed HERMIT_OBSOLETE_DENY entries it still
 *                            carries in permissions.deny. Callers (hatch, hermit-evolve) show
 *                            this diff.
 *   permissions-sync         Apply that plan: add every missing HERMIT_ALLOW entry, remove
 *                            only entries listed in HERMIT_OBSOLETE (allow) and
 *                            HERMIT_OBSOLETE_DENY (deny). Prints the applied plan.
 *                            Operator-authored entries are structurally untouchable — removal
 *                            is filtered by the sealed registries, never by shape or heuristic.
 *   artifact-allow           Merge just ["Artifact"] into permissions.allow — kept as its
 *                            own op (not folded into `allow`) so declining the Artifact
 *                            publish-authorization ask never touches hook permissions.
 *   voice-render             Render config.json's `voice` block into what Claude Code
 *                            reads: the `outputStyle` key here, plus (style "custom")
 *                            .claude/output-styles/hermit-voice.md from voice.prose,
 *                            verbatim. Target must be settings.local.json. Prints
 *                            "applied:<style>", or "skipped:unset" and writes nothing
 *                            when voice.style is unset — which is how an operator's own
 *                            /config pick stays theirs. Takes no arguments: the operator's
 *                            answer travels in config.json, written and audited by
 *                            settings-edit, never as caller text. Deliberately NOT in
 *                            SEALED_SETTINGS_OPS.
 *   automode-seed            RETIRED — exits 1. The classifier stopped reading autoMode from any
 *                            project settings file in Claude Code 2.1.207, so this verb's writes
 *                            were silently ignored. The sealed entries now ship in the per-session
 *                            overlay hermit-start renders (lib/settings/automode-entries.ts).
 *   deny <standard|hardened|ask-only|convert-legacy>
 *                            Seed native permissions from state-templates/deny-patterns.json.
 *                            `standard` merges `deny` into permissions.deny and `ask` into
 *                            permissions.ask — purely additive, removes nothing.
 *                            `hardened` merges both arrays into permissions.deny.
 *                            `ask-only` merges ask when the target already carries ≥1 seeded
 *                            deny entry; otherwise prints skip-preserved and writes nothing.
 *                            `convert-legacy` seeds like standard, then strips the five legacy
 *                            hard-block strings from deny (the operator's attended conversion).
 *                            `minimal` aliases `standard`.
 *   deny-add <rule>...       Append each exact string to permissions.deny if absent. Creates the
 *                            file and section if missing. Rewrites nothing when every rule is
 *                            already present. Prints {"added": true|false} (true if any was added).
 *   channel-env <CH> <dir>   Set env.<CH>_STATE_DIR and strip any stale env.*_BOT_TOKEN
 *
 * Rules:
 * - Never removes existing keys or array entries — except channel-env, which strips
 *   any *_BOT_TOKEN from the env block (tokens must live only in .env, never settings),
 *   permissions-sync, which removes only entries named in the sealed HERMIT_OBSOLETE /
 *   HERMIT_OBSOLETE_DENY registries below (rules this plugin itself seeded and has
 *   since retired),
 *   voice-render, which replaces outputStyle by design — config.json owns that key, and
 *   `deny convert-legacy`, which removes five legacy exact strings from permissions.deny
 *   (the old hardened extras that now live as ask entries).
 * - Permission sets are read from state-templates — callers cannot inject arbitrary JSON.
 * - Safe to call under AGENT_HOOK_PROFILE=strict: writes via fs, not the Edit/Write tools.
 */

import fs from 'node:fs';
import path from 'node:path';
import { auditConfigChange } from './lib/config-audit';
import { readSettledConfig } from './lib/config-read';
import { channelStateDirKey } from './lib/channel-config';
import { VOICE_FILE_REL, outputStyleFor } from './lib/voice';
import { writeFileAtomic } from './lib/md-write';
import { SEALED_SETTINGS_OPS, TERMINAL_ONLY_SETTINGS_OPS } from './lib/settings/automode-entries';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');

// Fixed allow-list — sealed here; cannot be extended by callers. This array is the
// single source of truth: hatch and hermit-evolve reach it through permissions-plan /
// permissions-sync rather than restating it, so there is nothing to keep in sync.
const HERMIT_ALLOW = [
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(bun */scripts/cost-tracker.ts*)',
  'Bash(bun */scripts/heartbeat.ts precheck*)',
  'Bash(bun */scripts/reflect-precheck.ts*)',
  'Bash(bun */scripts/archive-shell.ts*)',
  'Bash(bun */scripts/evaluate-session.ts*)',
  // Verb-scoped: `observe` is the only thing this script does. No space before the
  // trailing `*` — CC 2.1.246 warns at startup on a fully-literal argument following
  // a wildcard-containing one (e.g. `observe *`), so this mirrors the other
  // verb-pinned `bun */scripts/…` entries below (`tz-shift*`, `precheck*`, etc).
  // `observations.ts` still hard-rejects any verb it does not own, so `observe*`
  // matching a hypothetical `observeXYZ` reaches a script that refuses it — the
  // grant is not actually widened by dropping the space. Replaces the old
  // append-metrics.ts entry, which granted "write any JSON to any path".
  'Bash(bun */scripts/observations.ts observe*)',
  // `graduate` is reflect's step-3b read of the ledger; it writes nothing. Like every
  // wildcarded entry here it clears the permission engine in the other modes and is
  // suspended under auto mode (docs/security.md § Auto-mode Classifier) — the literal
  // hermit-run grants below are not the remedy for that, they exist for a different
  // reason (routes with no pre-resolved path; reflect's call site resolves its own).
  'Bash(bun */scripts/observations.ts graduate*)',
  'Bash(bun */scripts/proposal.ts*)',
  'Bash(bun */scripts/generate-summary.ts*)',
  'Bash(bun */scripts/update-reflection-state.ts*)',
  'Bash(bun */scripts/apply-reflection-actions.ts*)',
  'Bash(bun */scripts/transcript-digest.ts*)',
  'Bash(bun */scripts/setup-token-mint.ts*)',
  'Bash(bun */scripts/routines.ts tz-shift*)',
  // Monitor evaluates its subprocess command against command permissions.
  // Keep this grant pinned to the one shipped monitor script.
  'Bash(bash */scripts/routine-monitor.sh *)',
  'Bash(bun */scripts/evolve-plan.ts*)',
  'Bash(bun */scripts/evolve-finalize.ts*)',
  // The only sanctioned config.json writer an unattended run reaches by hand:
  // hermit-evolve's step 2b migrations and its language/timezone write go
  // through it, and the strict profile hook-blocks the Edit/Write route they
  // used to take. Without a grant those writes hit the permission engine in a
  // session that has no AskUserQuestion to recover with.
  'Bash(bun */scripts/settings-edit.ts*)',
  'Bash(bun */scripts/manifest-seed.ts*)',
  'Bash(bun */scripts/docker-bun-pin.ts*)',
  'Bash(bun */scripts/apply-settings.ts*)',
  'Bash(bun */scripts/channel-log.ts*)',
  'Bash(bun */scripts/channel-send.ts*)',
  'Bash(bun */scripts/session-archive.ts*)',
  'Bash(bun */scripts/routines.ts precheck*)',
  'Bash(bun */scripts/routines.ts finish*)',
  'Bash(bun */scripts/routines.ts cron-registry*)',
  'Bash(bun */scripts/routines.ts health*)',
  // The arming and tick verbs the daily anchor, `hermit-routines load` and
  // `heartbeat run/start` call on every wake. Per-verb like the entries above:
  // the dispatcher's own verb whitelist is the real gate, these only keep a
  // deterministic call out of the permission engine.
  'Bash(bun */scripts/routines.ts arm*)',
  'Bash(bun */scripts/heartbeat.ts tick*)',
  'Bash(bun */scripts/heartbeat.ts ack-next-task*)',
  'Bash(bun */scripts/heartbeat.ts start-check*)',
  'Bash(bun */scripts/heartbeat.ts start-commit*)',
  // Domain plugins reach core's shared scripts through the project-resident
  // bin/hermit-run (their own ${CLAUDE_PLUGIN_ROOT} can't reach core's versioned
  // cache dir). Pinned to the two verbs they actually need, not a bare
  // `hermit-run proposal *` — that would also hand them create, patch,
  // shell-append, next-task and routine, i.e. arbitrary state-dir writes. The
  // space before * is a word boundary: `proposal micro *` matches
  // `proposal micro .claude-code-hermit brief-cycle` but not a
  // `micro…`-prefixed verb.
  'Bash(.claude-code-hermit/bin/hermit-run proposal micro *)',
  'Bash(.claude-code-hermit/bin/hermit-run proposal metrics *)',
  // The shared domain-hatch protocol, pinned per verb for the same reason:
  // `domain-hatch *` would hand every caller `ensure-target` and `sync-block`
  // — writes to core state and to the operator's CLAUDE.md — when most of a
  // hatch run only needs to read `preflight`.
  'Bash(.claude-code-hermit/bin/hermit-run domain-hatch preflight *)',
  'Bash(.claude-code-hermit/bin/hermit-run domain-hatch ensure-target *)',
  'Bash(.claude-code-hermit/bin/hermit-run domain-hatch sync-block *)',
  // The three routes above exist because a domain plugin can't resolve core's
  // path. The ones below exist for a different reason: they are the routes the
  // model reaches for with no pre-resolved path of its own — the first three ad
  // hoc mid-session (CLAUDE-APPEND names channel-send and observations, and its
  // "log it in the Progress Log" rules lead to proposal shell-append), the
  // rc-server four from the rc-gate skill once the operator invokes it. Their
  // `bun */scripts/*.ts*` twins above are wildcarded-interpreter rules, which
  // auto mode suspends (docs/security.md § Auto-mode Classifier) — so on the
  // fleet's default permission mode the model was left deriving a versioned
  // plugin-cache path by hand, and the shortenings it improvised (an env-var
  // prefix) draw classifier denials AND fall outside every prefix-match rule.
  //
  // `channel-send` is granted without a verb pin because it has modes
  // (--notice/--tier), not verbs. That is only safe because channel-send.ts now
  // pins its own state dir: the grant confers exactly what the existing
  // `Bash(bun */scripts/channel-send.ts*)` entry already confers, and no more.
  'Bash(.claude-code-hermit/bin/hermit-run channel-send *)',
  'Bash(.claude-code-hermit/bin/hermit-run observations observe *)',
  'Bash(.claude-code-hermit/bin/hermit-run proposal shell-append *)',
  // The rc-gate skill's four verbs. The skill is operator-invoked, but the Bash
  // calls it then makes still face the classifier, and their wildcarded twins
  // are suspended there. Every verb is argless, so each grant is exact rather
  // than prefixed — nothing follows the verb to widen it. `start` needs no tier above
  // the everyday one: a spawned session is visible only to the claude.ai account
  // signed in on this machine, so opening the gate changes where the operator can
  // spawn from, never who can.
  'Bash(.claude-code-hermit/bin/hermit-run rc-server start)',
  'Bash(.claude-code-hermit/bin/hermit-run rc-server stop)',
  'Bash(.claude-code-hermit/bin/hermit-run rc-server status)',
  'Bash(.claude-code-hermit/bin/hermit-run rc-server gc)',
  // Backup's read-and-snapshot verbs. `setup` is deliberately absent: it writes
  // backup.remote through a settings-edit subprocess the settings gate never sees
  // on the model's own command line, so a pre-approved `backup setup --remote …`
  // would skip the native prompt that key raises. It stays terminal-only.
  //
  // `run` does commit and push, which the hardened profile's `git push origin
  // main*` / `*--no-verify*` denies would refuse as typed Bash. The boundary holds
  // anyway: the argv is fixed, the destination is the ask-listed backup.remote
  // and nothing else, the refspec is the current branch, and neither --force nor
  // --no-verify is reachable. It is a sanctioned push path, not a way around one.
  'Bash(bun */scripts/backup.ts run*)',
  'Bash(bun */scripts/backup.ts status*)',
  'Bash(.claude-code-hermit/bin/hermit-run backup run*)',
  'Bash(.claude-code-hermit/bin/hermit-run backup status*)',
  'Bash(bun */scripts/memory-dir.ts*)',
  'Bash(.claude-code-hermit/bin/hermit-run memory-dir*)',
  "Bash(bash -c 'AGENT_DIR=\".claude-code-hermit\"*)",
  'Edit(.claude-code-hermit/**)',
  // The hermit reading its own installed plugin tree (docs/, skills/, reference.md,
  // state-templates/), which unattended paths like hermit-evolve depend on. `//` anchors
  // at the filesystem root (a bare or single-slash pattern anchors at the settings file's
  // own directory instead and matches nothing); the mid-pattern `**` covers both install
  // trees, the marketplace clone and the version cache; `claude-code-hermit` sits in the
  // plugin slot so a fork's differently-named marketplace does not orphan the grant.
  // Full rationale, including Windows/WSL portability and non-default config dirs:
  // docs/security.md.
  'Read(//**/.claude/plugins/**/claude-code-hermit/**)',
];

// Entries this plugin itself shipped in an earlier version and has since retired.
// permissions-sync removes these from an operator's settings; nothing else is ever
// removed, so an operator's own rules cannot be caught by a shape or prefix match.
// Append here in the same change that deletes a permissioned script, or that respells
// an entry still in HERMIT_ALLOW — this registry is what makes a deletion or a respelling
// reach already-hatched hermits.
const HERMIT_OBSOLETE = [
  'Bash(python3:*)',
  'Bash(node:*)',
  'Edit(.claude/.claude-code-hermit/**)',
  'Write(.claude/.claude-code-hermit/**)',
  'Bash(bun */scripts/run-with-profile.ts*)',
  'Bash(bun */scripts/suggest-compact.ts*)',
  'Bash(bun */scripts/next-prop-id.ts*)',
  // Retired with the script: an arbitrary-path, arbitrary-JSON writer is a wider
  // grant than any caller needed. Replaced by `observations.ts observe *` above and
  // by proposal.ts's existing grant, which now covers the `event` verb.
  'Bash(bun */scripts/append-metrics.ts*)',
  // Proposal satellites absorbed into proposal.ts verbs — the scripts are gone,
  // so these grants now name nothing.
  'Bash(bun */scripts/resolve-prop.ts*)',
  'Bash(bun */scripts/record-gate.ts*)',
  'Bash(bun */scripts/queue-micro-proposal.ts*)',
  'Bash(bun */scripts/micro-proposal.ts*)',
  'Bash(bun */scripts/proposals-index.ts*)',
  // …and the two hermit-run routes that pointed at the pre-absorption names.
  'Bash(.claude-code-hermit/bin/hermit-run micro-proposal *)',
  'Bash(.claude-code-hermit/bin/hermit-run proposal-metrics-report *)',
  // Heartbeat/routine scripts absorbed into heartbeat.ts and routines.ts verbs.
  'Bash(bun */scripts/heartbeat-precheck.ts*)',
  'Bash(bun */scripts/routine-precheck.ts*)',
  'Bash(bun */scripts/cron-registry.ts*)',
  'Bash(bun */scripts/cron-tz-shift.ts*)',
  // Superseded by the no-space form above — CC 2.1.246 warns at startup on this shape
  // (fully-literal `observe` argument following the `*/scripts/…` wildcard).
  'Bash(bun */scripts/observations.ts observe *)',
];

// The deny half of the same registry. Same rule: only entries this plugin itself
// seeded (via the `deny` op) and has since retired, matched as exact strings, so an
// operator's own deny rules cannot be caught. These three were unanchored credential
// word globs — trivially bypassable, and they blocked ordinary work (a grep, a commit
// message). This is what reaches the copy `deny` wrote into already-hatched hermits'
// settings. Not extended with the five legacy hardened extras: those are still
// legitimate Hardened seeds, and sync would re-strip them every run.
const HERMIT_OBSOLETE_DENY = [
  'Bash(*API_KEY*)',
  'Bash(*SECRET*)',
  'Bash(*TOKEN*)',
  // Respelled, not dropped: the single-slash form anchored at the settings file's own
  // directory and so matched nothing outside the project. The `//`-anchored replacement
  // lives in state-templates/deny-patterns.json; this entry is what strips the dead one
  // from already-hatched hermits on the next permissions-sync.
  'Edit(*/.claude/plugins/marketplaces/*)',
  // Its `Write` twin, seeded alongside it before Edit rules were known to cover every
  // file-editing tool. Older installs still carry it, CC warns at boot on `Write(path)`
  // rules, and retiring the `Edit` spelling above leaves nothing else that would clear
  // it, so it goes in the same pass.
  'Write(*/.claude/plugins/marketplaces/*)',
];

type Json = any;

function readJson(filePath: string): Json {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

// Strict read for the operator's target settings file: an existing-but-malformed
// file must abort, never fall through to {} — otherwise the additive merge below
// would overwrite the whole file with only hermit's subset, silently discarding
// the operator's settings.
function readTargetJson(filePath: string): Json {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(
      `Refusing to overwrite ${filePath}: file exists but is not valid JSON ` +
        `(${(err as Error).message}). Fix or remove it, then re-run.`,
    );
    process.exit(1);
  }
}

function writeJson(filePath: string, data: Json): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, JSON.stringify(data, null, 2) + '\n');
}

// Merges entries into permissions.<key>, deduping against what's already there,
// and returns the entries newly added (absent before) — the `allow` op prints
// these so hermit-evolve's Step 8 report can list what it granted, and the
// `deny` op's seeding paths print them as `added:` lines.
function mergePermissionKey(settings: Json, key: 'allow' | 'deny' | 'ask', entries: string[]): string[] {
  settings.permissions ??= {};
  settings.permissions[key] ??= [];
  const existing = new Set<string>(settings.permissions[key]);
  const added: string[] = [];
  for (const e of entries) {
    if (!existing.has(e)) { settings.permissions[key].push(e); added.push(e); }
  }
  return added;
}

function mergeAllow(settings: Json, entries: string[]): string[] {
  return mergePermissionKey(settings, 'allow', entries);
}

interface PermissionsPlan {
  missing: string[];
  obsolete: string[];
  obsolete_deny: string[];
}

// Read-only diff of the target against the three sealed registries above.
function planPermissions(settings: Json): PermissionsPlan {
  const allow: string[] = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  const existing = new Set<string>(allow);
  const deny: string[] = Array.isArray(settings?.permissions?.deny) ? settings.permissions.deny : [];
  const existingDeny = new Set<string>(deny);
  return {
    missing: HERMIT_ALLOW.filter((e) => !existing.has(e)),
    obsolete: HERMIT_OBSOLETE.filter((e) => existing.has(e)),
    obsolete_deny: HERMIT_OBSOLETE_DENY.filter((e) => existingDeny.has(e)),
  };
}

// Removes exactly the entries handed in from `permissions.<key>` — always a subset of
// the matching sealed registry (HERMIT_OBSOLETE for allow, HERMIT_OBSOLETE_DENY for
// deny). That subset relationship is what makes an operator's own rules structurally
// safe: removal is by exact string from a shipped list, never by shape or prefix.
function removePermissions(settings: Json, key: 'allow' | 'deny', entries: string[]): void {
  if (entries.length === 0 || !Array.isArray(settings?.permissions?.[key])) return;
  const drop = new Set(entries);
  settings.permissions[key] = settings.permissions[key].filter((e: string) => !drop.has(e));
}

function mergeDeny(settings: Json, entries: string[]): void {
  mergePermissionKey(settings, 'deny', entries);
}

function mergeAsk(settings: Json, entries: string[]): string[] {
  return mergePermissionKey(settings, 'ask', entries);
}

const [, , targetFile, op, ...rest] = process.argv;

if (!targetFile || !op) {
  console.error('Usage: apply-settings.ts <target-file> <op> [args...]');
  process.exit(1);
}

const settings = readTargetJson(targetFile);
// Snapshot before the ops below mutate in place — the audit ledger records what
// this run actually changed in the operator's settings file.
const settingsBefore = structuredClone(settings);

// permissions-plan reports without touching the file; every other op falls through
// to the write below.
let readOnly = false;

switch (op) {
  // Legacy alias for permissions-sync's additive half. No in-repo caller since
  // hatch and hermit-evolve moved to the verbs — kept for already-hatched hermits
  // still running older skill text.
  case 'allow': {
    mergeAllow(settings, HERMIT_ALLOW);
    break;
  }

  case 'permissions-plan': {
    console.log(JSON.stringify(planPermissions(settings)));
    readOnly = true;
    break;
  }

  case 'permissions-sync': {
    // Plan first: the diff is computed against the pre-merge state, so the printed
    // result is exactly what this run changed.
    const plan = planPermissions(settings);
    // Nothing to do — don't rewrite the file. hermit-evolve runs this on every
    // upgrade, and a target that is already current must not come back reformatted
    // (or with a fresh mtime) just for having been checked.
    if (plan.missing.length === 0 && plan.obsolete.length === 0 && plan.obsolete_deny.length === 0) readOnly = true;
    else {
      mergeAllow(settings, HERMIT_ALLOW);
      removePermissions(settings, 'allow', plan.obsolete);
      removePermissions(settings, 'deny', plan.obsolete_deny);
    }
    console.log(JSON.stringify(plan));
    break;
  }

  case 'artifact-allow': {
    mergeAllow(settings, ['Artifact']);
    break;
  }

  case 'voice-render': {
    // Renders config.voice — the operator's answer, written through settings-edit's
    // validated and audited path — into the two artifacts Claude Code actually reads:
    // the `outputStyle` key, and (for `custom`) the style file it names. config is the
    // truth; these are its render targets, the same relationship config.env has with
    // this file's env block. So this op is unconditional where the retired seed op was
    // only-if-absent: a style the operator picked in /config is not silently preserved
    // here, it is superseded by whatever they last told the hermit — and `style: null`
    // means "not the hermit's key", which leaves the operator's own pick untouched.
    //
    // Local scope only, deliberately: it is the scope Claude Code's own /config picker
    // writes and the one that outranks committed settings.json, and the voice file is
    // gitignored — a committed outputStyle would ship a pointer to a file a teammate
    // does not have. (Harmless, probed: a missing style file starts silently as
    // Default. Still not something to ship on purpose.)
    if (path.basename(targetFile) !== 'settings.local.json') {
      console.error(`voice-render: refusing ${path.basename(targetFile)} — the voice renders to .claude/settings.local.json only`);
      process.exit(1);
    }
    const projectRoot = path.dirname(path.dirname(path.resolve(targetFile)));
    const voice = readSettledConfig(path.join(projectRoot, '.claude-code-hermit')).voice;
    const style = outputStyleFor(voice);
    if (style === null) {
      console.log('skipped:unset');
      readOnly = true;
      break;
    }
    if (voice.style === 'custom') {
      // validate-config refuses `custom` without prose, so reaching here with none
      // means the config was hand-edited around that path. Fail loudly rather than
      // render an empty voice.
      const prose = typeof voice.prose === 'string' ? voice.prose.trim() : '';
      if (prose === '') {
        console.error('voice-render: voice.style is "custom" but voice.prose is empty — set the prose first');
        process.exit(1);
      }
      const template = fs.readFileSync(
        path.join(PLUGIN_ROOT, 'state-templates', 'hermit-voice.md.template'),
        'utf8',
      );
      // Verbatim: the operator's own words are the whole point of `custom`, and a
      // paraphrase here is the bug this replaced. Only the placeholder moves.
      // The replacement is a function, not a string: a string replacement expands
      // `$&`, `` $` ``, `$'` and `$1` inside the prose, so a voice mentioning `$&`
      // would render with the placeholder pasted back into it.
      const voiceFile = path.join(projectRoot, VOICE_FILE_REL);
      fs.mkdirSync(path.dirname(voiceFile), { recursive: true });
      writeFileAtomic(voiceFile, template.replace('{{VOICE_PROSE}}', () => prose));
    }
    settings.outputStyle = style;
    console.log(`applied:${style}`);
    break;
  }

  case 'automode-seed': {
    // Retired. Since Claude Code 2.1.207 the classifier reads autoMode only
    // from user scope, managed settings, or --settings — never from a project
    // settings file — so every write this verb made was silently ignored
    // (upstream anthropics/claude-code#87545). hermit-start now renders the
    // sealed entries into a per-session overlay and launches with --settings.
    // Kept as a loud failure so old CHANGELOG upgrade instructions that still
    // call it can't look like they succeeded.
    console.error(
      'automode-seed is retired: autoMode is not read from a project settings file since Claude Code 2.1.207. ' +
      'The sealed entries now ship in the boot-time classifier overlay (hermit-start renders ' +
      '.claude-code-hermit/state/claude-settings.overlay.json and launches with --settings). No action needed.'
    );
    process.exit(1);
  }

  case 'deny': {
    const raw = rest[0];
    const profile = raw === 'minimal' ? 'standard' : raw;
    if (profile !== 'standard' && profile !== 'hardened' && profile !== 'ask-only' && profile !== 'convert-legacy') {
      console.error(`deny requires 'standard', 'hardened', 'ask-only', or 'convert-legacy', got: ${raw ?? '(none)'}`);
      process.exit(1);
    }
    const patternsFile = path.join(PLUGIN_ROOT, 'state-templates', 'deny-patterns.json');
    const patterns = readJson(patternsFile);
    const denyEntries: string[] = Array.isArray(patterns.deny) ? patterns.deny : [];
    const askEntries: string[] = Array.isArray(patterns.ask) ? patterns.ask : [];

    if (profile === 'ask-only') {
      const existingDeny = new Set<string>(
        Array.isArray(settings?.permissions?.deny) ? settings.permissions.deny : [],
      );
      const seeded = denyEntries.some((e) => existingDeny.has(e));
      if (!seeded) {
        console.log('skip-preserved');
        readOnly = true;
        break;
      }
      const added = mergeAsk(settings, askEntries);
      for (const e of added) console.log(`added:${e}`);
      if (added.length === 0) readOnly = true;
      break;
    }

    if (profile === 'hardened') {
      mergeDeny(settings, [...denyEntries, ...askEntries]);
      break;
    }

    // standard and convert-legacy share the same seed; only convert-legacy may
    // remove anything. Keeping standard purely additive is what lets hatch and
    // docker-setup call it without ever demoting a Hardened install — the
    // legacy-deny → ask conversion happens only when the operator personally
    // runs convert-legacy from a terminal (the CHANGELOG cleanup one-liner).
    mergeDeny(settings, denyEntries);
    const added = mergeAsk(settings, askEntries);
    for (const e of added) console.log(`added:${e}`);
    if (profile === 'convert-legacy') {
      const legacyHardBlocks = [
        'Bash(npm publish*)',
        'Bash(git push --force*)',
        'Bash(git push origin main*)',
        'Bash(git reset --hard*)',
        'Bash(*--no-verify*)',
      ];
      const present = legacyHardBlocks.filter((e) => settings.permissions.deny.includes(e));
      removePermissions(settings, 'deny', present);
      for (const e of present) console.log(`removed:${e}`);
    }
    break;
  }

  case 'deny-add': {
    const rules = rest.filter((r) => r);
    if (rules.length === 0) {
      console.error("deny-add requires at least one permission rule");
      process.exit(1);
    }
    const added = mergePermissionKey(settings, 'deny', rules);
    if (added.length === 0) readOnly = true;
    console.log(JSON.stringify({ added: added.length > 0 }));
    break;
  }

  case 'channel-env': {
    const channel = rest[0];
    const stateDir = rest[1];
    if (!channel || !stateDir) {
      console.error('channel-env requires <CHANNEL_UPPER> and <abs_state_dir> arguments');
      process.exit(1);
    }
    const stateDirKey = channelStateDirKey(channel);
    if (!stateDirKey) {
      console.error(`channel-env: "${channel}" is not a valid env-var name — refusing to write a key hermit-start would never export`);
      process.exit(1);
    }
    settings.env ??= {};
    // Tokens must live only in .env — strip any stale *_BOT_TOKEN from settings.
    for (const key of Object.keys(settings.env)) {
      if (/_BOT_TOKEN$/.test(key)) delete settings.env[key];
    }
    settings.env[stateDirKey] = stateDir;
    break;
  }

  default: {
    const validOps = [...SEALED_SETTINGS_OPS, ...TERMINAL_ONLY_SETTINGS_OPS];
    console.error(`Unknown operation: ${op}. Valid ops: ${validOps.join(', ')}`);
    process.exit(1);
  }
}

if (!readOnly) {
  writeJson(targetFile, settings);
  // The hermit state dir is a sibling of .claude/ — the ledger lives with the
  // rest of the hermit's state, not next to the settings file it describes.
  const stateDir = path.resolve(path.dirname(targetFile), '..', '.claude-code-hermit');
  const target = path.basename(targetFile) === 'settings.local.json'
    ? '.claude/settings.local.json'
    : '.claude/settings.json';
  auditConfigChange(stateDir, settingsBefore, settings, 'apply-settings', target);
}
