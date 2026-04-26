---
name: release
description: Cut a release for this plugin — bumps semver in plugin.json, marketplace.json, and the README badge, writes a CHANGELOG entry, commits, and pushes. Use whenever releasing a new version of claude-code-homeassistant-hermit.
---

# Release

Cut a new release for claude-code-homeassistant-hermit.

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

### 3. Update files

1. `.claude-plugin/plugin.json` — `"version": "OLD"` → `"version": "NEW"`
2. `.claude-plugin/marketplace.json` — `"version": "OLD"` → `"version": "NEW"`
3. `README.md` — badge segment `version-OLD-green` → `version-NEW-green` and alt text `Version OLD` → `Version NEW`. Also check: if the minimum core hermit version changed, update the `requires-claude--code--hermit%20vX.Y.Z%2B` badge URL and alt text to match.
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
git push                   # or git push --set-upstream origin main if no upstream
git push origin vNEW
```

### 5. Create GitHub release

Use `gh` to create the release so it appears in the GitHub Releases section (a pushed tag alone does not):

```bash
gh release create vNEW \
  --title "vNEW" \
  --notes "<changelog body verbatim>"
```

Pass the full changelog body (the markdown written in step 2) as `--notes`. Do not add a version header — GitHub prepends the tag name automatically.

### 6. Confirm

```
Released vNEW
  plugin.json       ✓
  marketplace.json  ✓
  README.md badge   ✓
  CHANGELOG.md      ✓
  Pushed            ✓
  GitHub release    ✓  https://github.com/.../releases/tag/vNEW
```
