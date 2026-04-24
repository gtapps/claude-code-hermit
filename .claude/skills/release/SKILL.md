---
name: release
description: Cut a release for this plugin — bumps semver in plugin.json, marketplace.json, and the README badge, writes a CHANGELOG entry, commits, tags, pushes, and creates a GitHub release. Use whenever releasing a new version of claude-code-dev-hermit.
---

# Release

Cut a new release for claude-code-dev-hermit.

## Steps

### 1. Read current version

Read `.claude-plugin/plugin.json` and extract `version`.

### 2. Ask for bump and changelog

Single `AskUserQuestion` with two questions:

```
questions: [
  {
    header: "Version bump",
    question: "Current version is X.Y.Z. What kind of release?",
    options: [
      { label: "patch (X.Y.Z+1)", description: "Bug fixes, copy changes, naming corrections" },
      { label: "minor (X.Y+1.0)",  description: "New skills, agents, or behaviour" },
      { label: "major (X+1.0.0)", description: "Breaking changes or architectural shift" }
    ]
  },
  {
    header: "Changelog",
    question: "Changelog body for this release (markdown, no version header needed):"
  }
]
```

Compute new version from the answer.

### 2.5. Pre-release drift check

Before touching any files, verify consistency against the current values in `.claude-plugin/plugin.json`:

1. **Core version mentions** — read `required_core_version` from `plugin.json`. Grep `README.md`, all files under `docs/`, `CONTRIBUTING.md`, and `skills/hatch/SKILL.md` for any string matching `claude-code-hermit v`. Every match must equal `required_core_version`. If any file has a different value, list the offending file and line, then **stop and ask the operator to fix the mismatch before continuing**.

2. **Plugin version badge** — confirm `README.md` contains the current `version` from `plugin.json` in the badge URL (`version-X.Y.Z-green`) and alt text (`Version X.Y.Z`). If either doesn't match, list the discrepancy and **stop and ask**.

3. **Skills/agents sync** — confirm every directory under `skills/` and `.claude/skills/` has a corresponding entry in `README.md`'s "Skills" table, and every `agents/*.md` has a corresponding entry in the "Agent" table. **Warn only** (do not stop) — the operator may be adding skills in this release.

If checks 1 or 2 fail, do not proceed to Step 3. Ask the operator to reconcile first.

### 3. Update files

1. `.claude-plugin/plugin.json` — `"version": "OLD"` → `"version": "NEW"`
2. `.claude-plugin/marketplace.json` — `"version": "OLD"` → `"version": "NEW"`
3. `README.md` — badge segment `version-OLD-green` → `version-NEW-green` and alt text `Version OLD` → `Version NEW`
   Also check: if the min core hermit version changed, update the `requires-claude--code--hermit%20vX.Y.Z%2B` badge to match.
4. `CHANGELOG.md` — prepend after the `# Changelog` heading:

```
## [NEW] - YYYY-MM-DD

<changelog body>

---
```

Use today's date.

### 3.5. Validate plugin

Run `claude plugin validate .` in the repo root. If it reports errors, fix them before committing. Surface any warnings to the operator but do not block the release.

### 4. Commit, tag, and push

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json README.md CHANGELOG.md
git commit -m "vNEW — <one-line summary from first line of changelog body>"
git tag vNEW
git push
git push origin vNEW
```

If no upstream is set: `git push --set-upstream origin main` before pushing the tag.

### 5. Create GitHub release

```bash
gh release create vNEW \
  --title "vNEW" \
  --notes "<full changelog body for this release>"
```

### 6. Confirm

```
Released vNEW
  plugin.json       ✓
  marketplace.json  ✓
  README.md badge   ✓
  CHANGELOG.md      ✓
  Git tag vNEW      ✓
  GitHub release    ✓
  Pushed            ✓
```
