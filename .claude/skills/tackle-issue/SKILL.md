---
name: tackle-issue
description: |
  Start-of-work triage in this monorepo. Trigger on: a GitHub issue number ("tackle issue 99",
  "work on #42", bare #N), pasted proposal/spec text ("investigate this", "pressure-test this",
  "scope this"), or picker phrasing ("tackle the next issue", "what should I work on"). Read-only
  investigation that tries to falsify the premise, then recommends SHIP / SHIP WITH CAVEAT /
  DEFER / SKIP. On SHIP verdicts for a real issue number it offers branch checkout + task
  seeding; --investigate-only suppresses that handoff. Not for PR review or work already in
  progress.
---

# Tackle Issue

Triage first, then optionally set up the work. Read-only until the operator picks "go" at the
end. Implementation, commit, and PR happen outside this skill.

## Mindset

An issue or proposal is a hypothesis, not a spec. Most issues here are filed by AI agents
(hermit-scribe): intent is usually right, framing often is not (stale paths, first-idea fix,
oversized scope, premise already fixed, or no bug at all). Try to falsify the premise before
planning anything. If it survives, judge separately whether the change is worth its cost.

Two failure modes, both disqualifying:

- **Rubber-stamping**: implementing exactly what was written when a simpler fix exists or the
  premise is partly wrong.
- **Reflex-pushback**: manufactured objections. If the premise holds and ROI is good, say
  "ship as written" plainly.

**Proportionality**: scale investigation to blast radius. A one-file doc fix needs falsification
steps 1 and 3 only, and a two-line trade-off note. Anything touching hooks, shipped skills, or
release machinery gets the full pass, including a live probe when a harness-behavior claim is
load-bearing.

## Dispatch

- **Issue number** ("tackle issue 99", "#42", "owner/repo#N"):
  `gh issue view <N> --repo <owner/repo from input, default gtapps/claude-code-hermit> --json title,body,labels,comments,author,state,url`
  Read the comments: they often say "already fixed" or change scope, and they override the body.
  Pull referenced issues/PRs when the body leans on them. Closed issue → surface that and ask
  before continuing. Also run `gh pr list --repo <repo> --state open --search "<N>"`: an open PR
  already covering the issue usually means DEFER to that PR.
- **Pasted content** (proposal, spec, free-form): treat the text as the task body. Triage output
  only, no handoff.
- **Picker** ("tackle the next issue", "what should I work on", bare `/tackle-issue`): run
  Picker below, then continue as issue-number mode.
- **Ambiguous** ("tackle this", no number, no paste): ask which mode before fetching anything.
- **`--investigate-only`** (combines with issue-number mode): full triage report including the
  plan sections on positive verdicts, then stop. No branch, no tasks.

**PROP-NNN references**: for issues in this repo, read the matching
`.claude-code-hermit/proposals/PROP-NNN-*` file and fold its `## Problem` /
`## Proposed Solution` into the evidence. Never dereference PROP ids from other repos
(numbering is per-repo).

**Handoff applies only to gtapps/claude-code-hermit issues.** Cross-repo issues get the triage
report only.

## Picker

1. `gh issue list --repo gtapps/claude-code-hermit --label ready --state open --json number,title,labels,updatedAt --limit 30`.
   Zero results → "No ready-labelled open issues; label issues `ready` to opt in." Stop.
2. Drop issues referenced by open PRs:
   `gh pr list --repo gtapps/claude-code-hermit --state open --json number,body,headRefName --limit 100`,
   matching `#N` in bodies and `(feat|fix|chore)/N-` in head branch names.
3. Drop issues with a `skip` event in the last 7 days or a `defer` event in the last 24h in
   `.claude/state/tackle-issue-log.jsonl` (read at most the last 100 lines; missing file = no
   exclusions).
4. Sort `priority:high` first, then `updatedAt` descending. Take the first. Empty after
   filters → say so and stop.

## Falsification workflow

Run against current code before forming any verdict.

1. **Does the bug reproduce, or does the code already handle it?** Read the cited paths; check
   whether the described failure mode is real.
2. **Is the feature already shipped under another name?** Grep symbols and concepts; check
   docs/README.
3. **Are cited paths, symbols, and behaviors current?** Renames silently invalidate issue bodies.
4. **Did the situation change after filing?** `git log` on cited files,
   `git log -S "<symbol>"` for named symbols.
5. **Load-bearing claims about live Claude Code behavior get probed, not recalled.** "The hook
   doesn't receive X" can't be falsified with Read/Grep. Use a tmux `claude --model haiku` probe
   per root CLAUDE.md § Verification (a probe doesn't mutate the repo; it stays inside the
   read-only posture). Only for load-bearing claims; most issues don't need one.

Skim sibling tests for the existing behavior contract. Every load-bearing claim gets an evidence
line tagged `[probed live | read code | recalled]`.

**Absence is not proof.** A grep that finds nothing proves absence only within the searched
tree. Per-deployment config, operator-added routines, and live harness behavior are invisible to
repo search. When a verdict pivots on a single negative claim ("nothing calls X"), that is the
claim to probe, never the one to trust.

## Verdict (premise), then Recommendation (ROI)

Verdict, pick one:

- **Confirmed as-is** — accurate, and the proposed fix is sound.
- **Refined approach** — accurate premise, simpler fix exists.
- **Corrected scope** — fix needed, but smaller/larger/differently shaped.
- **Nothing to do** — premise is wrong. Output only Verdict + Evidence + the suggested
  close/comment text (operator executes it). No Trade-offs, no Recommendation, no plan, no
  handoff. Higher bar: if this verdict rests on a negative claim you couldn't reproduce from
  defaults, probe it live or ask the operator first. Never conclude Nothing-to-do on
  grep-silence alone; a false close costs more than over-investigating.

Recommendation (first three verdicts only):

- **SHIP** — net positive, proceed now.
- **SHIP WITH CAVEAT** — proceed, flag the specific risk or follow-up.
- **DEFER** — worth doing, not now. Say what unblocks it.
- **SKIP** — premise holds, ROI weak. A legitimate outcome; name it plainly.

## Output format

Present in chat. **Never call ExitPlanMode.**

```
## Verdict: <Confirmed as-is | Refined approach | Corrected scope | Nothing to do>

## Evidence
- <file or symbol checked> → <what was confirmed or falsified> [probed live | read code | recalled]

## Trade-offs
**Pros:** <concrete value>  **Cons:** <concrete cost>  **Cost of doing nothing:** <...>

## Recommendation: <SHIP | SHIP WITH CAVEAT | DEFER | SKIP>
<one-line why>
```

On SHIP / SHIP WITH CAVEAT, append:

```
## Proposed approach
<steps; if deviating from the issue: "Deviating from source: <what> because <why>">

## Files to touch
- <path> — <change>

## Verification plan
- <test or command that proves it; a live tmux probe for behavior unit tests can't capture>
```

Trade-off lines must name concrete costs (files affected, maintenance burden, edge cases at
risk). If you can't name one, don't pad the section.

## Handoff

Runs only when: recommendation is SHIP or SHIP WITH CAVEAT, input was a
gtapps/claude-code-hermit issue number, and `--investigate-only` was not passed.

**Guardrails**: dirty tree (any branch) → stop, point at `/commit`. Mid-rebase, mid-merge, or
detached HEAD → stop. On a feature branch with commits ahead of base → AskUserQuestion: continue
current work or switch. `gh auth status` fails → stop with auth instructions.

**Branch name**: `bug` label → `fix/<N>-<slug>`; `enhancement`/`feature` → `feat/<N>-<slug>`;
else `chore/<N>-<slug>`. Slug from the title: lowercase, drop non-ASCII and stopwords, first 5
tokens joined with `-`, max 40 chars.

**Plan**: 3–6 imperative bullets. Reuse the Proposed-approach steps verbatim when present.

**Present** issue number, title, URL, labels, linked PROP, branch, and plan, then
AskUserQuestion (header "Tackle issue"):

- **go** — check out branch, seed tasks
- **skip** — log a 7-day dedup event, exit
- **defer** — log a 24h cooldown event, exit
- **stop** — exit with no log entry (analysis-only, no cooldown)

Log terminal choices (go/skip/defer only, nothing before the answer) to
`.claude/state/tackle-issue-log.jsonl`:
`{"ts":"<iso>","issue":N,"action":"go|skip|defer","branch":"…","verdict":"…","recommendation":"…"}`
(branch/verdict fields on go only).

**On go**:

```bash
git fetch origin
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
git checkout -b <branch> origin/$BASE
```

If the branch already exists locally: `git checkout <branch>` and warn.

`TaskCreate` one task per plan bullet, then three trailing tasks: run
`/claude-code-dev-hermit:dev-quality`, run `/commit`, run `/claude-code-dev-hermit:dev-pr`.
Report "On branch <branch>, ready to implement" and stop. No code edits, no commits, no PR.

## Never

- Call ExitPlanMode.
- Commit, push, open PRs, comment on issues, change labels, or close issues.
- Write to `.claude-code-hermit/` (hermit-runtime state, not workflow state).
- Pick more than one issue per invocation.
- Verify by paraphrasing the issue: evidence lines describe what the code showed, not what the
  issue said.
- Default to SHIP because the premise verified: verified premise + weak ROI = SKIP.
- Fold "while we're here" cleanup into the plan: mention it in chat after the report instead.

Plan sections follow the global engineering principles (Simplicity First, Surgical Changes):
the minimum change that resolves the verdict.
