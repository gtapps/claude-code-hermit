---
name: pre-release-review
description: Pre-release gate for the monorepo — establishes per-plugin release boundaries (each plugin's last tag → HEAD), audits every changed plugin's CHANGELOG against the actual code diff, then hands off to the native `/code-review high --fix` for the deep correctness pass. Use this whenever the operator is about to ship and says "pre-release review", "review before I release", "review what's shipping", "audit the release", "check the release window", "is this ready to tag", or asks to sanity-check accumulated unreleased work before `/release` or `/fleet-release`. Runs BEFORE the release, never mutates version/tags. Trigger even when phrased loosely, as long as the intent is a last look before shipping.
---

# Pre-Release Review

The gate you run right before `/release <slug>` or `/fleet-release`. It answers two questions the release skills assume are already true:

1. **What is actually shipping?** — the real per-plugin diff since each plugin's last tag, not what you think you changed.
2. **Do the changelogs tell the truth about it?** — every operator-visible change has a CHANGELOG line, and no line over- or under-states what the code does.

Then it runs the native `/code-review high --fix` as the deep correctness pass over the current branch delta.

This is a **read-only audit** for its own steps — it never bumps a version, writes a changelog, commits, or tags. `/code-review --fix` (step 4) is the one part that mutates the working tree, and only to apply review fixes. Releasing stays the operator's explicit call via `/release`.

## Usage

`/pre-release-review [<plugin-slug>]`

- **No arg** — sweep every plugin under `plugins/*/` that has commits since its own last tag. This is the default and the common case.
- **`<slug>`** — narrow to one plugin (e.g. `/pre-release-review hermit-scribe`), useful when you already know only one plugin is shipping.

Optional precursor: `/release-status` prints the pipeline table (versions, tags, commits-ahead, core-req staleness). This skill does the deep per-plugin diff + changelog audit that the table only summarizes. Run `/release-status` first if you want the one-line overview before committing to the heavier pass.

## Step 1 — Establish per-plugin release boundaries

There is no single "release boundary" in this repo: every plugin versions and tags independently (`<slug>--vX.Y.Z`, double-dash, including core as `claude-code-hermit--v*`). The single most-recent reachable tag would give the *smallest* window and silently miss unreleased work in a plugin that hasn't tagged in a while. So compute the boundary **per plugin** — this is the same logic as `/release-status` Step 1.

Glob `plugins/*/.claude-plugin/plugin.json`. For each slug (or just the one passed as arg):

```bash
# last tag for this plugin (double-dash format, incl. core)
last_tag=$(git tag --list "<slug>--v*" | sort -V | tail -1)

# base = last tag, or the repo's initial commit if the plugin has never been tagged
base=${last_tag:-$(git rev-list --max-parents=0 HEAD | tail -1)}

# commits in the window, scoped to THIS plugin's directory
git rev-list "$base"..HEAD --count -- plugins/<slug>/
```

- **0 commits → skip the plugin.** Nothing shipping there.
- **No `plugin.json` version or no recognizable tag** → mark `unstructured (skip)` and move on, exactly as `/release-status` does.
- Record for each in-scope plugin: the base tag name, base commit (short SHA), HEAD commit (short SHA), and commit count.

If the tag choice is ever ambiguous (e.g. legacy single-dash `<slug>-v*` tags alongside the double-dash form, or a tag that isn't an ancestor of HEAD), don't guess silently: state the candidates, pick the most defensible one (newest double-dash tag that is reachable from HEAD, `git merge-base --is-ancestor` to confirm), and say why in the report.

**Pick the review base** for Step 4. The `/code-review` handoff takes a single ref range over the whole repo, not a per-plugin path scope, so choose one base that covers every in-scope plugin. The **oldest** in-scope base tag works: its range to HEAD is a superset of every newer plugin's window. If only one plugin is in scope (or a slug was passed), it's just that plugin's base.

```bash
# among the in-scope base commits, pick the oldest by commit date -> $review_base
review_base=$(for b in $in_scope_bases; do echo "$(git log -1 --format=%ct "$b") $b"; done \
  | sort -n | head -1 | cut -d' ' -f2-)
```

## Step 2 — Build the release context

For each in-scope plugin, using its `$base..HEAD` window scoped to `-- plugins/<slug>/`:

```bash
git log   "$base"..HEAD --oneline --decorate -- plugins/<slug>/
git diff  "$base"..HEAD --stat                -- plugins/<slug>/
git diff  "$base"..HEAD --name-status         -- plugins/<slug>/
```

Then read the full diffs for the files that actually matter to an operator — don't drown in noise:

- **Contract surfaces** (highest priority): `skills/`, `agents/`, `hooks/hooks.json` and referenced scripts, `commands/`, MCP config, `state-templates/`, `.claude-plugin/plugin.json`, `.claude-plugin/hermit-meta.json` (`required_core_version`, `requires`, `dependencies`), and any `config.json` schema the plugin reads.
- **Source / logic** changes under the plugin.
- **Tests** that were added or changed (or conspicuously *not* changed alongside a behavior change).
- The plugin's **`CHANGELOG.md`** — specifically its `[Unreleased]` section.
- The **root `CHANGELOG.md` / release notes** if the repo has one, plus any root-level change in the window (these ship to nobody but can still explain the diff).

Keep the collected context organized per plugin — the audit in Step 3 compares it against that plugin's changelog.

## Step 3 — Audit each changelog against reality

This is the core value of the skill. For every in-scope plugin, compare what the `[Unreleased]` changelog *claims* against what the diff *did*. Produce a verdict per plugin.

**Mechanical checks (run these first — they're deterministic, reused from `/release-status`):**

```bash
# (a) Was the changelog even touched in this window?
git diff "$base"..HEAD --name-only -- plugins/<slug>/CHANGELOG.md | grep -q . \
  && echo "changelog touched" || echo "CHANGELOG NOT UPDATED"

# (b) Fragmented [Unreleased] — duplicate '### <header>' from parallel-worktree merges
awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f && /^### /' \
  plugins/<slug>/CHANGELOG.md | sort | uniq -d

# (c) Merges that touched the plugin but not its CHANGELOG (likely a missing entry)
git log --merges --format=%H "$base"..HEAD -- plugins/<slug>/ | while read m; do
  git diff --name-only "$m^1" "$m" -- plugins/<slug>/CHANGELOG.md | grep -q . \
    || git log -1 --format='%h %s' "$m"
done
```

**Judgment checks (this is where you reason over the diff, not just grep):**

Walk the `[Unreleased]` bullets against the collected diff and flag, with a file/line citation for each:

- **Missing entry** — an operator-visible change in the diff with no changelog bullet. "Operator-visible" = anything that changes how a downstream operator experiences the plugin: a skill's behavior or trigger, a slash command added/removed/renamed, a hook's matcher or effect, MCP behavior, an agent's contract, a `config.json` key, a template, or a `required_core_version` bump. Pure internal refactors and test-only changes are *not* operator-visible — note them as "correctly omitted" rather than flagging.
- **Overstated** — a bullet that claims more than the code delivers (a feature described as done that the diff only stubs).
- **Understated / omitted breaking change** — the diff removes or renames a command, changes a config contract, tightens a `required_core_version`, or alters a default, but the changelog frames it as additive or omits the break entirely. This is the most dangerous class: it's what silently breaks operators on `/plugin update`. Flag it loudly.
- **Style drift** — bullets that aren't the terse `- **component: what changed** — short rationale` form the repo mandates (verbose bullets belong in the commit/PR, not the changelog). Note but don't block.

For each plugin, also state explicitly whether these **contract surfaces changed**, since they're the ones that break downstream operators: slash commands / skills, hooks, MCP behavior, agents, customization/config points, and `required_core_version`. A "no contract changes" statement is a useful finding too — it tells the operator the release is low-risk.

## Step 4 — Deep correctness review

Hand off to the native `/code-review`, and **scope it explicitly to the release window** rather than letting it guess a base.

`/code-review` accepts a positional target: `/code-review [effort] [--fix] [--comment] [target]`, where the target can be a ref range like `<review_base>...HEAD`. Passing the range makes it review "the committed diff a pull request into `<review_base>` would contain, **regardless of how the branch's upstream is configured**" (per the CC docs, confirmed live). That's the key property: it reviews the exact release window whether you're on a feature branch, on unpushed `main`, or on an **already-pushed** `main` — removing the empty-diff hazard the default branch-vs-upstream base has once main is pushed.

Run it with the `$review_base` computed in Step 1:

```
/code-review high --fix <review_base>...HEAD
```

(Three-dot form, matching the documented `main...feature` shape; when `<review_base>` is an ancestor of HEAD — always true here — it's equivalent to `<review_base>..HEAD`.)

`/code-review` runs its own multi-agent finder fan-out (bugs, simplification, efficiency, reuse, conventions, correctness verification) over that range, so there's no reason to duplicate it here.

Notes:
- The **Step 1–3 per-plugin boundary + changelog audit remains the authoritative "what's shipping."** `/code-review` is the correctness engine over the union window. Because `$review_base` is the *oldest* in-scope tag, the range may re-review already-released commits of a plugin whose own tag is newer — harmless, and useful for catching cross-plugin interactions.
- **Cost:** `/code-review high` is the expensive step (multi-agent, minutes, real tokens). Steps 1–3 are cheap. If the operator only wants the readiness audit, stop after Step 3 and say so rather than always burning the full review.
- `--fix` mutates the working tree *after* the Step 3 audit, so the audit won't reflect the fixes. After it completes, note that fixes were applied and still need a CHANGELOG line and a `/commit`. **Never push** — that's the operator's explicit call (`/release` / `dev-pr`).

## Report structure

Emit one report in this shape:

```
# Pre-Release Review — <date>

## Release boundaries
| Plugin | Base tag | Base | HEAD | Commits |
|--------|----------|------|------|---------|
| hermit-scribe        | hermit-scribe--v0.0.6 | a1b2c3d | e4f5a6b | 4 |
| laravel-forge-hermit | laravel-forge-hermit--v0.0.5 | ... | ... | 2 |
(plugins with 0 commits or unstructured tags: listed as skipped)

## Changelog-vs-reality audit
### <slug>  —  VERDICT: clean | needs-attention | blocking
- ✅ correctly documented: <bullet> ↔ <file:line>
- ⚠️ missing entry: <operator-visible change at file:line> has no changelog bullet
- 🔴 understated breaking change: <what> at <file:line> framed as additive / omitted
- contract surfaces changed: <commands / skills / hooks / MCP / agents / config / core-req — or "none">
(repeat per in-scope plugin)

## Deep review (/code-review high --fix <review_base>...HEAD)
<review_base> = <oldest in-scope tag>   (window: <review_base>..HEAD)
<findings summary>
<fixes applied to working tree → need CHANGELOG line + /commit; not pushed>

## Verdict
Ready to tag: <slugs>  |  Fix first: <slugs + one-line reason each>
```

Lead with the blocking findings. A plugin with an omitted breaking change or a missing entry for a contract change is **not** ready to tag until it's fixed.
