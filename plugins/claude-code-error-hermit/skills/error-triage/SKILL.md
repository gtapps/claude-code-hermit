---
name: error-triage
description: Watch-loop triage of new Sentry/GlitchTip error groups. Runs the zero-cost precheck first and stops when quiet; otherwise classifies new vs regression vs known-noise against the noise ledger, correlates with recent releases, and DMs or queues by severity. Invoked by the error-triage routine.
---

# Error Triage

The watch loop. Fired by the `error-triage` routine (registered by hatch). Its job: turn new error groups into a triaged verdict cheaply, escalating only what deserves a wake.

Run inside the repo of the application being watched.

---

## Step 1 — Precheck (the cheap gate)

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-precheck.ts
```

Read the single verdict line:

- **`SKIP|...`** → nothing new. Stop here with one line: `error-triage: no new groups`. Do not read the ledger, do not call the API. This is the common case and must cost near-zero tokens.
- **`ERROR|<reason>`** → the precheck could not verify. Read `state/error-cursor.json`, increment `consecutive_failures` (default 0), write it back (this is the one place triage touches the cursor on a failure — it does **not** advance `last_seen_first_seen`). If `consecutive_failures` reaches 3, DM the operator via the core Operator Notification protocol: "error-triage precheck failing (<reason>) — token or connectivity may be down." Stop.
- **`EVALUATE|...`** → continue to Step 2. Reset `consecutive_failures` to 0.

---

## Step 2 — Pull the new groups

Read the cursor from `state/error-cursor.json` (`last_seen_first_seen`; absent on bootstrap). Fetch:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts issues --since <cursor> --json
```

(Omit `--since` on bootstrap to take the current open groups as the baseline.)

Dedup against ids already recorded in today's `raw/error-triage-<YYYY-MM-DD>.md` — the `firstSeen:>=` query is inclusive, so a group exactly at the cursor boundary can reappear.

---

## Step 3 — Classify each group

Read `compiled/error-noise-ledger.md`. For each group:

- **known-noise** — an active ledger row matches the fingerprint (shortId, or culprit+type). Do not escalate. If the group is loud (high count) and not already muted, note a mute *proposal* for the digest.
- **regression** — a ledger row marks this fingerprint `fixed-in <release>`, and that release predates the group's `firstSeen`. This is a returning bug. Classify `[regression]`.
- **new** — no matching row. Classify on its merits; add a row to the ledger once triaged.

---

## Step 4 — Correlate with releases

For a `new` or `regression` group, pull the latest event to get its release tag:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts latest-event <id> --json
```

Cross-reference the `release` against recent local deploys (`git log --since='<cursor>' --oneline`, tags). A spike whose `firstSeen` lands just after a release is a strong regression signal — record the suspect release/commit range for the Phase 3 reproduce skill.

---

## Step 5 — Severity gate

Decide per group:

- **DM now** (core Operator Notification protocol) when: level is `fatal`/`error` AND (new-in-the-latest-release OR a sharp count spike). These are the "woke up to a crash" cases.
- **Queue for the digest** otherwise: append to `state/error-digest-queue.json` (`pending` array) for the Phase 4 `error-digest` to summarize. Known-noise and low-count warnings always go here, never to a DM.

**Never** resolve or mute in the tracker here. Those are surface-then-approve only (`error-api.ts resolve|mute <id> --confirm`), proposed to the operator, executed only on explicit approval.

---

## Step 6 — Persist findings

Append a scrubbed record to `raw/error-triage-<YYYY-MM-DD>.md`: each group's shortId, classification, release correlation, and the action taken (DM / queued / proposed-mute). **Scrub any credential-shaped content from event data before writing** — event payloads may carry request bodies and headers.

---

## Step 7 — Advance the cursor

Write `state/error-cursor.json` with `last_check` = now, `last_seen_first_seen` = the max `firstSeen` across the groups processed this run, and `consecutive_failures` = 0. This is the **only** place the cursor advances — a failed run in Step 1 never reaches here.

---

## Step 8 — Report

One line to the session (and the digest queue does the operator-facing summary): `error-triage: <n> groups — <a> new, <b> regression, <c> noise; <d> DMed, <e> queued`.
