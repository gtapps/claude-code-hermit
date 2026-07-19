---
name: error-digest
description: Overnight error digest — drains the triage queue into a single channel-friendly summary (new / regressed / noise counts, draft branches awaiting a PR, pending resolve/mute approvals). Runs as an optional morning routine or on demand.
---

# Error Digest

The morning read. Triage DMs only the wake-worthy; everything else accumulates in the digest queue. This skill turns that queue into one summary instead of a trickle of notifications.

There is no core morning-brief extension point, so this ships as its own skill (the Home Assistant briefs are the precedent) — wired as an optional routine by hatch, or run on demand.

---

## Step 1 — Drain the queue

Read `state/error-digest-queue.json` (`pending` array, written by `error-triage`) and the `raw/error-triage-*.md` records since the last digest. If the queue is empty and nothing new triaged, send a one-line "no new errors overnight" and stop.

---

## Step 2 — Summarize

Compose a channel-friendly summary (core Operator Notification protocol):

- **Counts** — new / regression / known-noise since the last digest.
- **Drafts awaiting a PR** — any `error-fix/<shortId>` branches from `error-draft-fix` not yet pushed.
- **Approvals pending** — resolve/mute the hermit proposed. Queue each as a tiered yes/no micro-proposal in `state/micro-proposals.json` (`pending`, `MP-<YYYYMMDD>-<n>`) so the operator can approve from the channel; the core brief lifecycle drains it.

Keep it tight — this is a phone-glanceable digest, not a report.

---

## Step 3 — Clear

Empty the `pending` array in `state/error-digest-queue.json` (leave the file). Record the digest timestamp so the next run's "since last digest" window is correct.
