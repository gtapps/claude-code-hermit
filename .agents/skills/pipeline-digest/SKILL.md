---
name: pipeline-digest
description: Daily release-pipeline digest with a change gate — reports which plugins are pending release, whether main's CI is green, and which branches went stale, and notifies the operator only when that state actually moved since the last run. Use when the operator asks "what moved in the pipeline", "anything to ship", "pipeline digest", or when the `pipeline-digest` routine fires. For a full on-demand pipeline snapshot regardless of change, use /release-status instead.
---

# Pipeline Digest

Delta-gated wrapper over the pipeline facts `/release-status` reports in full. A quiet day costs one script call and sends nothing.

## Steps

### 1. Collect

```bash
bun .agents/skills/pipeline-digest/scripts/digest.ts .hermit
```

Run from the repo root. Two possible outputs:

- `NOCHANGE` — the pipeline is exactly where it was last time. Say so in one line and stop. Do not send anything.
- `CHANGED|<hash>` followed by the digest body — continue.

### 2. Report and notify

Print the digest body in the conversation. Then send it to the operator:

```bash
.hermit/bin/hermitd-run channel-send .hermit --notice
```

with `{"maintainer": "<the digest, channel-voiced>"}` on stdin. The `hermitd-run` dispatcher resolves the installed plugin itself — do not try to derive a plugin root from this skill's Base directory, which points at `.agents/`, not the plugin.

Channel voice: plain language, no file paths, no slash commands, no cron strings. Plugin names and versions are fine — the maintainer chat is the technical audience. Lead with what the operator can act on.

### 3. Commit the hash

```bash
bun .agents/skills/pipeline-digest/scripts/digest.ts .hermit commit <hash>
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
