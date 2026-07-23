---
name: docs-drift
description: Pre-release docs-drift audit for the monorepo — reads every plugin's [Unreleased] changelog section and checks whether the documentation surfaces (plugin README, docs/, plugin CLAUDE.md, root README, root CLAUDE.md) still tell the truth after those changes. Reports meaningful drift with concrete proposed edits and asks before applying anything. Use this whenever the operator is preparing a release and says "docs drift", "check the docs", "are the docs up to date", "docs audit", "did the docs keep up", "check documentation before release", or wants to know whether READMEs/docs match what's about to ship. Complements /pre-release-review (changelog vs code); this skill covers changelog vs docs. Trigger even when phrased loosely, as long as the intent is verifying docs against accumulated unreleased changes.
---

# Docs Drift

The third leg of the pre-release stool. `/release-status` tells you *what's queued*, `/pre-release-review` verifies *the changelog tells the truth about the code* — this skill verifies *the docs tell the truth after the change*. Changelogs are written at change time; docs are written once and rot. Every `[Unreleased]` bullet is a claim that something is now different, and each such claim can strand a doc that still describes the old world.

**Read-only until the operator approves.** The audit itself never edits, commits, or tags. Proposed edits are applied only after the operator picks them in Step 5.

## Usage

`/docs-drift [<plugin-slug>]`

- **No arg** — audit every plugin under `plugins/*/` with a non-empty `[Unreleased]` section. Default and common case.
- **`<slug>`** — narrow to one plugin (root README/CLAUDE.md still checked, but only against that plugin's changes).

Natural ordering before a ship: `/release-status` (overview) → `/pre-release-review` (changelog vs code) → `/docs-drift` (docs vs changelog) → `/release <slug>`.

## Step 1 — Scope: which plugins have unreleased changes

```bash
for p in plugins/*/CHANGELOG.md; do
  slug=$(basename "$(dirname "$p")")
  awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f && NF' "$p" | grep -q . \
    && echo "$slug"
done
```

Plugins with an empty (or absent) `[Unreleased]` are out of scope — nothing new to drift against. If nothing is in scope, say so and stop: "No unreleased changes in any plugin — nothing to drift-check."

The window is deliberately `[Unreleased]` only. Drift caused by already-released versions was either caught at that release or is pre-existing debt — flagging it here would bury the signal that matters for *this* ship. If you happen to notice pre-existing drift while sweeping, list it separately as "pre-existing (not this release)" rather than mixing it into the verdict.

## Step 2 — Extract doc-checkable claims from each [Unreleased]

Read each in-scope plugin's `[Unreleased]` section (it is the *only* changelog content you need — never read the whole file). Turn each bullet into zero or more **claims** a doc could contradict. The high-yield claim types, roughly in order of how often they strand docs:

- **Removal / rename** — a skill, command, script, hook, config key, doc file, or CLI removed or renamed. Any doc still referencing the old name is drift. (This includes a removed *doc* — other docs may link to it.)
- **New operator-visible surface** — a new skill, slash command, config block, hook, CLI (`bin/*`), or channel behavior. Check whether the docs that enumerate such surfaces (README feature lists, `docs/config-reference.md`-style pages, CLAUDE.md skill lists) were extended.
- **Changed default / changed behavior** — "now defaults to on", "no longer requires X", "trusts only the operator DM". Docs stating the old default or old behavior are drift — this is the most operator-hostile class, flag it loudest.
- **Count claims** — "34 → 28 skills", "nineteen checks". Hand-written counts anywhere in docs are drift magnets; grep for the *old* number near the counted noun.
- **Promised docs** — a bullet that says "See `docs/artifacts.md`" or cites an anchor. Verify the file exists, and that it actually documents the thing the bullet promises. A promise to a doc that was never written is drift in the changelog→docs direction.

Bullets with no doc-checkable claim (pure internal fixes, test-only changes, refactors) produce no claims — note them as "no doc surface" and move on. Don't manufacture a finding out of every bullet.

## Step 3 — Sweep the doc surfaces

Per in-scope plugin, the surfaces are:

- `plugins/<slug>/README.md`
- `plugins/<slug>/docs/*.md`
- `plugins/<slug>/CLAUDE.md`
- top-level extras that exist: `SAFETY.md`, `DOCKER.md`, `CONTRIBUTING.md`

Plus, once, against the **union** of all in-scope plugins' claims:

- root `README.md` (the canonical hermit pitch — names features, skills, and fleet plugins)
- root `CLAUDE.md` (monorepo instructions — plugin lists, conventions that reference shipped behavior)

Work claim-first, not file-first: for each claim, `grep -rn` the relevant tokens (old names, old numbers, old defaults, removed paths) across that plugin's surfaces + the root files, then Read only the files with hits to judge context. Reading every doc top-to-bottom wastes context and makes you grade prose instead of hunting contradictions.

**Fan out when scope is wide.** With more than two plugins in scope, dispatch one Explore/general-purpose subagent per plugin (claims list in the prompt, findings back as `file:line — claim contradicted — current text — suggested fix`), and keep the root-file sweep in the main session since it needs the cross-plugin union. This keeps six plugins' worth of doc text out of the main context.

## Step 4 — Judge meaningfulness

The operator asked for *meaningful* drift, not a style pass. Propose an edit only when a reader following the doc would be factually misled after this release ships:

- **Meaningful**: doc references a removed/renamed thing; doc states the old default or old behavior; doc's count is now wrong; a new operator-visible surface is absent from the doc that enumerates its siblings; a changelog-promised doc/anchor doesn't exist or doesn't cover the promise.
- **Not meaningful** (don't propose): tone/wording preferences; a doc not mentioning an internal fix; missing marketing coverage of a minor feature; formatting; anything `/pre-release-review` already owns (changelog accuracy itself).
- **Borderline**: if you're unsure whether a mismatch misleads, list it in a separate "borderline" section with a one-line rationale and no proposed edit — let the operator decide. Never pad the findings to look thorough.

## Step 5 — Report, then ask before applying

Emit one report:

```
# Docs Drift — <date>

## Scope
In scope (non-empty [Unreleased]): <slugs>. Skipped: <slugs> (empty).

## Findings
### <n>. <slug> — <severity: misleading | stale-reference | missing-doc>
- Claim: <changelog bullet, abbreviated> (CHANGELOG.md [Unreleased])
- Drift: <doc file:line> — currently says: "<excerpt>"
- Proposed edit: <exact replacement text, or "add section X covering Y">

## Borderline (no edit proposed)
- <file:line> — <one-line rationale>

## Pre-existing drift (not this release)
- <anything noticed outside the [Unreleased] window>

## Verdict
<N> meaningful findings across <M> files | Docs are clean for this release.
```

Then ask the operator which findings to apply (all / pick / none). For approved findings, apply with Edit — surgical, matching each doc's existing style, touching nothing beyond the finding.

After applying:

- Edits under `plugins/<slug>/` ship with that plugin — offer a terse plain sentence-case line for its `[Unreleased]` `### Fixed`, with no `**docs:**` prefix (one line, repo changelog style). Root README/CLAUDE.md edits skip the changelog per repo convention.
- Remind that the edits are uncommitted and `/commit` captures them. **Never commit or push from this skill.**
