---
name: release
description: Bump the plugin version, write a detailed changelog entry for the upgrade skill to consume, and commit+push. Use this skill whenever the user says "release", "version bump", "cut a release", "changelog and push", or finishes a set of changes and wants to ship them. Also trigger when the user says "do the release thing" or asks to prepare changes for hermits to pick up.
---
# Release

Bump version, write changelog, commit, and push. The changelog entry is critical because the upgrade skill (`skills/hermit-upgrade/SKILL.md`) reads it to know what to tell hermits during `/claude-code-hermit:hermit-upgrade`.

## Steps

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

Run `/claude-code-hermit:hermit-upgrade`. The upgrade skill handles:

1. **What it does** — Explanation of what the upgrade skill will do automatically.

(Add notes about manual steps if any. State "No config.json changes required" if true.)
```

**The Upgrade Instructions section is the most important part.** The upgrade skill reads this to know what actions to take for each hermit. Be specific about:
- Whether CLAUDE-APPEND needs refreshing (it almost always does)
- Whether templates changed
- Whether config.json needs new keys (reference the table in `skills/hermit-upgrade/SKILL.md` if adding new interactive/silent keys)
- Whether there are manual steps the operator needs to take
- What is NOT affected (so the upgrade skill doesn't touch things unnecessarily)

Each changelog bullet should be a complete thought — a hermit operator reading it should understand what changed and whether it affects them.

### 3. Bump version in all locations

Update the version string in:
- `.claude-plugin/plugin.json` → `"version"` field
- `README.md` → version badge (the `img.shields.io` URL and alt text)

### 4. Commit and push

Stage only the changed files (not `git add -A`). Commit with:

```
vX.Y.Z: One-line summary of the release
```

Push to origin.

### 5. Report

Print the version, the commit hash, and a one-liner confirming it's pushed.
