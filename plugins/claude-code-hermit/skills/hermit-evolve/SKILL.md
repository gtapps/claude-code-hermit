---
name: hermit-evolve
description: Evolves hermit configuration and templates after a plugin update. Detects version gaps, presents new features, walks through new settings. Run after updating the plugin.
---

# Evolve Hermit

Upgrade the project's hermit configuration after a plugin update.

## Unattended mode

Active when invoked with the positional argument `unattended` (e.g. `/claude-code-hermit:hermit-evolve unattended`), or as a fallback when running in an always-on session invoked via channel. In this mode the upgrade must complete without operator input:

- **Never call `AskUserQuestion` at any step** — including the migration steps (2b, 7) that execute `### Upgrade Instructions`. Each step's unattended behavior is stated inline below.
- For any interactive choice with a safe non-destructive default (new settings, file deletions, `## Plan` strip), take the default silently and report it in the Step 10 channel notification.
- For a genuine either/or with no safe default, **defer**: leave state untouched and log a channel line `"migration step deferred for operator review: <desc>"`. Never guess.

## Plan

### 0. Verify Claude Code CLI version

- Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hermit-meta.json`. If the file
  doesn't exist or `min_claude_code_version` is not set, skip this step.
- Run `claude --version` and parse the leading semver (format:
  `X.Y.Z (Claude Code)`). If the command fails or the version cannot be parsed,
  report: "Could not detect Claude Code CLI version — proceeding anyway." and
  skip the comparison.
- Compare the detected version against `min_claude_code_version` (supports
  `>=X.Y.Z` or bare `X.Y.Z`, treated as `>=`). If the CLI version is below the
  minimum, report:

  ```
  This hermit version requires Claude Code >=<min> (you have <detected>).

  Upgrade Claude Code (`claude update` or your package manager) and re-run
  /claude-code-hermit:hermit-evolve.
  ```

  Substitute `<min>` with the value from `min_claude_code_version` and
  `<detected>` with the parsed CLI version. Then stop. Do not prompt to bypass.

### 0b. Verify the bun runtime (hard gate)

- Read `required_bun_version` from the same `hermit-meta.json`. If not set, skip
  this step.
- Run `bun --version`. If the command fails (bun not installed) or the version is
  below the requirement, report:

  ```
  This hermit version requires bun <required> — hooks and scripts run on it.
  You have: <detected or "not installed">.

  Install:  curl -fsSL https://bun.sh/install | bash
  Upgrade:  bun upgrade

  Then re-run /claude-code-hermit:hermit-evolve.
  ```

  Then **stop. Do not prompt to bypass and do not continue the upgrade** — completing
  it without bun would leave every hook fire erroring at spawn. (Docker operators are
  unaffected: the image bakes bun in.)

### 1. Resolve hatch target, then run the pre-pass

First determine `hatch_target` (the pre-pass needs it, and so do Steps 6, 7, 8):

1. Read `.claude-code-hermit/state/hatch-options.json` if it exists. Use the `"target"` field as `hatch_target`.
2. If the file is absent or has no `"target"` field:
   - Check if `CLAUDE.local.md` contains the marker `claude-code-hermit: Session Discipline` → `hatch_target = "local"`.
   - Else if `CLAUDE.md` contains the marker → `hatch_target = "committed"`.
   - Else → re-run scope detection: read `claude plugin list --json`. From the output, find all entries where plugin name (substring of `id` left of `@`) is `claude-code-hermit` and `enabled == true`. Apply precedence: if any has `scope == "local"` and `projectPath` equals current project root → `local`; else if any has `scope == "project"` and `projectPath` equals current project root → `project`; else if any has `scope == "user"` (any `projectPath`) → `user`; else → `null`. Map: `project` → `committed`; `local`/`user`/`null` → `local`.

Then run the deterministic pre-pass — a single read-only analyzer that computes the version gap, the bounded CHANGELOG slice, new config keys, changed templates/bin, and the CLAUDE-APPEND block diff, so the steps below act on its output instead of reading and diffing whole files:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/evolve-plan.ts .claude-code-hermit --hatch-target=<hatch_target>
```

Parse stdout as JSON (the "plan"). The plan's `errors` array is the **sole error channel** — objects of `{code, message}`:

- If `errors` contains an entry with `code == "no_config"` → report "No config found. Run `/claude-code-hermit:hatch` first." and stop.
- Else if `errors` is non-empty (any other code, e.g. `no_hatch_target`) **or** stdout is not valid JSON → report "evolve-plan failed: <joined messages> — re-run or report." and stop. Do not fall back to reading and diffing the files by hand.

**Version check:** the plan reports `from`, `to`, and `up_to_date`. If `up_to_date` is `true`, report "You're up to date (v<to>). Nothing to upgrade." and stop. Otherwise announce: "Upgrading from v<from> to v<to>."

### 2. Present the changelog

Present the plan's `changelog_slice` to the operator: "Here's what changed:" followed by the slice. It already contains only the entries in `(from, to]`, oldest-first — no full-file read.

### 2b. Execute version migrations

Within `changelog_slice` (already ordered oldest-first), each version entry may contain a `### Upgrade Instructions` section:

1. Find the `### Upgrade Instructions` section within each version's entry
2. If found, execute every instruction in that section — these are the authoritative migration steps
3. Present version-specific operator notes as you go
4. If a step is interactive (asks the operator a question): in normal mode, ask it before proceeding. **In unattended mode, do not ask** — apply the non-destructive default (e.g. a delete/cleanup offer → keep the file) or defer per the Unattended mode rules, and note it for the Step 10 channel report.

The CHANGELOG.md `### Upgrade Instructions` sections are the single source of truth for migrations — do not skip or merely display them. The same pattern applies to sibling-hermit upgrades in Step 7.

### 3. New config keys

The plan's `new_config_keys` array lists every key in the current `config.json.template` that is missing from the project's config, each as `{path, default}` — a dotted `path` for a nested leaf, or a fully-absent parent carrying its whole default subtree. Operator-set values are never listed, so acting on these never overwrites them.

### 4. Ask about new settings

For each entry in the plan's `new_config_keys`, check the interactive allowlist below. If the entry's `path` is interactive, ask the operator. **Every other key — including template-only keys not enumerated below — is added silently with its `default` from the plan.** Batch interactive questions into a single numbered list.

**Unattended mode:** do not ask — set every interactive key silently to its plan `default` (`language`/`timezone` keep their auto-detected default), and list the silently-set keys in the Step 10 channel notification ("adjust via /hermit-settings").

**Interactive keys** (ask operator if missing):
- `agent_name` (0.0.1), `language` (0.0.1, auto-detect from `$LANG`), `timezone` (0.0.1, auto-detect), `escalation` (0.0.1), `idle_behavior` (0.0.9)
- `sign_off` (0.0.1) — only if `agent_name` is set
- `remote` (0.0.1): default `true`

**Silent keys** (add with default if missing):
- `always_on` (0.0.1): `false` | `auto_session` (0.0.1): `true`
- `model` (0.0.1): `"sonnet"` | `permission_mode` (0.0.1): `"auto"`
- `tmux_session_name` (0.0.1): `"hermit-{project_name}"` | `chrome` (0.0.1): `false` | `push_notifications` (1.1.2): `true`
- `channels` (0.0.1): `{}` | `monitors` (0.3.14): `[]`
- `heartbeat.waiting_timeout` (0.3.0): `null` | `heartbeat.stale_threshold` (0.0.9): `"2h"`
- `routines` (0.0.9): `[]`
- `scheduled_checks` (0.3.1): `[]`
- `env` (0.0.7): `{"AGENT_HOOK_PROFILE":"standard","COMPACT_THRESHOLD":"75","CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"65","MAX_THINKING_TOKENS":"10000"}`
- `docker` (0.0.7): `{"packages":[],"recommended_plugins":[]}`
- `compact` (0.0.7): `{"monitoring_threshold":30,"monitoring_keep":20,"summary_threshold":30,"summary_keep":15}`
- `knowledge` (0.4.0): `{"raw_retention_days":14,"compiled_budget_chars":2500,"working_set_warn":20}`

**Prompts** — use the exact same `AskUserQuestion` structures as hatch Phase 2 (see `skills/hatch/SKILL.md`):
- `agent_name`: AskUserQuestion with options (Atlas / Hermit / Skip) + Other for custom input
- `language` + `timezone`: single batched AskUserQuestion, auto-detected value as first option
- `escalation`: AskUserQuestion with options (Balanced / Conservative / Autonomous)
- `sign_off`: AskUserQuestion with options ({name} out. / -- {initial}. / Skip) — only if agent_name was set
- `idle_behavior`: AskUserQuestion with options (Discover / Wait)

Tell the operator: "New settings available in this version:" then present only the questions for keys that are actually missing from their config. If no interactive keys are missing, skip this step.

### 4-task. Write task list ID to settings.local.json

If `CLAUDE_CODE_TASK_LIST_ID` is not already set in `.claude/settings.local.json`:

1. Derive: `hermit-{project_basename}` (lowercase, alphanumeric + hyphens)
2. Read `.claude/settings.local.json`, merge into `env` block, write back

Also: if an active SHELL.md has a `## Plan` section (legacy plan table), warn the operator: "Close active sessions before upgrading, or the old plan table will be orphaned." Strip the `## Plan` section from the active SHELL.md if operator confirms. **Unattended mode: warn only — never strip.**

### 5. Update templates

`templates_changed` is now a list of classified file objects `{ name, class }` (not bare strings). Each entry represents a file that differs from upstream or is absent. Resolve by class:

- **`missing`**: `templates/<name>` was absent. Copy `${CLAUDE_PLUGIN_ROOT}/state-templates/<name>` → `.claude-code-hermit/templates/<name>`. Report: "Restored missing template: `<name>`."
- **`unmodified`**: operator never customized it (baseline == on-disk, or no manifest entry). Copy upstream over it silently.
- **`customized-kept`**: operator edited it and the template hasn't moved. **Keep the operator's copy unchanged.** Collect in a summary line at the end: "Kept N operator-customized template(s): `<name>`, ..."
- **`conflict`**: both the operator and the template changed since hatch.
  - **Interactive session** (operator typed the command): present a three-way diff summary and `AskUserQuestion` with options: "Keep mine" / "Take new" / "Merge manually later". Default: keep mine. If "Take new": copy upstream over it and preserve old copy as `<name>.bak`. If "Merge manually": write upstream as `<name>.new` beside the operator's copy, leave the operator's copy live.
  - **Unattended mode**: write upstream as `<name>.new` beside the operator's copy, keep operator's copy live. Report one channel line: "N template conflict(s) parked as .new — review when convenient: `<name>`, ..."

If `templates_changed` is empty, skip.

After all template resolutions (see manifest-write note at end of Step 5b).

**Never touch:** sessions, proposals, OPERATOR.md, HEARTBEAT.md (operator-editable), or config.json (handled separately).

Only update files in `templates/`:

- `SHELL.md.template`
- `SESSION-REPORT.md.template`
- `PROPOSAL.md.template`

Note: SHELL.md.template no longer has a `## Plan` section — plan tracking is now handled by native Claude Code Tasks.

### 5a. Migrate obsidian/ surface

If `<project-root>/obsidian/` exists in the target project:

- Leave the directory untouched — operators may have customised it.
- Append to `.claude-code-hermit/sessions/SHELL.md` Findings: `"obsidian/ no longer maintained by hermit; safe to delete or keep as personal vault."`
- Also leave `.claude-code-hermit/cortex-manifest.json` in place if present — operator-managed.

### 5b. Update boot script wrappers

`bin_changed` entries carry `boot_critical: true` (all bin/ wrappers are boot wrappers — a stale one can dead-end the hermit). Resolution by class:

- **`missing`**: wrapper was absent. Copy `${CLAUDE_PLUGIN_ROOT}/state-templates/bin/<name>` → `.claude-code-hermit/bin/<name>`. `chmod +x`. Report: "**Restored missing boot wrapper: `<name>`.**"
- **`unmodified`**: operator never customized it. Copy upstream over it silently.
- **`customized-kept`**: operator edited it; template hasn't moved. Keep the operator's copy. Summary line: "Kept N operator-customized wrapper(s): `<name>`, ..."
- **`conflict`** (any context — **no `.new` parking for boot-critical files**): replace with the upstream version (`chmod +x`) and save the operator's copy as `<name>.bak`. Report loudly in the run report and channel (if applicable): "**Boot wrapper `<name>` had local changes — replaced with new version; your copy saved as `<name>.bak`.**"

If `bin_changed` is empty, skip the copy (still confirm executability for all files in `bin/`).

**Bootstrap safety net** (`manifest_bootstrap: true` in the plan): on the first evolve after this feature ships (no manifest yet), any template or bin file that gets overwritten or restored also gets a one-time `<name>.bak` alongside it. This makes the quiet bootstrap recoverable: if an existing customization was already present before the manifest was seeded, it survives in the `.bak`. One noisy set of `.bak` files, once, then quiet thereafter.

### 5c. Update the Docker entrypoint (boot-critical, manifest-managed)

`docker_entrypoint` in the plan is a single classified object `{ name, class, boot_critical }`, or `null` when the project has no deployed `docker-entrypoint.hermit.sh` (non-Docker project — skip this step). The entrypoint is placeholder-free, so it is managed exactly like a boot-critical `bin/` wrapper. On-disk file: `<project-root>/docker-entrypoint.hermit.sh`; upstream: `${CLAUDE_PLUGIN_ROOT}/state-templates/docker/docker-entrypoint.hermit.sh.template`. Resolve by class:

- **`unmodified`**: operator never customized it. Copy upstream over it silently.
- **`customized-kept`**: operator edited it; template hasn't moved. Keep the operator's copy. Summary line: "Kept operator-customized docker-entrypoint.hermit.sh."
- **`conflict`** (any context — no `.new` parking for boot-critical files): replace with the upstream version, and save the operator's copy to a **gitignore-safe backup inside the state tree**: `.claude-code-hermit/state/docker-entrypoint.hermit.sh.<UTC-timestamp>.bak`. Do NOT write the backup next to the project-root entrypoint — that path is not gitignored and would surface as an untracked file in the operator's repo. Report loudly (run report + channel): "**docker-entrypoint.hermit.sh had local changes — replaced with the new version; your copy saved as `<backup path>`.** Rebuild to apply: `.claude-code-hermit/bin/hermit-docker update`."
- (`missing` is never emitted for the entrypoint — the plan returns `null` when it is absent — so there is no restore branch.)

**Per-file bootstrap (`bootstrap: true` on the entry).** The plan sets this when no docker entrypoint baseline was recorded yet (e.g. a Docker deploy from before this version, where the manifest exists for `templates/`/`bin/` but `/docker-setup` never recorded the entrypoint hash). In that state the class falls back to `unmodified`, but a silent overwrite would destroy an operator customization that can't be distinguished from an old upstream copy. So: **whenever `bootstrap` is true and you are about to overwrite, FIRST write the operator's current copy to the gitignore-safe `.claude-code-hermit/state/docker-entrypoint.hermit.sh.<UTC-timestamp>.bak`**, then apply the class action, and report the backup path. This is a one-time net — the manifest records the baseline below, so it won't recur. (The global `manifest_bootstrap: true` net does NOT cover this case: the manifest is present, just missing the docker key.)

The replaced entrypoint takes effect only after a rebuild (Step 10 carries the reminder).

**After resolving Steps 5 (templates), 5b (bin/), and 5c (docker entrypoint)**, write `state/template-manifest.json`:
- For each file that was copied, replaced, or restored: record `"<prefix>/<name>": { "sha256": "<hash of the new on-disk content>", "plugin_version": "<plan.to>" }`. Prefixes: `templates/`, `bin/`, and for the entrypoint the literal key `docker/docker-entrypoint.hermit.sh`.
- For files classified `customized-kept`: leave their existing manifest entry unchanged.
- **Preserve every manifest entry under a prefix this run did not touch.** Read the existing manifest first and keep entries whose keys are not in the set you just resolved (the same re-init merge rule `hatch` uses). In particular, do NOT drop the `docker/docker-compose.hermit.yml.template` and `docker/Dockerfile.hermit.template` baselines that `/docker-setup` records (Step 10 reads them) or any sibling-hermit keys. Merge into the existing `files` map — never replace it wholesale.
- If `manifest_bootstrap` was true: seed the full manifest — for every managed file under `templates/` and `bin/` (and the entrypoint, if deployed), record the hash of whatever is now on-disk (after any overwrites) plus the current `plugin_version`. This is the one-time baseline seeding.
- Write the merged manifest as `state/template-manifest.json` with `{ "version": 1, "files": { ... } }`.
- Read the current sha256 of each on-disk file for the manifest (don't trust cached buffers).

### 6. Update CLAUDE-APPEND block

The target file is determined by `hatch_target` (resolved in Step 1):
- `hatch_target == "local"` → `CLAUDE.local.md`
- `hatch_target == "committed"` → `CLAUDE.md`

If the plan's `claude_append_changed` is `false`, skip this step. If `true`, read `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` for the new content, then branch on the plan's `claude_append_old_block`:

- **`claude_append_old_block` present** (marker found — replace case): the new content is the marker-onward portion of `CLAUDE-APPEND.md` (from the `<!-- claude-code-hermit: Session Discipline -->` marker to its end; the leading `---` already sits above the marker in the target). Apply a targeted `Edit` to the target file with `old_string` = `claude_append_old_block` (the exact current block) and `new_string` = that marker-onward content. **Do not read the whole target file** — the exact `old_string` is supplied by the plan, and the `---` must not be duplicated.
- **`claude_append_old_block` absent** (marker not found — append case): append the **full `CLAUDE-APPEND.md` including its leading `---`** to the target file (same as init — the `---` separates the project's content from the block).
- Report what changed.

### 7. Hermit upgrades

- Detect installed hermits: run `claude plugin list --json`, then apply the **project-or-local + enabled filter**:
  - Keep `enabled == true` AND (`scope == "project"` OR `scope == "local"`) AND `projectPath` equals the current project root.
  - Drop user-scope, managed-scope, disabled, and cross-project entries.

  Then keep entries whose plugin name (substring of `id` left of `@`) contains "hermit" but is NOT "claude-code-hermit". Use `installPath` for each entry as the source of `plugin.json`, `CHANGELOG.md`, and `state-templates/CLAUDE-APPEND.md`.
- **Gate on `_hermit_versions` key existence** — only consider a hermit for upgrade when its name is *already* a key in `_hermit_versions`. Without this gate the skill would execute uninstalled hermits' Upgrade Instructions and append their CLAUDE-APPEND blocks. Initial activation is owned by the hermit's own `hatch` skill, which is what writes the key.
- For each gated hermit:
  - Read `<installPath>/.claude-plugin/plugin.json` for the current version
  - Compare against `_hermit_versions[hermit_name]`
  - If version gap exists:
    - Read `<installPath>/CHANGELOG.md` if it exists and extract version entries between the config version (exclusive) and the current version (inclusive)
    - Present a summary: "{hermit_name}: upgrading from vOLD to vNEW. Here's what changed:" followed by only the relevant changelog sections
    - **Execute migrations in version order** — For each extracted version entry (oldest first), look for a `### Upgrade Instructions` section. If found, execute every instruction in that section — do not skip or merely display them.
    - **Sync hermit's CLAUDE-APPEND block** — Same procedure as step 6 (write to the `hatch_target` file), using:
      - Source template: `<installPath>/state-templates/CLAUDE-APPEND.md`. If it doesn't exist, skip.
      - Marker: the first HTML comment line in that template (e.g. `<!-- hermit-name: Section Title -->`)
    - Update `_hermit_versions[hermit_name]` to the current hermit version
  - If no gap: skip silently
- For hermits detected on disk but **not** present in `_hermit_versions`: skip silently. The operator opted in to core only; sibling activation belongs to that sibling's own `hatch`.

### 8. Ensure plugin permissions in settings file

Same logic as init step 8, but target the file determined by `hatch_target` (resolved in Step 1):
- `hatch_target == "local"` → `.claude/settings.local.json`
- `hatch_target == "committed"` → `.claude/settings.json`

Check the target settings file for the plugin's required permissions (`git diff/status/log`, per-script `bun` entries, the SessionStart `bash -c` hook, and `Edit`/`Write` on `.claude-code-hermit/**`). The required entries are: `cost-tracker.ts`, `suggest-compact.ts`, `run-with-profile.ts`, `evaluate-session.ts`, `append-metrics.ts`, `generate-summary.ts`, `cron-tz-shift.ts`, `archive-shell.ts`, `evolve-plan.ts`. If any are missing, show the operator which ones and ask for confirmation before adding. **Unattended mode: add the missing entries without asking** (a missing `bun` permission breaks hooks, so this is non-optional), and report them loudly in the run report + Step 10 channel notification. Only add missing entries — never remove existing ones. If all are already present, skip silently. Also remove stale permissions from previous versions if found in the target file:

- `Bash(python3:*)`, `Bash(node:*)` — replaced by scoped bun entries
- `Edit(.claude/.claude-code-hermit/**)`, `Write(.claude/.claude-code-hermit/**)` — replaced by `.claude-code-hermit/**` (v0.0.6 path change)

### 9. Write updated config

- **Re-read `.claude-code-hermit/config.json` now** — Step 2b migrations may have written keys since the pre-pass ran.
- For each entry in `new_config_keys` (plus interactive answers from Step 4), set `path` to its value **only if that path is still missing** in the freshly-read config. Never overwrite an existing operator or migration-set value.
- Update `_hermit_versions["claude-code-hermit"]` to the current plugin version (the plan's `to`)
- For hermits: only update versions for hermits already present as keys in `_hermit_versions` — never add new keys here
- Write to `.claude-code-hermit/config.json`

### 10. Report

Print a summary:

```
Upgrade complete: vOLD -> vNEW

New settings configured:
  Agent name:  Atlas
  Language:    pt
  Timezone:    Europe/Lisbon
  Escalation:  balanced
  Sign-off:    Atlas out.

Templates updated:
  SHELL.md.template (refreshed)
  SESSION-REPORT.md.template (unchanged)
  PROPOSAL.md.template (unchanged)

CLAUDE.md:
  Session discipline block updated

Hermits:
  example-hermit: v0.2.0 -> v0.3.0 (updated)

Run /claude-code-hermit:hermit-settings to adjust any settings.
```

Adjust the summary based on what actually changed. Omit sections where nothing changed.

**Docker rebuild notice.** If the plan's `docker_entrypoint` was a `conflict`/`unmodified` that you refreshed in Step 5c, OR `docker_templates` (from F2) is non-empty, append a `Docker:` section telling the operator a rebuild is needed and in what order:

- Entrypoint refreshed (Step 5c) → "Docker entrypoint refreshed. Rebuild to apply: `.claude-code-hermit/bin/hermit-docker update`."
- `docker_templates` entries with `status: "changed"` (compose/Dockerfile moved upstream) → "Docker template(s) changed upstream: `<names>`. These render with your config, so refresh them FIRST, then rebuild — in this order: (1) re-run `/claude-code-hermit:docker-setup` (it backs up and re-renders), (2) THEN `hermit-docker update`. Rebuilding first bakes the stale on-disk files into the image." Lead with the compose file; the entrypoint is already handled by Step 5c.
- `docker_templates` entries with `status: "unknown"` → "Docker template baseline not recorded (deployed before this version). Run `/claude-code-hermit:docker-setup` once to arm the drift signal; until then a rebuild can't be drift-checked."
- Never auto-rebuild. In unattended mode this whole section is report-only and rides the channel notification below.

After printing the summary, notify the operator per CLAUDE-APPEND.md § Operator Notification with a condensed one-line message such as `"Hermit upgraded: vOLD → vNEW. N settings added, M templates refreshed."` Omit segments where nothing changed. **In unattended mode, append the deferred/auto-applied segments** to this notification: settings set to defaults (Step 4), permission entries added without confirmation (Step 8), and any migration steps deferred for operator review (Steps 2b/7) — so the operator can follow up via `/hermit-settings`.
