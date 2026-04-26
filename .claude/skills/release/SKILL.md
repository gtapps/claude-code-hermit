---
name: release
description: Bump a plugin's version, write a detailed changelog entry for the upgrade skill to consume, and commit+push. Takes a plugin slug argument identifying which plugin under `plugins/` to release. Use this skill whenever the user says "release", "version bump", "cut a release", "changelog and push", or finishes a set of changes and wants to ship them. Also trigger when the user says "do the release thing" or asks to prepare changes for hermits to pick up.
---
# Release

Bump version, write changelog, commit, and push for a single plugin in the monorepo. The changelog entry is critical because the upgrade skill (`skills/hermit-evolve/SKILL.md`) reads it to know what to tell hermits during `/claude-code-hermit:hermit-evolve`.

## Usage

`/release <plugin-slug>` — release the plugin at `plugins/<plugin-slug>/`.

Examples:
- `/release claude-code-hermit` — release the core plugin
- `/release claude-code-dev-hermit` — release the dev hermit
- `/release claude-code-homeassistant-hermit` — release the HA hermit

If invoked without a slug, list all `plugins/<name>/` directories that contain `.claude-plugin/plugin.json` and ask the operator which one via AskUserQuestion before proceeding.

## Steps

### 0. Identify target plugin

Resolve the plugin slug:
- If the user passed `<slug>` as argument, use that.
- Otherwise, glob `plugins/*/.claude-plugin/plugin.json`, collect the directory names, and ask via AskUserQuestion: "Which plugin to release?" with one option per slug.

Validate `plugins/<slug>/.claude-plugin/plugin.json` exists. If it does not, abort: `Plugin 'plugins/<slug>/' not found.` Suggest the available slugs.

Throughout the rest of this skill, `$PLUGIN_DIR` refers to `plugins/<slug>/`.

### 1. Pre-release validation

Run before anything else. Abort the release if any step fails.

1. **Run the native plugin validator from the repo root:**
   Run `/plugin validate .` in the session. This validates the entire marketplace including all plugins under `plugins/`. If it reports any errors, stop and fix before releasing.

2. **Run test suites for the target plugin.** Detect the convention and dispatch:
   - If `plugins/<slug>/tests/run-all.sh` exists (bash entrypoint, used by core hermit):
     ```bash
     bash plugins/<slug>/tests/run-all.sh 2>&1
     ```
   - Else if `plugins/<slug>/tests/conftest.py` or any `plugins/<slug>/tests/test_*.py` exists (pytest convention, used by HA hermit):
     ```bash
     cd plugins/<slug> && .venv/bin/pytest tests/ -v 2>&1
     ```
     If `.venv/bin/pytest` is missing, abort the release with: `Plugin uses pytest but plugins/<slug>/.venv/bin/pytest is missing — run plugin's hatch/install first.` Do not silently skip — releases must run the suite.
   - Else: no recognized test convention → skip this step and note it in the release report.

   If any test fails, stop and fix before releasing.

3. **Run the release-auditor agent** to cross-reference plugin integrity. Pass it the plugin path explicitly so it knows which plugin to audit:
   - Skills in `plugins/<slug>/CLAUDE.md` / `state-templates/CLAUDE-APPEND.md` match actual `plugins/<slug>/skills/` directories
   - Agents in `plugins/<slug>/CLAUDE.md` match actual `plugins/<slug>/agents/` files
   - Hook scripts referenced in `plugins/<slug>/hooks/hooks.json` exist in `plugins/<slug>/scripts/`
   - State-template JSON files parse correctly
   - `config.json.template` keys are in sync with `DEFAULT_CONFIG` in `plugins/<slug>/scripts/hermit-start.py` (core only)

4. **Check for stale references** — if new skills, agents, or hooks were added since the last release of this plugin:
   - Verify they appear in `plugins/<slug>/CLAUDE.md` quick reference and subagent table
   - Verify they appear in `plugins/<slug>/state-templates/CLAUDE-APPEND.md` quick reference (if that file exists for this plugin)
   - Verify `plugins/<slug>/docs/skills.md` lists them (if that doc exists)

If the auditor reports any FAIL, fix before proceeding. WARNs are acceptable if justified.

### 2. Determine version bump

Read `plugins/<slug>/.claude-plugin/plugin.json` for the current version and `plugins/<slug>/CHANGELOG.md` for recent entries.

Review the uncommitted or recently committed changes (`git diff` and/or `git log` since the last `<slug>-v<version>` tag — fall back to `git log` since the last unprefixed `v<version>` tag for plugins released under the legacy tag scheme) to understand what changed.

Decide the bump level:
- **Patch** (0.0.X) — bug fixes, behavioral changes via updated instructions, small additions
- **Minor** (0.X.0) — new features, new skills, structural changes, breaking config migrations
- **Major** (X.0.0) — only if the user explicitly asks

Present the suggested version and rationale. Wait for confirmation before proceeding.

### 3. Write the changelog entry

Prepend a new entry to `plugins/<slug>/CHANGELOG.md` immediately after the `# Changelog` header, before the previous version entry. If a `[Unreleased]` section already exists, rename it to `[X.Y.Z] - YYYY-MM-DD` instead of prepending a new one — the entry has been accumulating during development.

**Format**:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added / Changed / Fixed
(use whichever sections apply — skip empty ones)

- **component: one-line summary** — optional ≤1-sentence rationale.

### Files affected

| File | Change |
|------|--------|
| `path/to/file` | terse one-line description |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Imperative step title** — what to do, in one sentence.

No `config.json` changes required.
```

**Template constraints (enforce these):**

1. **Narrative bullets (Added / Changed / Fixed)** — each bullet is ONE line, ≤25 words, in this shape:
   `- **component: what changed** — ≤1 sentence of rationale (optional, only if non-obvious).`
   - Lead with the component or subsystem (`reflect:`, `session-mgr:`, `hermit-docker:`).
   - Do NOT list internal refactors, helper extractions, test scaffolding, or renamed variables — those are visible in `git diff`.
   - Do NOT repeat what `Files affected` already shows.
   - Do NOT narrate root cause at length. Fixes describe the behavior change, not the 4-paragraph debugging story.
   - If a change genuinely needs more context, link a commit hash. Don't inline it.

2. **Upgrade Instructions** — strict imperative block:
   - Every step starts with a verb (`Add`, `Replace`, `Copy`, `Run`, `Delete`, `Refresh`).
   - Each step is a single action. No "also do X, but only if Y, unless Z" run-ons — split into separate numbered steps.
   - No passive voice, no rationale clauses. If an operator needs to understand *why*, that belongs in the Changed bullet above, not here.
   - Include what `hermit-evolve` does NOT need to touch only if omission would cause it to act destructively. Otherwise silence.
   - Close with `No config.json changes required.` if true — it's the most common case and operators scan for it.

3. **Files affected table** — one line per file, ≤15 words per Change cell. If a file had many sub-changes, summarize the category, not the enumeration.

4. **What belongs where:**
   - Why it changed → Changed/Fixed bullet.
   - What evolve executes → Upgrade Instructions (imperative, numbered).
   - Behavior deltas that need no action but operators should know → one final line after the numbered list, prefixed `**Note:**`. Not a step.

**The Upgrade Instructions section is the most important part.** The evolve skill reads this to know what actions to take for each hermit. Non-imperative steps cause evolve to misparse or skip them.

### 4. Update CLAUDE.md and CLAUDE-APPEND references

If new skills, agents, or hooks were added in this release:

- Add new skills to the `plugins/<slug>/CLAUDE.md` quick reference list and `plugins/<slug>/state-templates/CLAUDE-APPEND.md` quick reference (if that template exists for this plugin)
- Add new agents to the `plugins/<slug>/CLAUDE.md` subagent table
- Update hook descriptions in `plugins/<slug>/CLAUDE.md` if the hook surface area changed significantly

Skip this step if no new components were added.

### 5. Bump version in all locations

Update the version string in:
- `plugins/<slug>/.claude-plugin/plugin.json` → `"version"` field
- `.claude-plugin/marketplace.json` → find the entry in `plugins[]` where `"name" == "<slug>"` and update its `"version"` field. Other plugin entries are untouched.
- `plugins/<slug>/README.md` → version badge if present: both the `img.shields.io` URL slug (`version-X.Y.Z-green.svg`) and the `alt` text (`Version X.Y.Z`). Confirm with `grep "version-" plugins/<slug>/README.md` that the new version appears and the old one does not. Skip silently if the README has no version badge.

After editing, verify the manifest and marketplace are in sync — the plugin manifest wins silently if they differ:
```bash
jq -r '.version' plugins/<slug>/.claude-plugin/plugin.json
jq -r --arg slug "<slug>" '.plugins[] | select(.name == $slug) | .version' .claude-plugin/marketplace.json
```
Both must print the same string. If they differ, fix `.claude-plugin/marketplace.json` before continuing.

### 6. Final validation

Run tests one more time to confirm nothing broke during the changelog/version edits. Use the same dispatch as step 1.2:
- Bash entrypoint: `bash plugins/<slug>/tests/run-all.sh 2>&1 | tail -6`
- Pytest: `cd plugins/<slug> && .venv/bin/pytest tests/ -v 2>&1 | tail -6`
- Neither: no recognized test convention → skip and note in the release report.

### 7. Commit and push

Stage only the changed files (not `git add -A`). Commit with:

```
<slug> v<X.Y.Z>: One-line summary of the release
```

Push to origin.

### 7a. Branch check before tagging

Run `git branch --show-current` and compare to `main` (or the repo's default branch from `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`).

- **On `main`/default branch** → tag immediately (step 7b).
- **On a release branch** (e.g. `release/X.Y.Z`) → **stop**. Do not tag yet. Tagging the branch tip creates a commit SHA that `main` never carries after merge (PR squash/rebase changes the SHA), leaving the tag stranded on an orphan commit.
  Report the branch name and two options to the user:
  1. **Tag now** — accept the stranded-tag risk; release goes live immediately. Proceed to step 7b.
  2. **Hold tag** — open a PR (offer `/create-pr` if available), wait for merge into `main`, then re-run `/release <slug>` from `main` (it will detect the version is already bumped and skip ahead to tagging) OR run step 7b manually after checkout.
  Wait for explicit user choice before proceeding.

### 7b. Tag and publish

The tag format is **plugin-prefixed**: `<slug>-v<X.Y.Z>`. This avoids collisions when multiple plugins ship from the same monorepo.

```bash
VERSION=$(jq -r '.version' plugins/<slug>/.claude-plugin/plugin.json)
TAG="<slug>-v$VERSION"
git tag "$TAG"
git push origin "$TAG"
gh release create "$TAG" --title "$TAG" --generate-notes
```

**Note on legacy tags:** the core plugin (`claude-code-hermit`) historically released under the unprefixed `v<X.Y.Z>` format (e.g. `v1.0.18`). From the monorepo migration onward, all plugins use the prefixed format. The historical unprefixed tags remain in place; new releases use the prefixed format only. If continuity matters for a specific release, the operator may also push the unprefixed tag manually as an alias — but that is not the skill's responsibility.

### 8. Report

Print the slug, the new version, the commit hash, the tag name, and a one-liner confirming it's pushed.
