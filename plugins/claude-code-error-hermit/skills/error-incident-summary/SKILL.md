---
name: error-incident-summary
description: Write a post-incident summary for a resolved error group and link it from the noise ledger. Produces the compiled incident-summary artifact — timeline, root cause, fix, and the detection gap that let it through.
---

# Error Incident Summary

The memory that makes the next incident cheaper. After an error group is fixed, capture what happened so a recurrence is recognized instantly and the detection gap is visible.

Operator-invoked, or chained after `error-draft-fix` once a fix has merged.

---

## Step 1 — Assemble the record

Pull together, from the triage records (`raw/error-triage-*.md`), the reproduce/draft-fix notes, and the tracker:

- **Timeline** — firstSeen, when it was noticed, when the fix shipped.
- **Root cause** — the suspect commit and the actual defect (from reproduction).
- **Fix** — the `error-fix/<shortId>` branch / PR / merged release.
- **Detection gap** — why it reached production and how long until it was caught. This is the most valuable line; be honest.

---

## Step 2 — Write the artifact

Write `compiled/incident-<YYYY-MM-DD>-<slug>.md` (flat, no subdirs), where `<slug>` is a short kebab descriptor of the error. **Scrub any credential-shaped content** from quoted event data. Register the `incident-summary` type in the knowledge schema if not already present.

---

## Step 3 — Link from the noise ledger

Update the group's row in `compiled/error-noise-ledger.md` to `fixed-in <release>` and link the incident file. This is what lets `error-triage` classify a later recurrence as a **regression** rather than a new group.
