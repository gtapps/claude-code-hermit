---
name: hermit-evolve
description: Evolves hermit configuration and templates after a plugin update. Detects version gaps and runs the upgrade (migrations, templates, new settings) in an isolated subagent. Run after updating the plugin.
---

# Evolve Hermit

Upgrade the project's hermit configuration after a plugin update.

## Execution routing

Every run of this skill (interactive or unattended) delegates steps 0–9 to the `claude-code-hermit:evolve-runner` subagent, so the upgrade's transient churn (changelog slice, migration execution, file diffs) never lands in the calling session. The main loop keeps only step 10 (summary + operator notification).

> **Tool note:** `claude-code-hermit:evolve-runner` is a **subagent** — invoke it via the Agent tool, never the Skill tool. The `plugin:name` form it shares with skills does not imply the Skill tool.

- **If you are running AS the `evolve-runner` subagent**, skip this section and execute steps 0–9 directly (you are the delegate — do not re-dispatch).
- **Otherwise (main loop, any mode):**
  1. **Determine the mode** and remember it for step 10: positional argument `unattended`, or running in an always-on session invoked via channel ⇒ *unattended*; else *interactive*.
  2. **Bake the absolute plugin root** to thread to the subagent (it cannot resolve it itself — the bare env var `$CLAUDE_PLUGIN_ROOT` is **not** set at Bash runtime, and the value is empty inside subagents). Derive it from this skill's **Base directory**, which the harness injects in the skill invocation context as `<plugin_root>/skills/hermit-evolve`: strip the trailing `/skills/hermit-evolve` to get `plugin_root`. This works in both installed and `--plugin-dir` modes. (In installed mode this equals the harness's `${CLAUDE_PLUGIN_ROOT}` substitution, which step 1 relies on; the Base-directory derivation is the mode-independent source.) **Guard:** confirm `test -f "<plugin_root>/skills/hermit-evolve/SKILL.md"`. If it fails, **abort** — log `"hermit-evolve aborted: plugin root unresolved; cannot dispatch evolve-runner."` and stop. Do not dispatch with a broken path.
  3. **Dispatch** the `claude-code-hermit:evolve-runner` subagent via the Agent tool. Pass the baked absolute plugin root and the report contract (below). Do **not** execute steps 0–9 yourself.
  4. **Go to step 10** with the subagent's returned report.

## Delegated mode

Steps 0–9 below are executed by the `evolve-runner` subagent, which has no `AskUserQuestion` and cannot pause to ask. Each step's **"Delegated mode:"** note states the non-interactive behavior. The rule in every case: never guess on a destructive choice, never block.

- For any interactive choice with a safe non-destructive default (new settings, file deletions, `## Plan` strip, template conflicts), take the default silently and report it.
- For a genuine either/or with **no safe default** (an `### Upgrade Instructions` migration step in 2b/7), **defer**: skip that step and record a verbatim deferred-migration block in the report (see the report contract in step 10). Never guess. Step 10 resolves it — interactive asks the operator, unattended relays it to the channel.

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

**Version check:** the plan reports `from`, `to`, `up_to_date`, and `work_pending`. If `work_pending` is `false` (core current AND no sibling gap, drift, path-unresolved, or warnings), report "You're up to date (v<to>). Nothing to upgrade." and stop. If `up_to_date` is `true` but `work_pending` is `true` (sibling-only work), announce: "Core is current (v<to>); processing sibling hermits." and run only Steps 7, 8, 9, and 10 — the core-content steps (2 through 6) have no pending work when core is current. (Sibling migrations and CLAUDE-APPEND sync happen inside Step 7.) Otherwise (core has a gap) announce: "Upgrading from v<from> to v<to>." and run all steps.

### 2. Present the changelog

Present the plan's `changelog_slice` to the operator: "Here's what changed:" followed by the slice. It already contains only the entries in `(from, to]`, oldest-first — no full-file read.

### 2b. Execute version migrations

Within `changelog_slice` (already ordered oldest-first), each version entry may contain a `### Upgrade Instructions` section:

1. Find the `### Upgrade Instructions` section within each version's entry
2. If found, execute every instruction in that section — these are the authoritative migration steps
3. Collect any version-specific operator notes for the step-10 report (delegated mode has no operator to present to live)
4. **Delegated mode:** if a step is interactive (poses an either/or), do not ask. Apply the non-destructive default (e.g. a delete/cleanup offer → keep the file) and note it for step 10. If the step has **no safe default**, **defer** — skip it and record a verbatim deferred-migration block per the Delegated mode rules.

The CHANGELOG.md `### Upgrade Instructions` sections are the single source of truth for migrations — do not skip or merely display them. The same pattern applies to sibling-hermit upgrades in Step 7.

**Surgical docker-template migrations.** An Upgrade Instruction may surgically patch a wizard-rendered docker template (`Dockerfile.hermit`) and re-record its `template-manifest.json` baseline. When it does, it sets the report's `Docker rebuild` field to `base-patched`. Treat the corresponding `docker_templates` drift entry as resolved — do **not** surface it as unresolved upstream drift in Step 10.

### 3. New config keys

The plan's `new_config_keys` array lists every key in the current `config.json.template` that is missing from the project's config, each as `{path, default}` — a dotted `path` for a nested leaf, or a fully-absent parent carrying its whole default subtree. Operator-set values are never listed, so acting on these never overwrites them.

### 4. Apply new settings

**Delegated mode:** add **every** entry in the plan's `new_config_keys` silently with its `default` from the plan — operator-set values are never listed by the plan, so this never overwrites a choice. There is no prompting (the subagent can't `AskUserQuestion`). The former identity/preference keys below are almost always already set by evolve time, so they rarely appear; when one does, it takes the plan `default` and the operator adjusts via `/hermit-settings`. Collect every silently-set key for the step-10 report. If `new_config_keys` is empty, skip this step.

Special-default keys (apply the noted default when the key is in `new_config_keys`):
- `language` (0.0.1) / `timezone` (0.0.1): when missing, the subagent **auto-detects** the value (`$LANG` / system timezone via `date +%Z`/`timedatectl`) and writes that, rather than the static plan default. (These are 0.0.1 keys, set at hatch, so they are almost never missing at evolve time.)
- All other keys: apply the plan's `default` verbatim (operator tunes via `/hermit-settings` afterward). The canonical defaults live in `state-templates/config.json.template`; `evolve-plan.ts` derives each `new_config_keys[].default` from it, so there is no separate default list to maintain here.

The actual write happens in step 9 (merge into config, missing-only); this step just records which keys to set.

### 4-task. Write task list ID to settings.local.json

If `CLAUDE_CODE_TASK_LIST_ID` is not already set in `.claude/settings.local.json`:

1. Derive: `hermit-{project_basename}` (lowercase, alphanumeric + hyphens)
2. Read `.claude/settings.local.json`, merge into `env` block, write back

Also: if an active SHELL.md has a `## Plan` section (legacy plan table), note it for the step-10 report: "Close active sessions before upgrading, or the old plan table will be orphaned." **Delegated mode: warn only — never strip** (stripping needs operator confirmation, which the subagent can't get).

### 5. Update templates

`templates_changed` is now a list of classified file objects `{ name, class }` (not bare strings). Each entry represents a file that differs from upstream or is absent. Resolve by class:

- **`missing`**: `templates/<name>` was absent. Copy `${CLAUDE_PLUGIN_ROOT}/state-templates/<name>` → `.claude-code-hermit/templates/<name>`. Report: "Restored missing template: `<name>`."
- **`unmodified`**: operator never customized it (baseline == on-disk, or no manifest entry). Copy upstream over it silently.
- **`customized-kept`**: operator edited it and the template hasn't moved. **Keep the operator's copy unchanged.** Collect in a summary line at the end: "Kept N operator-customized template(s): `<name>`, ..."
- **`conflict`**: both the operator and the template changed since hatch.
  - **Delegated mode** (always — non-boot templates): write upstream as `<name>.new` beside the operator's copy, keep the operator's copy live (lossless; conflict resolution needs a prompt the subagent can't issue). Collect for the step-10 report: "N template conflict(s) parked as .new — review when convenient: `<name>`, ..."

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

**After resolving Steps 5 (templates), 5b (bin/), and 5c (docker entrypoint)**, record the new pristine-baselines in `state/template-manifest.json` via `manifest-seed.ts` — **do not hand-compute the hashes** (the script makes them correct by construction; an LLM cannot sha256 reliably). Decide *which* files to record, then hand them to the script:
- **Which files:** every file that was copied, replaced, or restored in Steps 5/5b/5c. Build one `{ "key": "<prefix>/<name>", "file": "<on-disk path of the new content>" }` entry per such file. Prefixes: `templates/` (file `.claude-code-hermit/templates/<name>`), `bin/` (file `.claude-code-hermit/bin/<name>`), and for the entrypoint the literal key `docker/docker-entrypoint.hermit.sh` (file: the project-root `docker-entrypoint.hermit.sh`).
- **`customized-kept` files:** do NOT include them — the script preserves their existing manifest entry unchanged via foreign-key preservation.
- **If `manifest_bootstrap` was true:** include the full managed set — every `templates/` and `bin/` file (and the entrypoint, if deployed), hashing whatever is now on-disk after any overwrites. This is the one-time baseline seeding.
- **Run** `bun ${CLAUDE_PLUGIN_ROOT}/scripts/manifest-seed.ts .claude-code-hermit` with `{ "pluginVersion": "<plan.to>", "entries": [ ... ] }` on stdin. The script hashes each on-disk file, merges into the existing `files` map — preserving untouched prefixes, sibling-hermit keys, and the `docker/docker-compose.hermit.yml.template` / `docker/Dockerfile.hermit.template` baselines `/docker-setup` records (Step 10 reads them) — and writes `{ "version": 1, "files": { ... } }`. It refuses to overwrite a present-but-corrupt manifest. This replaces the manual "merge into the existing `files` map, never replace wholesale" handling.
- **Ordering:** run this *after* Step 8 has ensured the plugin permissions, so `bun */scripts/manifest-seed.ts*` is allowed. The files resolved in Steps 5/5b/5c are stable on disk, so deferring the manifest write to after Step 8 does not change the recorded hashes.

### 6. Update CLAUDE-APPEND block

The target file is determined by `hatch_target` (resolved in Step 1):
- `hatch_target == "local"` → `CLAUDE.local.md`
- `hatch_target == "committed"` → `CLAUDE.md`

If the plan's `claude_append_changed` is `false`, skip this step. If `true`, read `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` for the new content, then branch on the plan's `claude_append_old_block`:

- **`claude_append_old_block` present** (marker found — replace case): the new content is the marker-onward portion of `CLAUDE-APPEND.md` (from the `<!-- claude-code-hermit: Session Discipline -->` marker to its end; the leading `---` already sits above the marker in the target). Apply a targeted `Edit` to the target file with `old_string` = `claude_append_old_block` (the exact current block) and `new_string` = that marker-onward content. **Do not read the whole target file** — the exact `old_string` is supplied by the plan, and the `---` must not be duplicated.
- **`claude_append_old_block` absent** (marker not found — append case): append the **full `CLAUDE-APPEND.md` including its leading `---`** to the target file (same as init — the `---` separates the project's content from the block).
- Report what changed.

### 7. Hermit upgrades

The plan's `siblings[]` array is the authoritative list (registry-driven from `_hermit_versions`; path-resolved by `evolve-plan.ts` with the project-scope + realpath filter). Do not re-run `claude plugin list --json` here.

For each entry in `plan.siblings`:

- **Version gap (`up_to_date == false`):**
  - Present: "{name}: upgrading from v{from} to v{to}. Here's what changed:" followed by `changelog_slice` (already bounded to the gap range, oldest-first).
  - **Execute migrations** — within `changelog_slice`, find each version's `### Upgrade Instructions` section and execute every instruction in version order. Same rules as Step 2b: non-interactive default on ambiguous steps; defer if no safe default.
  - **Sync CLAUDE-APPEND block** — same procedure as Step 6, using `sibling.marker` and `sibling.claude_append_old_block` (replace case) or append case when `old_block` is absent. Apply the Edit **only here, on a version gap**.
  - Collect the sibling name for the `--sibling=<name>=<to>` flag in Step 9.

- **No version gap (`up_to_date == true`) + `claude_append_changed == true`:**
  - **Do NOT apply a CLAUDE-APPEND Edit.** We cannot distinguish a deliberate operator edit from a missed sync at this diff level; auto-writing would clobber operator changes.
  - Report as `<name> block-drifted` — advisory note for the operator to review manually.

- **No version gap + `claude_append_changed == false` (or absent):** report `<name> current`, skip.

If `plan.siblings_path_unresolved` is non-empty, report each as `<name> path-unresolved` (registered in `_hermit_versions` but not found in the project-effective plugin list).

If `plan.siblings_detected_unregistered` is non-empty, report each as "detected but not activated: <name> — run `/<name>:hatch` to register." Never auto-activate; the opt-in gate stays.

If `plan.siblings_warnings` is non-empty, surface each warning (e.g. plugin-list unavailable, CHANGELOG unreadable).

### 8. Ensure plugin permissions in settings file

Same logic as init step 8, but target the file determined by `hatch_target` (resolved in Step 1):
- `hatch_target == "local"` → `.claude/settings.local.json`
- `hatch_target == "committed"` → `.claude/settings.json`

Check the target settings file for the plugin's required permissions (`git diff/status/log`, per-script `bun` entries, the SessionStart `bash -c` hook, and `Edit`/`Write` on `.claude-code-hermit/**`). The required entries are: `cost-tracker.ts`, `suggest-compact.ts`, `evaluate-session.ts`, `append-metrics.ts`, `generate-summary.ts`, `cron-tz-shift.ts`, `archive-shell.ts`, `evolve-plan.ts`, `evolve-finalize.ts`, `manifest-seed.ts`. **Delegated mode: add any missing entries without asking** (a missing `bun` permission breaks hooks, so this is non-optional), and collect them for the step-10 report. Only add missing entries — never remove existing ones. If all are already present, skip silently. Also remove stale permissions from previous versions if found in the target file:

- `Bash(python3:*)`, `Bash(node:*)` — replaced by scoped bun entries
- `Edit(.claude/.claude-code-hermit/**)`, `Write(.claude/.claude-code-hermit/**)` — replaced by `.claude-code-hermit/**` (v0.0.6 path change)
- `Bash(bun */scripts/run-with-profile.ts*)` — the run-with-profile wrapper was removed; profile-gated hooks now self-gate on `AGENT_HOOK_PROFILE`

### 9. Write updated config

- **Re-read `.claude-code-hermit/config.json` now** — Step 2b migrations may have written keys since the pre-pass ran.
- For each entry in `new_config_keys` (with the defaults applied in Step 4), set `path` to its value **only if that path is still missing** in the freshly-read config. Never overwrite an existing operator or migration-set value. Write these merged keys to `.claude-code-hermit/config.json` before running the finalizer below.
- **Bump `_hermit_versions` deterministically — do NOT hand-edit this key.** After the `new_config_keys` merge above is written to disk, run the finalizer. It re-reads config from disk, writes the version bumps atomically, and prints the confirmed on-disk values:

  ```
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/evolve-finalize.ts .claude-code-hermit --core=<to> --plugin-root=${CLAUDE_PLUGIN_ROOT} [--sibling=<name>=<vNEW> ...]
  ```

  - `<to>` is the plan's `to`. Add one `--sibling=<name>=<vNEW>` for each sibling hermit with a **version gap** that was upgraded in Step 7 (where `name` is the sibling's plugin name and `vNEW` is its `sibling.to`). Omit `--sibling` for no-gap siblings (no version to bump). Omit `--sibling` entirely if no siblings had a gap.
  - **When `plan.up_to_date` is `true` (core current, sibling-only run):** the plan's `to` is still used as `--core=<to>`. evolve-finalize will bump the core key to `to`, which is a no-op (core was already at that version). This keeps the finalizer as the single atomic writer.
  - Parse stdout as JSON. The finalizer's `core.confirmed` is the **authoritative on-disk version** — use it as `vNEW` in the Step 10 report, NOT `plan.to`.
  - If `core.matched` is `false` or `errors` is non-empty, the bump did not land: set the `Upgrade:` line in the Step 10 report to `blocked: config version bump failed (<joined errors>)` and stop.

### 10. Report

**Step 10 runs in the main loop** (not the subagent), consuming the `evolve-runner`'s returned report. The subagent's report is the single source for what follows.

**Report contract** — the subagent's final message is exactly this; non-deferred runs carry no deferred block, so the common payload is tiny:

```
Upgrade: vOLD -> vNEW | core current vNEW | blocked: <reason>
Settings added: <keys | none>
Templates: <refreshed/restored/kept-N/conflicts-parked-N | none>
Bin wrappers: <restored/replaced(.bak) | none>
Docker entrypoint: <refreshed | conflict-replaced(<backup path>) | n/a>
Docker rebuild: <needed + order | base-patched | no>
CLAUDE-APPEND: <updated | unchanged>
Sibling hermits: <one or more of the following per sibling, space-separated, or "none">
  <name vOLD->vNEW>           (confirmed by finalizer — only from siblings_confirmed)
  <name current>              (no version gap)
  <name block-drifted>        (no gap but CLAUDE-APPEND differs from template — advisory only, not edited)
  <name path-unresolved>      (in _hermit_versions but no project-effective plugin-list match)
  <name SKIPPED-by-finalizer> (finalizer's siblings_skipped — never report as upgraded)
Siblings detected but not activated: <name ... | none>
Siblings warnings: <one line per siblings_warnings entry | none>
Permissions added: <entries | none>
Deferred for operator: <none | one or more verbatim blocks, each:>
  --- deferred-migration ---
  source: <plugin>@<version>
  instruction: |
    <exact verbatim ### Upgrade Instructions step text — copied, not summarized>
  options: <the either/or choices presented>
  skipped: <the safe/no-op branch taken, or "skipped pending operator">
  --- end ---
```

**Sibling report integrity:** parse the finalizer JSON `siblings_confirmed` and `siblings_skipped`. Only names in `siblings_confirmed` may be reported as `vOLD->vNEW`. Any name in `siblings_skipped` must be reported as `SKIPPED-by-finalizer` — never as upgraded, even if Step 7 said it ran.

**Failure fallback.** If the Agent call returned null/empty (subagent died — same partial-state risk as an in-loop failure), report "evolve delegation failed — run `/claude-code-hermit:hermit-evolve` manually" and fire that as the channel notification. Stop.

**Print the summary** from the report fields. Omit lines where nothing changed. End with "Run /claude-code-hermit:hermit-settings to adjust any settings." if settings were added.

**Resolve deferrals by mode.** If "Deferred for operator" is non-empty:
- **Interactive:** for each deferred-migration block, present its `instruction` + `options` to the operator via `AskUserQuestion`, then apply the chosen branch inline (this is the only place changelog/migration text re-enters the main loop, and only for the rare deferred step).
- **Unattended:** relay each deferred block to the channel verbatim ("migration deferred for operator review: <source> — <instruction>"). Do not apply.
- **Version-bump caveat (both modes):** the subagent already bumped `_hermit_versions` to `<to>` in step 9, having *skipped* the deferred migration. We keep that bump — withholding it would replay the whole oldest-first slice next evolve and double-apply non-idempotent migrations. So if an interactive apply **fails or the operator declines**, report loudly (summary + channel): "version already bumped to v`<to>`; migration `<source>` was NOT applied; apply manually: `<instruction>`" — otherwise a rerun-says-up-to-date would silently hide it. On success, report it applied.

**Docker rebuild notice.** From the report's `Docker entrypoint` / `Docker rebuild` fields, append a `Docker:` section when a rebuild is needed:
- Entrypoint refreshed → "Docker entrypoint refreshed. Rebuild to apply: `.claude-code-hermit/bin/hermit-docker update`."
- `Docker rebuild: base-patched` → "Docker base image updated. Rebuild to apply: `.claude-code-hermit/bin/hermit-docker update`. Do **not** re-run `/docker-setup` — your Dockerfile customizations are preserved." When this value is present, **suppress** the "Compose/Dockerfile changed upstream" bullet below for `Dockerfile.hermit` (the migration already handled it).
- Compose/Dockerfile changed upstream → "Docker template(s) changed upstream. Refresh FIRST, then rebuild: (1) re-run `/claude-code-hermit:docker-setup`, (2) THEN `hermit-docker update`. Rebuilding first bakes stale on-disk files into the image."
- Baseline not recorded → "Docker template baseline not recorded. Run `/claude-code-hermit:docker-setup` once to arm the drift signal."
- Never auto-rebuild.

**Notify the operator** per CLAUDE-APPEND.md § Operator Notification with a condensed one-line message such as `"Hermit upgraded: vOLD → vNEW. N settings added, M templates refreshed."` Omit segments where nothing changed. **Append the deferred/auto-applied segments**: settings set to defaults (Step 4), permission entries added (Step 8), template conflicts parked as `.new` (Step 5), and any deferred migrations — so the operator can follow up via `/hermit-settings`.
