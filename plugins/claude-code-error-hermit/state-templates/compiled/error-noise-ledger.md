---
type: error-noise-ledger
title: Error Noise Ledger
---

# Error Noise Ledger

The classification memory of the error hermit. Every triaged error group lands here so the next run knows whether a group is genuinely **new**, a **regression** of something previously fixed, or **known-noise** to be muted rather than escalated.

The `error-triage` skill reads and maintains this file. Operator edits are preserved — the hermit only appends or updates rows, never wipes them.

## How classification uses this ledger

- **known-noise** — an active row matching the group's fingerprint. Do not escalate; propose muting if it is loud.
- **fixed-in `<release>`** — a row marked fixed at a release that predates the group's `firstSeen` means this is a **regression**. Escalate as `[regression]`.
- **new** — no matching row. Triage it, and add a row here once classified.

## Ledger

| shortId / fingerprint | classification | first added | rationale | review-by |
|---|---|---|---|---|
| _example: TimeoutError in fetchWithRetry_ | known-noise | 2026-07-03 | upstream flakiness, &lt;10/day, non-actionable | 2026-10-01 |

<!-- Add one row per classified group. Fingerprint = shortId or a stable culprit+type string. -->
