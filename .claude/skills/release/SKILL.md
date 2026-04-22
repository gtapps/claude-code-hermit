---
name: release
description: Bump the plugin version, write a detailed changelog entry for the upgrade skill to consume, and commit+push. Use this skill whenever the user says "release", "version bump", "cut a release", "changelog and push", or finishes a set of changes and wants to ship them. Also trigger when the user says "do the release thing" or asks to prepare changes for hermits to pick up.
---
# Release

Bump version, write changelog, commit, and push. The changelog entry is critical because the upgrade skill (`skills/hermit-evolve/SKILL.md`) reads it to know what to tell hermits during `/claude-code-hermit:hermit-evolve`.

## Steps

### 0. Pre-release validation

Run before anything else. Abort the release if any step fails.

1. **Run the native plugin validator:**
   Run `/plugin validate .` in the session. If it reports any errors, stop and fix before releasing.

2. **Run test suites:**
   ```bash
   bash tests/run-all.sh 2>&1
   ```
   If any test fails, stop and fix before releasing.

3. **Run the release-auditor agent** to cross-reference plugin integrity:
   - Skills in CLAUDE.md/CLAUDE-APPEND match actual `skills/` directories
   - Agents in CLAUDE.md match actual `agents/` files
   - Hook scripts referenced in `hooks/hooks.json` exist in `scripts/`
   - State-template JSON files parse correctly
   - `config.json.template` keys are in sync with `DEFAULT_CONFIG` in `hermit-start.py`

4. **Check for stale references** — if new skills, agents, or hooks were added since the last release:
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

### 3. Update CLAUDE.md and CLAUDE-APPEND references

If new skills, agents, or hooks were added in this release:

- Add new skills to the `CLAUDE.md` quick reference list and `state-templates/CLAUDE-APPEND.md` quick reference
- Add new agents to the `CLAUDE.md` subagent table
- Update hook descriptions in `CLAUDE.md` if the hook surface area changed significantly

Skip this step if no new components were added.

### 4. Bump version in all locations

Update the version string in:
- `.claude-plugin/plugin.json` → `"version"` field
- `.claude-plugin/marketplace.json` → `"version"` field inside `plugins[0]`
- `README.md` → version badge: both the `img.shields.io` URL slug (`version-X.Y.Z-green.svg`) and the `alt` text (`Version X.Y.Z`). Confirm with `grep "version-" README.md` that the new version appears and the old one does not.

After editing, verify the two files are in sync — the plugin manifest wins silently if they differ:
```bash
jq -r '.version' .claude-plugin/plugin.json
jq -r '.plugins[0].version' .claude-plugin/marketplace.json
```
Both must print the same string. If they differ, fix `marketplace.json` before continuing.

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

Push to origin. Then tag, push the tag, and create the GitHub release.

Before tagging, confirm the tag name matches the version you just bumped — a typo here creates a tag that disagrees with both manifests and `gh release` will happily publish it:

```bash
VERSION=$(jq -r '.version' .claude-plugin/plugin.json)
git tag "v$VERSION"
git push origin "v$VERSION"
gh release create "v$VERSION" --title "v$VERSION" --generate-notes
```

### 7. Report

Print the version, the commit hash, and a one-liner confirming it's pushed.
