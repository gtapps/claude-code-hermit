---
name: pre-release-review
description: "Run the pre-release gate for this multi-plugin monorepo: establish each plugin's release boundary from its last reachable tag to HEAD, audit every changed plugin's [Unreleased] changelog against the actual code diff, identify contract-surface and breaking changes, and, per the objective the user picks up front, either run a dedicated Codex correctness review over the exact union release window or an adversarial design review of what shipped (overengineering, alternative designs, downstream-hermit impact) sourced from the PRs, issues, and proposals behind the window. Use when the user asks for a pre-release review, release audit, readiness check, release-window review, sanity check before tagging, whether accumulated unreleased work is ready to ship, whether any of it is overengineered, or whether you would design it differently. Run before release or fleet-release; never bump versions, create tags, commit, or push."
---

# Pre-Release Review

Run this gate immediately before `$release` or `$fleet-release`. Answer:

1. What is actually shipping in each plugin?
2. Does each plugin's `[Unreleased]` changelog accurately describe that diff?
3. Per the mode picked in Step 0: does a dedicated Codex review find correctness problems in the union release window (Step 4), or is what shipped the right design for a downstream hermit (Step 3D)?

Keep Steps 1–3 and 3D read-only. Do not edit changelogs, bump versions, commit, tag, or push. Step 4 may edit only when the user chose the disclosed review-and-fix mode in Step 0.

## Invocation

- `$pre-release-review` — audit every plugin with commits since its own last tag.
- `$pre-release-review` for one or more `<plugin-slug>`s — audit only those plugins.
- Any trailing free text is the objective: it settles the Step 0 mode when it clearly names one ("design review", "run the deep pass too") and otherwise becomes the lens the verdict answers.

When installed, `$release-status` is an optional lightweight precursor. `$docs-drift` is the documentation follow-up after this changelog-vs-code audit.

## Step 0 — Pick the mode

Ask once, in one message, before any git work, unless the invocation already settles it. Offer three options and accept a free-text objective alongside any of them:

1. **Readiness audit** (default) — Steps 1–3. Cheap, read-only.
2. **Audit + deep correctness review** — Steps 1–4. Choosing this authorizes the Step 4 native code review (read-only) and the disclosed confirmed-fix pass; state the cost and that confirmed fixes edit the working tree, and do not ask again later.
3. **Design review** — Steps 1–3, then Step 3D: an adversarial critique of what shipped (overengineering, alternative designs, downstream-hermit impact), sourced from the PRs, issues, and proposals behind the window. Read-only.

A free-text objective does two things: the Verdict answers it ("ready to tag for <objective>", never an unqualified ready), and Step 3 flags anything in the window that does not serve it as scope creep, even when it is correctly documented.

## Step 1 — Establish per-plugin release boundaries

Each plugin versions independently with tags shaped `<slug>--vX.Y.Z`, including `hermitd--v*`. Never use the single newest repository tag as a global boundary.

Enumerate `plugins/*/.claude-plugin/plugin.json`. For each requested plugin:

```bash
last_tag=$(git tag --list "<slug>--v*" | sort -V | tail -1)
base=${last_tag:-$(git rev-list --max-parents=0 HEAD | tail -1)}
git rev-list "$base"..HEAD --count -- plugins/<slug>/
```

- Skip a plugin with zero scoped commits.
- Mark a plugin with no usable manifest version or no defensible release boundary as `unstructured (skip)`.
- Record its base tag, short base SHA, short HEAD SHA, and scoped commit count.
- If legacy single-dash tags coexist with double-dash tags, or a candidate tag is not an ancestor of HEAD, list the candidates and verify reachability with `git merge-base --is-ancestor`. Choose the newest reachable double-dash tag and explain the choice. Never guess silently.

Compute one `$review_base` for the optional deep review. The oldest in-scope base commit covers the union of all per-plugin windows:

```bash
review_base=$(for b in $in_scope_bases; do
  echo "$(git log -1 --format=%ct "$b") $b"
done | sort -n | head -1 | cut -d' ' -f2-)
```

For one in-scope plugin, use that plugin's base.

If no plugin is in scope, report that nothing is queued for release and stop.

## Step 2 — Build per-plugin release context

For every in-scope plugin, run:

```bash
git log  "$base"..HEAD --oneline --decorate -- plugins/<slug>/
git diff "$base"..HEAD --stat -- plugins/<slug>/
git diff "$base"..HEAD --name-status -- plugins/<slug>/
```

Read full diffs selectively, prioritizing:

- Contract surfaces: `skills/`, `agents/`, `hooks/hooks.json` and referenced scripts, `commands/`, MCP configuration, `state-templates/`, `.claude-plugin/plugin.json`, `.claude-plugin/hermit-meta.json`, and any consumed config schema.
- Source and logic changes under the plugin.
- Added or changed tests, or a conspicuous lack of tests beside behavior changes.
- The plugin's `CHANGELOG.md`, limited to `[Unreleased]`.
- Root release notes or root changes in the window when they explain the plugin diff.

Keep evidence grouped by plugin.

## Step 3 — Audit changelogs against reality

Run the deterministic checks first for each in-scope plugin:

```bash
# Was the changelog touched in this plugin's release window?
git diff "$base"..HEAD --name-only -- plugins/<slug>/CHANGELOG.md | rg -q '.' \
  && echo "changelog touched" || echo "CHANGELOG NOT UPDATED"

# Are [Unreleased] category headings duplicated?
awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f && /^### /' \
  plugins/<slug>/CHANGELOG.md | sort | uniq -d

# Did a merge touch the plugin but omit its changelog?
git log --merges --format=%H "$base"..HEAD -- plugins/<slug>/ | while read -r m; do
  git diff --name-only "$m^1" "$m" -- plugins/<slug>/CHANGELOG.md | rg -q '.' \
    || git log -1 --format='%h %s' "$m"
done
```

Then compare every `[Unreleased]` claim with the actual diff:

- **Missing entry** — an operator-visible behavior change lacks a bullet. This includes skills or triggers, commands, hook matchers or effects, MCP behavior, agent contracts, config keys, templates, and core-requirement changes. Pure refactors, tests, docs, and comments are correctly omitted under repository policy.
- **Overstated** — a bullet promises behavior the implementation does not deliver.
- **Understated or omitted breaking change** — a command or config contract was removed or renamed, a default changed, or `required_core_version` tightened without clear migration impact. Treat this as blocking.
- **Style drift** — the bullet violates the repository's terse style: plain sentence case under `Added`, `Changed`, or `Fixed`; no `**component:**` prefix; no leading Added/Changed/Fixed verb; no `### Files affected`; use backticks for code. Note style drift without making it blocking by itself.

For each plugin, state whether these contract surfaces changed:

- commands or skills
- hooks
- MCP behavior
- agents
- config or customization points
- `required_core_version`, `requires`, or native `dependencies`

Say `no contract changes` explicitly when none changed.

## Step 3D — Adversarial design review (design mode only)

Runs after Step 3 on the same windows. The audit checks that the changelog tells the truth; this step asks whether what shipped is the right design for a downstream hermit.

**Gather the rationale first.** Changelog bullets are deliberately terse (rationale lives in the PR and issue by repository convention), so review the design from its sources. Per merged change in the window:

```bash
git log --merges --format='%h %s' "$base"..HEAD -- plugins/<slug>/       # "Merge pull request #NNN"
gh pr view <NNN> --json title,body,headRefName,closingIssuesReferences
gh issue view <issue> --json title,body                                    # also the <N> in feat/<N>-<slug>
rg -l -e '#<issue>' -e '<branch-slug>' .hermit/proposals/PROP-*.md
```

The proposal match is loose (frontmatter has no issue field); "no proposal" is a valid answer, never guess one. Commits that landed without a PR are reviewed from their commit messages. PROP ids may appear in this report (terminal-only) but never travel into a follow-up PR, commit, or CHANGELOG.

**Review against the repository conventions** in the root and applicable plugin `AGENTS.md` files (mechanism not policy, token discipline, one-way dependency, `hermit-evolve` survival, `/plugin update` semantics, downstream operators as the audience) and name the convention each finding rests on. Load `/delta-diagrams` before drawing. Keep the PR and issue bodies out of the report; only the findings below go in.

Per change, with `file:line` evidence:

- **What / why** — one line each, the why from the issue or proposal.
- **Overengineering** — is there a simpler mechanism that meets the same contract? Name it, or say "no".
- **Alternative design** — the one you would have chosen, drawn as a `/delta-diagrams` decision tree: the shipped branch marked `◀ SHIPPED`, the alternative beside it with its functional consequence. Behavior, never files.
- **Downstream impact** — what an operator sees on `/plugin update` without having read the PR, what `hermit-evolve` must migrate, what it adds to always-on token cost.
- **Recommendation** — `keep` | `simplify before tag` | `defer to follow-up`, one-line reason.

Per plugin, one end-to-end `/delta-diagrams` before/after flow: the hermit's behavior at the base tag → at HEAD.

**Close with the decision loop.** End the report by offering `/grill-me`: the findings are opinions until the user defends or overturns each one, and grilling in the same session has the full report as its material. Never start it yourself; it is user-typed by design.

## Step 4 — Dedicated Codex correctness review (mode 2 only)

Run this only when Step 0 selected **audit + deep correctness review**; that choice is the authorization, do not re-ask. In any other mode, stop after Step 3 (or 3D) and note that the deep pass is available by re-running with option 2.

Use a custom review prompt because `codex review --base` accepts a branch, while the release boundary may be a tag or commit:

```bash
codex review "Review only the committed diff in <review_base>...HEAD. Find concrete correctness, regression, security, efficiency, reuse, and repository-convention problems. Cite a file and line for every finding, explain the impact, and ignore changes outside this range. Do not modify files."
```

The three-dot range matches the release-window comparison when `$review_base` is an ancestor of HEAD.

After the review:

1. Verify every finding against the current code and exact range. Reject false positives.
2. Apply minimal fixes only for confirmed findings. The Step 4 approval covers these disclosed fixes; do not expand scope.
3. Add or update regression coverage when behavior changes.
4. Add a terse `[Unreleased]` changelog bullet only for shipped code or behavior changes. Do not add one for docs-only or comment-only fixes.
5. Run the affected plugin's complete suite plus `bunx tsc --noEmit`.
6. Re-audit any changed changelog text against the fixed diff.
7. Never commit, tag, or push.

The Step 1–3 per-plugin audit remains authoritative for what is shipping. The union `$review_base...HEAD` may include already-released commits from a plugin with a newer tag; call this out, but do not narrow the range and miss cross-plugin interactions.

## Report

Lead with blocking findings and use this structure:

```text
# Pre-Release Review — <date>

## Release boundaries
| Plugin | Base tag | Base | HEAD | Commits |
|--------|----------|------|------|---------|
| hermit-scribe | hermitd-scribe--v0.0.6 | a1b2c3d | e4f5a6b | 4 |

Skipped: <zero-commit or unstructured plugins>

## Changelog-vs-reality audit
### <slug> — VERDICT: clean | needs-attention | blocking
- correctly documented: <bullet> ↔ <file:line>
- missing entry: <operator-visible change at file:line> has no changelog bullet
- understated breaking change: <impact and file:line>
- contract surfaces changed: <list or "none">

## Design review (design mode only)
### <slug>
<delta-diagrams before/after flow: behavior at <base tag> → at HEAD>

#### PR #NNN — <title>   (issue #N · PROP-NNN | no proposal)
what / why: ...
overengineering: <simpler mechanism, or "no">
<delta-diagrams decision tree: shipped branch ◀ SHIPPED vs alternative + consequence>
downstream: <on /plugin update · hermit-evolve migration · always-on cost>
recommendation: keep | simplify before tag | defer to follow-up — <reason>
(repeat per change)

Next: `/grill-me` to turn each recommendation into a decision.

## Deep review (mode 2 only)
Scope: <review_base>...HEAD
Status: not run | clean | findings fixed | findings remain
- <prioritized finding or fix summary>

## Verdict
Ready to tag[ for <objective>]: <slugs>
Fix first: <slugs and one-line reason>
```

Omit the sections the chosen mode did not run. A plugin with an omitted breaking change or a missing changelog entry for a contract change is not ready to tag.
