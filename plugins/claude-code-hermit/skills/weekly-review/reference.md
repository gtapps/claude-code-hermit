# Weekly Review — Topic-Page Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md step 3.
The subagent reads only files (no inherited session context) and returns structured JSON; the calling
main session composes the channel summary and applies every side effect.

## Inputs (read fresh — do not reuse cached values)

- Every `.claude-code-hermit/compiled/topic-*.md` — read full bodies.
- The 3 most recent `.claude-code-hermit/sessions/S-*-REPORT.md` — frontmatter first (`date`, `tags`,
  `task`, `lessons`) for the staleness/contradiction cross-check below; open a full body only to confirm
  a specific contradiction that the row can't settle, or for a report whose frontmatter lacks the
  `next_start` key (legacy — read in full). Skip entirely if no topic pages exist.
- `MEMORY.md` — operator's auto-memory index (at the project root's
  `.claude/projects/.../memory/MEMORY.md` — read the path that exists) — to resolve wikilink targets.

If no `compiled/topic-*.md` files exist, return `topic_findings: []` and do nothing else.

## Semantic check of topic pages

Read every `compiled/topic-*.md` and look for:
- claims contradicted by another topic page or by a more recent session report
- stale claims — old `updated` date on a subject with recent session activity
- broken `[[wikilinks]]` — targets that match no compiled page or memory entry

Cap at 3 findings, one line each. If none, or no topic pages exist, return `topic_findings: []`.

## Return Value

Return a single JSON object — no prose, no markdown wrapping. The field is required; use `[]` when
there are no findings, never omit the key.

<!-- weekly-review-eval-schema:start -->
```json
{
  "topic_findings": [ "<one-line finding>" ]
}
```
<!-- weekly-review-eval-schema:end -->

The main session renders `topic_findings` as a `Topic pages:` line in the weekly channel summary
(step 6) when non-empty, and omits the line entirely when `[]`.
