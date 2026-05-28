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

1. **Run the native plugin validator (CLI form):**
   ```bash
   claude plugin validate plugins/<slug> 2>&1
   ```
   Abort on any error other than `Unrecognized keys` — that one means an incomplete hermit-meta.json migration; fix the migration elsewhere, then resume. Background on the migration lives in each plugin's `CONTRIBUTING.md`.

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

If the auditor reports any FAIL, fix before proceeding. WARNs are acceptable if justified. Stale-reference detection-and-fix is consolidated into Step 4 below.

### 2. Determine version bump

**Already-bumped fast-path (two-phase release flow):** Find the most recent tag for this plugin:

```bash
git tag --list "<slug>--v*" | sort -V | tail -1
```

Compare its version to `plugin.json`. If `plugin.json` is already ahead (e.g. tag is `dev-hermit--v0.2.0`, plugin.json says `0.3.0`), the version was bumped on a plugin branch that has since merged to main. Skip steps 2–7 entirely — the CHANGELOG, version files, and commit are already done. Jump directly to step 8.

**Normal path:** Read `plugins/<slug>/.claude-plugin/plugin.json` for the current version and `plugins/<slug>/CHANGELOG.md` for recent entries.

Review the uncommitted or recently committed changes (`git diff` and/or `git log` since the last `<slug>--v<version>` tag — fall back to `<slug>-v<version>` for pre-migration releases, then `v<version>` for the legacy unprefixed scheme).

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

1. **Narrative bullets (Added / Changed / Fixed)** — one-line summary in the shape `- **component: what changed** — short rationale if non-obvious.` Target 1–3 lines, ~40 words max. If a bullet wants to grow longer, the surplus belongs in the PR description, not here.
   - Lead with the component or subsystem (`reflect:`, `session-mgr:`, `hermit-docker:`).
   - Do NOT list internal refactors, helper extractions, test scaffolding, or renamed variables — those are visible in `git diff`.
   - Do NOT repeat what `Files affected` already shows.
   - **Recovery procedures, migration shell snippets, and breaking-change steps belong in `### Upgrade Instructions`, never in the narrative bullet.** Write a tight summary ("changed default X to Y") and let that section carry the imperative steps — `hermit-evolve` reads them step-by-step.

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

### 4. Refresh references

For each new skill, agent, or hook added since the last release of this plugin, detect missing entries and add them in one pass:

- `plugins/<slug>/CLAUDE.md` quick reference list (skills) and subagent table (agents)
- `plugins/<slug>/state-templates/CLAUDE-APPEND.md` quick reference (if the template exists for this plugin)
- `plugins/<slug>/docs/skills.md` (if the doc exists)
- Hook descriptions in `plugins/<slug>/CLAUDE.md` if the hook surface area changed

Skip the step entirely if nothing was added. The release-auditor (Step 1.3) covers structural integrity; this step is about narrative references.

### 5. Bump version in all locations

Update the version string in:
- `plugins/<slug>/.claude-plugin/plugin.json` → `"version"` field
- `.claude-plugin/marketplace.json` → find the entry in `plugins[]` where `"name" == "<slug>"` and update its `"version"` field. Other plugin entries are untouched.
- `plugins/<slug>/README.md` → version badge if present: both the `img.shields.io` URL slug (`version-X.Y.Z-green.svg`) and the `alt` text (`Version X.Y.Z`). Confirm with `grep "version-" plugins/<slug>/README.md` that the new version appears and the old one does not. Skip silently if the README has no version badge. (For `claude-code-hermit`, skip this direct edit — the sync block below re-derives the whole file from root, picking up the updated badge automatically.)
- If `<slug>` is `claude-code-hermit`: also update the root `README.md` badge — `version-OLD-green.svg` → `version-NEW-green.svg` and `Version OLD` → `Version NEW`. This is the only plugin whose version the root README tracks.

**Sync plugin README from root (claude-code-hermit only):** `plugins/claude-code-hermit/README.md` is a path-adjusted derivative of the root `README.md`. After updating version badges, re-derive it by applying these substitutions to the root README content:

| In root `README.md`                              | In plugin `README.md`                          |
|--------------------------------------------------|------------------------------------------------|
| `href="LICENSE"`                                 | `href="../../LICENSE"`                         |
| `[MIT](LICENSE)`                                 | `[MIT](../../LICENSE)`                         |
| `href="plugins/claude-code-hermit/CHANGELOG.md"` | `href="CHANGELOG.md"`                          |
| `src="plugins/claude-code-hermit/assets/`        | `src="assets/`                                 |
| `](plugins/claude-code-hermit/docs/`             | `](docs/`                                      |
| `](plugins/claude-code-dev-hermit/`              | `](../claude-code-dev-hermit/`                 |
| `](plugins/claude-code-homeassistant-hermit/`    | `](../claude-code-homeassistant-hermit/`       |
| `](plugins/claude-code-fitness-hermit/`          | `](../claude-code-fitness-hermit/`             |

Write the result to `plugins/claude-code-hermit/README.md`.

After editing, verify the manifest and marketplace are in sync — the plugin manifest wins silently if they differ:
```bash
jq -r '.version' plugins/<slug>/.claude-plugin/plugin.json
jq -r --arg slug "<slug>" '.plugins[] | select(.name == $slug) | .version' .claude-plugin/marketplace.json
```
Both must print the same string. If they differ, fix `.claude-plugin/marketplace.json` before continuing.

### 6. Final validation

Steps 3–5 only edit Markdown and JSON, so re-running the test suite is unnecessary. Confirm:

```bash
jq -e . plugins/<slug>/.claude-plugin/plugin.json > /dev/null
jq -e . .claude-plugin/marketplace.json > /dev/null
git status --short
```

Both `jq` checks must succeed and `git status` must show only the files this release touched (CHANGELOG, plugin.json, marketplace.json, optional CLAUDE.md / README badge / state-templates updates). Any unexpected entry → investigate before committing.

### 7. Commit and push

Stage only the changed files (not `git add -A`). Commit with:

```
<slug> v<X.Y.Z>: One-line summary of the release
```

Push to origin.

### 8. Branch check before tagging

Run `git branch --show-current` and compare to `main` (or the repo's default branch from `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`).

- **On `main`/default branch** → tag immediately (step 9).
- **On any other branch** (e.g. `dev-hermit/v0.3.0`) → **stop**. Do not tag yet. Tagging the branch tip creates a commit SHA that `main` never carries after a regular merge (and is outright wrong after squash/rebase), leaving the tag stranded on an orphan commit.

  **Recommended path** (default): open a PR via `/dev-pr`, merge into `main`, then re-run `/release <slug>` from `main`. Step 2's already-bumped detection will skip straight to tagging.

  If the user explicitly wants to tag now despite the risk, offer that as a secondary option. Wait for their explicit choice before proceeding.

### 9. Tag and publish

The tag format is **plugin-prefixed with double-dash separator**: `<slug>--v<X.Y.Z>`. This is the format Claude Code's native dependency resolver requires to find matching versions for `dependencies` entries.

Run `claude plugin tag --push` from the plugin directory — it validates plugin contents, confirms `plugin.json` and `marketplace.json` versions agree, requires a clean working tree, and refuses if the tag already exists:

```bash
(cd plugins/<slug> && claude plugin tag --push)
```

Then create the GitHub release pointing to the new double-dash tag. Source the release notes from the CHANGELOG section we just wrote — `--generate-notes` would otherwise interleave commits from sibling-plugin releases that landed since the last core tag.

```bash
VERSION=$(jq -r '.version' plugins/<slug>/.claude-plugin/plugin.json)
TAG="<slug>--v$VERSION"
NOTES_FILE=$(mktemp)
awk -v ver="$VERSION" '
  $0 ~ "^## \\[" ver "\\]" {flag=1; next}
  /^## \[/ && flag {exit}
  flag {print}
' plugins/<slug>/CHANGELOG.md > "$NOTES_FILE"
[ ! -s "$NOTES_FILE" ] && { echo "CHANGELOG section for $VERSION not found in plugins/<slug>/CHANGELOG.md — fix and retry"; rm "$NOTES_FILE"; exit 1; }
gh release create "$TAG" --title "$TAG" --notes-file "$NOTES_FILE"
rm "$NOTES_FILE"
```

**Note on legacy tags:** the core plugin (`claude-code-hermit`) historically released under the unprefixed `v<X.Y.Z>` format (e.g. `v1.0.18`) and the prefixed single-dash format (e.g. `claude-code-hermit-v1.0.20`). Those tags remain in place. From this point forward, all plugins use the double-dash format (`<slug>--v<X.Y.Z>`). Existing single-dash release tags were backfilled with double-dash aliases in April 2026.

### 10. Report

Print the slug, the new version, the commit hash, the tag name, and a one-liner confirming it's pushed.
