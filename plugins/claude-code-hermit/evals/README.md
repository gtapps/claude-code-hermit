# Evals

[`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals) suites for maintainers. The files ship with the plugin, since the runner reads `evals/` below the plugin root, but nothing here runs in an installed hermit.

## channel-routing

Synthetic channel turns that score `skills/channel-responder/SKILL.md` § 2 (Classify the Message): which route each message takes and whether the reply stays in channel voice.

Eval runs have no shell on the maintainer host, so each `case.yaml` carries in its prompt what the hooks and scripts would supply on a real turn: the TASKS.md policy, the reply reminder and responder nudge, any `[harness-command]`, `[pause]`, `[task thread]` or `[conversation command]` line, and a `Hermit state` block standing in for `task.ts list`, `proposal-micro match` and the proposals index. These are copies of `state-templates/TASKS.md.template` and the `scripts/lib/prompt-stages/` output; when that wording changes, update the cases too. The Discord reply tool is a fixed mock under `mocks/plugin_discord_discord/`, so reply text is graded through `mock_calls`.

## Running

From the repo root:

```bash
claude plugin eval plugins/claude-code-hermit --tag train --ablation none \
  --model haiku --runs 1 -j 3 --max-cost-usd 3 --no-publish
```

- `--ablation none`: a no-plugin arm has no routing rules to compare, and the default two-arm mode drops `tool_used: Skill` graders from the score.
- Measured on 2026-10-01, one run per case over all 30 cases: haiku $1.84, sonnet $3.21, opus about $6.
- Iterate on haiku with `--tag train` or `--case <name>`; run both tags on sonnet and opus before merging a wording change.

## Changing routing wording

Change one rule at a time and keep it only when neither `train` nor `heldout` drops; a `train`-only gain is overfitting. A new misroute seen in the field becomes a `heldout` case first.
