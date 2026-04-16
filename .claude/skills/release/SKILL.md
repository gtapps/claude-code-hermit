---
name: release
description: Bump the plugin version, write a detailed changelog entry for the upgrade skill to consume, and commit+push. Use this skill whenever the user says "release", "version bump", "cut a release", "changelog and push", or finishes a set of changes and wants to ship them. Also trigger when the user says "do the release thing" or asks to prepare changes for hermits to pick up.
---
# Release

Bump version, write changelog, commit, and push. The changelog entry is critical because the upgrade skill (`skills/hermit-evolve/SKILL.md`) reads it to know what to tell hermits during `/claude-code-hermit:hermit-evolve`.

## Steps

### 0. Pre-release validation

Run before anything else. Abort the release if any step fails.

1. **Run test suites:**
   ```bash
   bash tests/run-all.sh 2>&1
   ```
   If any test fails, stop and fix before releasing.

2. **Run the release-auditor agent** to cross-reference plugin integrity:
   - Skills in CLAUDE.md/CLAUDE-APPEND match actual `skills/` directories
   - Agents in CLAUDE.md match actual `agents/` files
   - Hook scripts referenced in `hooks/hooks.json` exist in `scripts/`
   - State-template JSON files parse correctly
   - `config.json.template` keys are in sync with `DEFAULT_CONFIG` in `hermit-start.py`

3. **Check for stale references** — if new skills, agents, or hooks were added since the last release:
   - Verify they appear in `CLAUDE.md` quick reference and subagent table
   - Verify they appear in `state-templates/CLAUDE-APPEND.md` quick reference
   - Verify `docs/skills.md` lists them (if that doc exists)

If the auditor reports any FAIL, fix before proceeding. WARNs are acceptable if justified.

### 1. Determine version bump

Read `.claude-plugin/plugin.json` for the current version and `CHANGELOG.md` for recent entries.

Review the uncommitted or recently committed changes (`git diff` and/or `git log` since the last version tag) to understand what changed.

Decide the bump level:
- **Patch** (0.0.X) — bug fixes, behavioral changes via updated instructions, small additions
- **Minor** (0.X.0) — new features, new skills, structural changes, breaking config migrations
- **Major** (X.0.0) — only if the user explicitly asks

Present the suggested version and rationale. Wait for confirmation before proceeding.

### 2. Write the changelog entry

Prepend a new entry to `CHANGELOG.md` immediately after the `# Changelog` header, before the previous version entry.

**Format** (follow the existing entries exactly):

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Changed / Fixed / Added
(use whichever sections apply — skip empty ones)

- **Bold summary** — Detailed explanation of what changed and why.

### Files affected

| File | Change |
|------|--------|
| `path/to/file` | One-line description |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **What it does** — Explanation of what the upgrade skill will do automatically.

(Add notes about manual steps if any. State "No config.json changes required" if true.)
```

**The Upgrade Instructions section is the most important part.** The evolve skill reads this to know what actions to take for each hermit. Be specific about:
- Whether CLAUDE-APPEND needs refreshing (it almost always does)
- Whether templates changed
- Whether config.json needs new keys (reference the table in `skills/hermit-evolve/SKILL.md` if adding new interactive/silent keys)
- Whether there are manual steps the operator needs to take
- What is NOT affected (so the upgrade skill doesn't touch things unnecessarily)

Each changelog bullet should be a complete thought — a hermit operator reading it should understand what changed and whether it affects them.

### 3. Update CLAUDE.md and CLAUDE-APPEND references

If new skills, agents, or hooks were added in this release:

- Add new skills to the `CLAUDE.md` quick reference list and `state-templates/CLAUDE-APPEND.md` quick reference
- Add new agents to the `CLAUDE.md` subagent table
- Update hook descriptions in `CLAUDE.md` if the hook surface area changed significantly

Skip this step if no new components were added.

### 4. Bump version in all locations

Update the version string in:
- `.claude-plugin/plugin.json` → `"version"` field
- `README.md` → version badge (the `img.shields.io` URL and alt text)

### 5. Final validation

Run tests one more time to confirm nothing broke during the changelog/version edits:
```bash
bash tests/run-all.sh 2>&1 | tail -6
```

### 6. Commit and push

Stage only the changed files (not `git add -A`). Commit with:

```
vX.Y.Z: One-line summary of the release
```

Push to origin.

### 7. Report

Print the version, the commit hash, and a one-liner confirming it's pushed.
