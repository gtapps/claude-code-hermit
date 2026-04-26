---
name: commit
description: Tidy, changelog, and commit — lightweight motion for day-to-day plugin dev work. Trigger when the user says "commit", "commit this", "save this", "wrap this up", "let's commit", or finishes a change and wants to capture it. NOT for releases, version bumps, or pushing — defer to /release for those. Always run this before the user can walk away from an incomplete change.
---

# Commit

Simplify the diff, append a changelog line, then commit. No push, no tag, no version bump — that's `/release`'s job.

## Guardrails (check before starting)

- Clean tree (`git status` shows nothing) → stop and say so, nothing to commit.
- Detached HEAD, mid-rebase, or mid-merge → stop and ask the user to resolve that first.
- Never `--amend`, `--no-verify`, force-push, or create tags here.
- If a pre-commit hook fails, fix the root cause and create a new commit — don't bypass the hook.

## Steps

### 1. Run /simplify

Invoke the `simplify` skill via the Skill tool. Let it review the changed code for reuse, quality, and efficiency, and fix any issues it finds. Its edits become part of this commit.

### 2. Review the diff

Run `git status` and `git diff HEAD` (or `git diff` if nothing staged yet). Scan for:
- Secrets or credentials (`.env`, API keys, tokens)
- Large binaries or generated files that shouldn't be versioned
- Unrelated files that shouldn't be bundled in this commit

If anything suspicious appears, pause and ask the user before continuing.

### 3. Update CHANGELOG.md

Open `CHANGELOG.md`. Find the `## [Unreleased]` section at the top. Under the correct sub-section (`### Added`, `### Changed`, or `### Fixed`), append one or more bullets that describe what changed and why. Create the sub-section header if it's missing.

Follow the existing format exactly — **Bold summary** — detailed explanation of what changed and why.

Do not create a new version header (`## [X.Y.Z]`). That belongs to `/release`.

### 4. Draft the commit message

Write a short imperative first line (≤72 chars). Add a body only if the why isn't obvious from the diff. Show the proposed message to the user and wait for approval.

### 5. Commit

Once approved, stage and commit:

```bash
git add -A
git commit -m "$(cat <<'EOF'
<message here>
EOF
)"
```

Report the resulting commit hash. Do not push, do not tag.
