---
name: fleet-release
description: Use this skill whenever the user wants to release, ship, prep, or cut versions for two or more plugins together on the current branch. Trigger on phrasings like "release both plugins", "ship them together", "release all changed plugins", "fleet release", "multi-plugin release", "release in order", or "release everything on this branch". Handles dependency ordering (core first), automatic required_core_version sync, and offers /create-pr when done.
---

# Fleet Release

Orchestrate a multi-plugin release: determines order, runs each plugin's `/release` prep sequentially, injects cross-plugin `hermit-meta.json` sync between core and domain plugins, then offers `/create-pr`.

**Does not tag.** Tags happen on `main` after the PR merges — the existing `/release` fast-path handles that.

## Usage

```
/fleet-release [slug1 slug2 ...]   explicit list
/fleet-release                     auto-detect from current branch
/fleet-release --dry-run           show plan, no file changes
```

## Steps

### 1. Validate branch

Run `git branch --show-current`. If on `main` or the repo's default branch: stop — "Fleet release is for branch prep. Switch to a non-default branch and re-run."

### 2. Determine target plugins

**Explicit slugs:** validate each exists at `plugins/<slug>/.claude-plugin/plugin.json`. For any unknown slug, abort and list available slugs.

**Auto-detect (no args):** collect plugins where both:
1. Files under `plugins/<slug>/` changed on this branch vs base: `git diff <base>..HEAD --name-only -- plugins/<slug>/` is non-empty
2. `plugin.json` version is ahead of the last `<slug>--v*` tag — same "already-bumped" detection as `/release` step 2

Skip plugins with no `plugin.json` version or no tags (unstructured). Note skipped plugins in output.

If condition 1 holds but condition 2 does not (branch changes but version not bumped yet): include the plugin and note it will need a full `/release` prep run.

### 3. Determine release order

Rule — not a graph:
1. `claude-code-hermit` goes first if present
2. Remaining plugins in alphabetical order

### 4. Determine version bumps and confirm upfront

For each plugin in order:
- If version is already ahead of last tag: mark as "already prepped at vX.Y.Z" — no bump step needed for it
- Otherwise: inspect `git log <last-tag>..HEAD -- plugins/<slug>/` to suggest patch/minor bump (same heuristics as `/release` step 2)

Present the full plan at once before touching any file:

```
Release plan:
  claude-code-hermit       1.0.22 → 1.0.23  (patch)
  claude-code-dev-hermit   already prepped at 0.2.2

Dep sync after core prep:
  claude-code-dev-hermit   required_core_version: >=1.0.22 → >=1.0.23

Confirm? [Yes / Adjust versions]
```

Wait for confirmation. If the user adjusts, accept corrections before continuing.

With `--dry-run`: stop here. Print the plan and exit without touching anything.

### 5. Run `/release` prep for core (if in fleet)

Invoke the full `/release claude-code-hermit` skill logic (steps 1–8 of that skill). Step 8 will detect non-main branch and stop before tagging — that is expected. Continue to step 6.

### 6. Inject cross-plugin dep sync

Immediately after core's prep commit, before any domain plugin runs:

```bash
NEW_CORE=$(jq -r .version plugins/claude-code-hermit/.claude-plugin/plugin.json)
```

For each domain plugin **in the fleet** that has `plugins/<slug>/.claude-plugin/hermit-meta.json`:

```bash
jq --arg v ">=$NEW_CORE" '
  .required_core_version = $v |
  .requires["claude-code-hermit"] = $v
' plugins/<slug>/.claude-plugin/hermit-meta.json > tmp && mv tmp plugins/<slug>/.claude-plugin/hermit-meta.json
```

These changes will be staged and committed as part of each domain plugin's `/release` run in step 7 — no separate commit needed.

**Only update plugins in this fleet.** Plugins not being released are not touched.

### 7. Run `/release` prep for each domain plugin

For each domain plugin in order, invoke the full `/release <slug>` skill logic. The updated `hermit-meta.json` from step 6 will be included in the files that release commit touches.

### 8. Report and offer PR

```
Fleet release complete:
  claude-code-hermit      v1.0.23  (commit abc1234)
  claude-code-dev-hermit  v0.2.3   (commit def5678)
```

Use AskUserQuestion: "Open a PR for this fleet release?" with Yes / No. If yes, invoke `/dev-pr`.
