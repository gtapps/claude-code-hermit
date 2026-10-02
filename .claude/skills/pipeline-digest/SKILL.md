---
name: pipeline-digest
description: Daily release-pipeline digest with a change gate — reports which plugins are pending release, whether main's CI is green, which branches went stale, and GitHub issue/PR activity, and notifies the operator only when that state actually moved since the last run. Use when the operator asks "what moved in the pipeline", "anything to ship", "pipeline digest", "any repo activity", or when the `pipeline-digest` routine fires. For a full on-demand pipeline snapshot regardless of change, use /release-status instead.
---

# Pipeline Digest

Delta-gated wrapper over the pipeline facts `/release-status` reports in full. A quiet day costs one script call and sends nothing.

## Steps

### 1. Collect

```bash
bun .claude/skills/pipeline-digest/scripts/digest.ts .hermit
```

Run from the repo root. Two possible outputs:

- `NOCHANGE` — the pipeline is exactly where it was last time. Say so in one line and stop. Do not send anything.
- `CHANGED|<hash>` followed by the digest body — continue.

### 2. Report and notify

Print the digest body in the conversation. Then send it to the operator:

```bash
.hermit/bin/hermitd-run channel-send .hermit --notice
```

with `{"maintainer": "<the digest, channel-voiced>"}` on stdin. The `hermitd-run` dispatcher resolves the installed plugin itself — do not try to derive a plugin root from this skill's Base directory, which points at `.claude/`, not the plugin.

Channel voice: plain language, no file paths, no slash commands, no cron strings. Plugin names and versions are fine — the maintainer chat is the technical audience. Lead with what the operator can act on.

### 3. Commit the hash

```bash
bun .claude/skills/pipeline-digest/scripts/digest.ts .hermit commit <hash>
```

Commit **only when the digest reached the operator, or when there was nobody to send it to.** Read the JSON on stdout — the exit code alone is not enough, because the script exits 1 whenever `delivered` is false, `no_channel` included:

| Send result | Action |
|---|---|
| `"delivered":true` (exit 0) | commit the hash |
| `"no_channel":true` (exit 1), no channel enabled in `config.json` | commit the hash — there is no audience, so printing it was the delivery |
| `"no_channel":true` (exit 1), but a channel **is** enabled | do not commit — the channel is configured and unreachable, which is a delivery failure, not an empty audience |
| exit 1 otherwise (undelivered or degraded) | do not commit, so the digest re-fires next run; report the failure per § Operator Notification |
| exit 2 (payload rejected) | do not commit; the payload is malformed — fix and retry |

A plain contributor checkout with no hermit state directory is fine: the digest prints, `no_channel` short-circuits the send, and `commit` is a silent no-op.

### 4. Reconcile the proposal queue

Independent of steps 1–3: runs whether the pipeline digest itself was `CHANGED` or `NOCHANGE`, since a merge can close a proposal without moving any pipeline fact.

```bash
LAST=$(cat .hermit/state/proposal-reconcile-sha.txt 2>/dev/null || echo "")
NOW=$(git rev-parse HEAD)
[ "$LAST" = "$NOW" ] && echo "SKIP|unchanged" || echo "RECONCILE|$NOW"
```

On `SKIP`, stop here.

On `RECONCILE|<sha>`, run the collector:

```bash
bun .claude/skills/stale-proposals/scripts/collect-evidence.ts --status proposed,deferred,accepted
```

`NONE|no-open-proposals` — write `<sha>` to `.hermit/state/proposal-reconcile-sha.txt` and stop.

Otherwise, dispatch a `general-purpose` subagent at **`model: "sonnet"`** — the matching step needs real judgment (partial-delivery detection, same-day evidence ordering, substance matching across a renamed thing), not a checklist, and a wrong strong match silently closes live work. Give it `stale-proposals/SKILL.md`'s Step 2 contract verbatim with the bundle path from the collector above, then follow that skill's Step 2b (completeness check) and Step 3 (auto-apply `SHIPPED-STRONG` matches) exactly as written there.

For any `SHIPPED-WEAK` / `AGED` verdict: never use `AskUserQuestion` here — this routine fires unattended, with nobody watching to answer it. Instead, for each one, queue a plain yes/no bounded ask:

```bash
bun plugins/hermitd/scripts/proposal.ts queue-micro .hermit <<'HERMIT_MP'
{"tier":1,"question":"<summarize the verdict's evidence and gap in one sentence>. Close it as resolved anyway?","proposal_id":"<PROP-ID>"}
HERMIT_MP
```

so the operator can answer later from any channel-reachable turn — resolving one of these later patches the proposal to `status=resolved` (mirroring `stale-proposals/SKILL.md` Step 3) if the answer is yes, and leaves it untouched if no.

Send one channel notice summarizing what changed (auto-resolved count, queued-question count) — fold it into the same notice as the pipeline digest itself when both fired this run, or send it alone when the digest was `NOCHANGE`. Then write `<sha>` to `.hermit/state/proposal-reconcile-sha.txt`.
