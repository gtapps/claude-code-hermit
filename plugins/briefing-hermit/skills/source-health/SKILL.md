---
name: source-health
description: >-
  Read-only audit of briefing source performance. Scans recent briefing frontmatter
  (sources_used, sources_skipped, sources_quiet) for 3+ consecutive quiet or skipped
  streaks, plus a fetch_log-based cost-efficiency analysis. Never modifies sources.md.
  Invoke with /briefing-hermit:source-health [--last N].
---

# Source Health

Read-only audit of briefing source performance. Scans recent briefings and flags underperforming
sources before they silently waste fetch budget.

## When to use

- Manually, to spot-check source health.
- Wired into weekly review to catch slow-building problems.
- After adding a new source, to confirm it's yielding items.

## Steps

1. **Read `sources.md`** — extract the active source names (Name column).

2. **Glob briefings** — list `.claude-code-hermit/briefings/*.md`, sort descending by filename (newest first), take the last **N = 10** (override with `--last N`).

3. **Parse each briefing's frontmatter** — extract:
   - `sources_used`: sources that contributed ≥1 item.
   - `sources_skipped`: sources that failed to fetch (network error, Chrome unavailable, script error).
   - `sources_quiet`: sources that fetched cleanly but yielded 0 items.
   - `fetch_log`: per-source efficiency array (may be absent in older briefings — treat as missing, not an error).

   If a source appears in none of the three arrays, mark it `unknown` for that brief (may predate the schema).

4. **Compute per-source streaks** — walking newest→oldest for each active source:
   - `consecutive_quiet`: consecutive briefs the source was in `sources_quiet`.
   - `consecutive_skipped`: consecutive briefs the source was in `sources_skipped`.
   - Reset the streak when the source appears in `sources_used` or is `unknown`.

5. **Flag threshold violations** — any source where `consecutive_quiet >= 3` OR `consecutive_skipped >= 3`.

6. **Output a health table:**
   ```
   ## Source Health — YYYY-MM-DD (last 10 briefs)

   | Source                | Last 10 (newest→oldest)    | Streak       | Status    |
   |-----------------------|----------------------------|--------------|-----------|
   | Source A              | ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓      | —            | healthy   |
   | Source B              | ~ ~ ~ ✓ ~ ~ ~ ✓ ~ ~       | 3 quiet      | ⚠ warn    |
   | Source C              | ✗ ✗ ✗ ✗ ✓ — — — — —      | 4 skipped    | ✗ flag    |
   ```
   Legend: `✓` contributed · `~` quiet (fetched, nothing relevant) · `✗` skipped (fetch failed) · `—` not yet in sources or brief predates schema.

   Status thresholds:
   - `healthy` — in `sources_used` in the last 3 briefs.
   - `⚠ warn` — quiet 2 consecutive times (not yet flagged, worth watching).
   - `✗ flag` — quiet **or** skipped 3+ consecutive times → needs operator review.

7. **Summary line** — after the table:
   ```
   Flagged: N source(s) need review. Quiet: M. Skipped: K.
   ```
   If nothing flagged: `All N sources healthy in the last 10 briefs.`

8. **Recommendations** — one line per flagged source:
   - Quiet 3+: "Consider removing or replacing — consuming a fetch slot with zero yield."
   - Skipped 3+: "Check source type — may need Chrome (use `x`/`chrome` type) or the URL has changed."

9. **Efficiency Analysis** — reads `fetch_log` from recent frontmatter for per-source cost efficiency.
   Only runs when at least 3 recent briefings have `fetch_log` data; if fewer, skip entirely (no output).

   a. **Load fetch_log data** from step 3. Group by source name; discard briefs where `fetch_log` is absent.

   b. **Per-source aggregates** (across all briefs where the source appears in fetch_log):
      - `avg_tokens`: mean of `tokens_approx`.
      - `avg_yielded`: mean of `items_yielded`.
      - `avg_p1`: mean of `items_scored_p1`.
      - `yield_ratio`: `avg_yielded / (avg_tokens / 1000)` — items per 1K tokens (higher = more efficient).
      - `p1_rate`: `avg_p1 / avg_yielded` when `avg_yielded > 0`, else `—` (dash).
      - `briefs_with_data`: count of contributing briefs.

   c. **Flag type-upgrade candidates.** Sources where `tokens_approx ≥ 15000` (Chrome-tier cost) AND `yield_ratio < 0.15` → "type-upgrade candidate" (low yield at Chrome cost suggests checking for an RSS feed).

   d. **Output efficiency table** — append after the streak table:
      ```
      ## Efficiency Analysis (last N briefs with fetch_log)

      | Source      | Type    | Avg tokens | Yield/1K | P1 rate | Verdict          |
      |-------------|---------|------------|----------|---------|------------------|
      | Source A    | rss     | 3K         | 2.3      | 29%     | ✓ efficient      |
      | Source B    | reddit  | 5K         | 1.8      | 33%     | ✓ efficient      |
      | Source C    | chrome  | 20K        | 0.05     | 100%    | ⚠ low yield → RSS? |
      | Source D    | x       | 20K        | 0.0      | —       | ✗ no yield       |
      ```
      Verdict thresholds:
      - `✓ efficient` — yield_ratio ≥ 0.5 (web/rss) or ≥ 0.15 (chrome/x/reddit-chrome).
      - `⚠ low yield` — below threshold but still contributing some items.
      - `✗ no yield` — avg_yielded < 0.1.
      - `→ RSS?` — append to the verdict for type-upgrade candidates.

      Summary line:
      ```
      Efficiency: N sources efficient · M low-yield · K type-upgrade candidates
      ```

## Output

Print the tables to the conversation. Do NOT write to any file — this skill is read-only and never
modifies `sources.md`. Source removals require operator approval per project rules.
