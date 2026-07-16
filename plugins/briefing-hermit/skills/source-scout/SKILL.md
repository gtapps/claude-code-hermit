---
name: source-scout
description: >-
  Gap-driven discovery of new RSS/web sources for sources.md. Interactive runs
  WebFetch-verify candidates and auto-add them; --scheduled runs queue unverified
  candidates for operator review (no WebFetch, per the domain-allowlist rule).
  Complements source-health (removal) with discovery (addition). Invoke with
  /briefing-hermit:source-scout.
---

# Source Scout

Proactively discover and add new RSS/web sources to `sources.md`. Complements `source-health`
(removal) with discovery (addition). Can run on a schedule via `scheduled_checks`.

## Flags

- `--scheduled`: invoked by a scheduled check (non-interactive, no operator present). The security
  rule restricting automated WebFetch to domains already in `sources.md` means the step-3 verification
  fetch cannot run — candidates are queued **unverified** for operator review instead of being auto-added.
- No flag (default): interactive/on-demand (operator ran `/source-scout`). Full behavior — verify and
  auto-add — since the operator's live presence satisfies the security rule's intent.

## Steps

1. **Read current state** (in parallel):
   - `sources.md` — extract active source names, URLs, categories. Count sources per category.
   - `categories.md` — all P1/P2 categories and their priorities.
   - Glob `compiled/story-arcs-*.md`, read the most recent. Extract Watch-clause keywords from each active arc under `## Active`.

2. **Identify gaps:**
   - Any P1 or P2 category with fewer than 3 active sources is a **gap category**.
   - Active story arcs with Watch keywords that no current source covers by name/domain are **arc gaps**.
   - No gaps → log `source-scout: no gaps found` to SHELL.md Findings and stop.

3. **Discover candidates** (up to 3 total across all gaps). Use WebSearch to find RSS feeds — for a
   category gap, search for RSS feeds / newsletters covering that category; for an arc gap, search for
   feeds covering the arc's Watch keywords.

   **No flag (interactive):** for each candidate, verify the feed URL with WebFetch (valid RSS/Atom XML). Discard any that 404 or return non-feed content.

   **`--scheduled`:** do NOT WebFetch candidate URLs — they are not yet in `sources.md`, so an automated
   fetch would violate the domain-allowlist rule. Collect candidates from WebSearch results as-is
   (name, URL, gap addressed, why it surfaced), explicitly marked unverified. Skip to step 4.

4. **Filter against existing sources:**
   - Skip any candidate whose domain already appears in `sources.md`.
   - Skip any candidate previously removed (check SHELL.md Monitoring/Findings for removal entries).
   - Cap at 3 net-new candidates total.

5. **Add / queue — branch on invocation context:**

   **No flag (interactive):** source additions are free (no operator approval needed). For each verified candidate:
   - Append a row to the `## Active Sources` table in `sources.md`.
   - Assign type (`rss` for RSS/Atom feeds, `web` for scraped pages).
   - Write a brief Notes value describing what the source covers.

   **`--scheduled`:** do NOT touch `sources.md` — these candidates are unverified.

   In both modes, write `.claude-code-hermit/compiled/source-candidates-<YYYY-MM-DD>.md` with frontmatter
   (`title`, `type: source-candidates`, `created`, `tags: [source-scout]`) listing each candidate's name,
   URL, the gap it addresses, and a one-line "why this looked promising" note.

   **`--scheduled` only:** notify the operator per CLAUDE.md § Operator Notification with a one-line summary
   ("N unverified source candidate(s) found — see compiled/source-candidates-<date>.md"). Don't queue a
   micro-approval: verification requires an interactive WebFetch only the operator can trigger. The operator
   reviews the file and, for any candidate they want, runs `/source-scout` interactively (or edits
   `sources.md` manually) so verification happens with them present.

6. **Log and report:**
   - **No flag:** append to SHELL.md Findings: `source-scout: added N source(s): [name1, name2, ...]` (or `source-scout: 0 viable candidates found` if none survived). Additions are mentioned in the next brief.
   - **`--scheduled`:** append to SHELL.md Findings: `source-scout (scheduled): queued N unverified candidate(s) for operator review` (or `source-scout (scheduled): 0 candidates found`).

## Notes

- Do NOT add sources that require Chrome (type `reddit`, `chrome`, `x`) — higher runtime cost; add those manually.
- Do NOT add paid newsletters or sources behind login walls.
- Prefer RSS/Atom feeds over web scraping when both are available for the same source.
- If WebSearch is unavailable, skip the run and log `source-scout: skipped (WebSearch unavailable)`.
