---
name: commit
description: Tidy, changelog, and commit — lightweight motion for day-to-day plugin dev work in the monorepo. One commit per plugin scope; CHANGELOG and staging routed by detected slug. Trigger when the user says "commit", "commit this", "save this", "wrap this up", "let's commit", or finishes a change and wants to capture it. NOT for releases, version bumps, or pushing — defer to /release for those. Always run this before the user can walk away from an incomplete change.
---

# Commit

Detect which plugin's scope this change belongs to, simplify the diff (unless docs-only), append a changelog line in that plugin's CHANGELOG, then commit. No push, no tag, no version bump — that's `/release`'s job.

## Guardrails (check before starting)

- Clean tree (`git status` shows nothing) → stop and say so, nothing to commit.
- Detached HEAD, mid-rebase, or mid-merge → stop and ask the user to resolve that first.
- Never `--amend`, `--no-verify`, force-push, or create tags here.
- Never use `git add -A` or `git add .` — staging is path-scoped per step 0.
- If a pre-commit hook fails, fix the root cause and create a new commit — don't bypass the hook.

## Steps

### 0. Detect scope

Run `git status --porcelain` and partition the changed paths:

- Paths matching `plugins/<X>/...` → group by `<X>` (the slug).
- Paths outside `plugins/` (root README, `.github/`, `.claude/`, `.claude-plugin/marketplace.json`, root configs) → "root-scope" paths.

Then decide:

- **Single plugin slug, no root-scope paths** → set `$PLUGIN_DIR = plugins/<slug>/`, set `$SCOPE = plugin`. Continue.
- **Multiple plugin slugs touched** → stop. Print the per-slug file groups and ask the user to split the change into separate `/commit` runs (one per plugin). Do not stage anything.
- **Single plugin slug + a few root-scope paths** → ask the user via AskUserQuestion: "Bundle the root-scope files (`<list>`) into the `<slug>` commit, or split them out as a separate root-scope commit?" Default to splitting if uncertain.
- **Root-scope only (no `plugins/<X>/...`)** → set `$SCOPE = root`, `$PLUGIN_DIR = none`. Continue.

The rest of this skill branches on `$SCOPE`.

### 1. Run /simplify

Invoke the `simplify` skill via the Skill tool. Let it review the changed content for reuse, quality, and efficiency, and fix any issues it finds. Its edits become part of this commit. Run it on every commit — including markdown-only diffs (docs and CHANGELOG entries benefit from a clarity/dedup pass too).

After `/simplify` runs, re-run the step 0 detection — its edits may have added new paths. If they fall outside `$SCOPE`, halt and surface them to the user.

### 2. Review the diff

Run `git status` and `git diff HEAD` (or `git diff` if nothing staged yet). Scan for:
- Secrets or credentials (`.env`, API keys, tokens)
- Large binaries or generated files that shouldn't be versioned
- Unrelated files that shouldn't be bundled in this commit

If anything suspicious appears, pause and ask the user before continuing.

### 3. Update CHANGELOG.md (skip for `$SCOPE = root`)

For `$SCOPE = root`: skip this step entirely. Root-scope edits (CI tweaks, root README, `.github/`) never ship to operators, so there is no operator-facing changelog to update.

For `$SCOPE = plugin`: open `$PLUGIN_DIR/CHANGELOG.md`. Find the `## [Unreleased]` section at the top. Under the correct sub-section (`### Added`, `### Changed`, or `### Fixed`), append one or more bullets that describe what changed and why. Create the sub-section header if it's missing. If `[Unreleased]` itself is missing, prepend it immediately after the `# Changelog` header.

Follow the existing format exactly — `**Bold summary** — detailed explanation of what changed and why.`

Do not create a new version header (`## [X.Y.Z]`). That belongs to `/release`.

### 4. Draft the commit message

Write a short imperative first line (≤72 chars). Add a body only if the why isn't obvious from the diff. Show the proposed message to the user and wait for approval.

### 5. Commit

Once approved, stage path-scoped (never `-A`):

- `$SCOPE = plugin`: `git add $PLUGIN_DIR` (plus any root-scope paths the user opted to bundle in step 0).
- `$SCOPE = root`: `git add` each root-scope path explicitly enumerated from step 0.

Then commit:

```bash
git commit -m "$(cat <<'EOF'
<message here>
EOF
)"
```

Report the resulting commit hash. Do not push, do not tag.
