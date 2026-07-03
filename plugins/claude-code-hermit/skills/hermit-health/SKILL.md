---
name: hermit-health
model: haiku
description: "Show alert state, proposal queue depth, routine engagement, knowledge state, channel availability, plus fragile zones, stale accepted proposals, and recent learnings. Activates on messages like 'health check', 'how's the hermit', 'is anything broken', 'hermit health', 'system health', 'anything wrong', 'hermit status', 'hermit brain', 'are routines running', 'what's stuck', 'any fragile zones', 'show me what's blocked', 'recent learnings', 'what have you learned lately', 'where are the weak spots', 'check knowledge', 'lint knowledge', 'knowledge health'."
---
# Hermit Health

Synthesize a compact "state of the hermit" snapshot in two halves: infrastructure (active alerts, proposal queue, routine engagement, knowledge state, channel readiness) and analysis (fragile zones, stale accepted proposals, recent learnings). Everything is read directly in main — this skill is on-demand and runner-free.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation.

## Scope

Read the following (gracefully skip any file that doesn't exist). The nine sources are independent — read them concurrently:

1. `.claude-code-hermit/state/alert-state.json` — `active` array and `suppressed` array; each entry has `type`, `timestamp`, `message`.
2. `.claude-code-hermit/state/runtime.json` — `last_activity`, `session_id`.
3. `.claude-code-hermit/state/reflection-state.json` — `last_reflection` timestamp, `counters` (including `judge_suppress_by_code` map and run/output fields), and `queue` (pending micro-proposals and reflect candidates).
4. `.claude-code-hermit/config.json` — `routines` array (id, schedule, enabled); `channels` object (each channel's `dm_channel_id`).
5. `.claude-code-hermit/proposals/PROP-*.md` — glob; count by `status` frontmatter field, and read `id`, `title`, `accepted_date`, `resolved_date`, `tags` for the stale-proposal and fragile-zone analysis.
6. `.claude-code-hermit/state/micro-proposals.json` — count entries with `status: "pending"`.
7. Glob counts: `.claude-code-hermit/raw/**` (excluding `.archive/`), `.claude-code-hermit/compiled/**`, `.claude-code-hermit/raw/.archive/**`.
8. `.claude-code-hermit/sessions/S-*-REPORT.md` — glob all, sort descending by filename, read the 5 most recent; parse `status`, `tags`, `proposals_created` frontmatter.
9. `.claude-code-hermit/sessions/SHELL.md` — current session `tags`, blockers, and `## Findings` entries (fallback source for recent learnings).

## Analysis

**Alerts:** Count entries in `alert-state.json → active`. For each, compute age from `timestamp`. Show oldest. If none: "No active alerts."

**Proposal queue:** Count proposals with `status: proposed` (pending operator review), `status: accepted` (in flight, not yet resolved), and `status: in_progress`. If all zero: "Queue empty."

**Routine engagement:** From `config.json.routines`, list each routine and its schedule. For the `reflect` routine, use `reflection-state.json → last_reflection` to show when it last ran; also append counter info from `reflection-state.json → counters`: apply the reflect-line rules below, then append the suppress-mix suffix if any `judge_suppress_by_code` code has a non-zero count: `suppress mix — no-evidence:N, covered-by-memory:N, no-sessions:N` (omit codes with count 0; omit the suffix entirely when all counts are 0 or the map is absent). For other routines, report schedule and enabled state — per-routine last-run tracking is not yet available.

**Reflect-line rules** (applied to the reflect routine bullet):
- If `counters` is absent: omit the counter clause entirely
- If `total_runs` is 0: show `no runs yet (since YYYY-MM-DD)` where the date is `counters.since`
- Otherwise: `N runs, N empty | output: N proposals, N micro | since YYYY-MM-DD` where the date is `counters.since` — omit `| output: ...` if both `proposals_created` and `micro_proposals_queued` are 0

**Micro:** Count entries with `status: "pending"` in `micro-proposals.json`. Omit this section entirely if count is zero.

**Knowledge:** Report glob counts for raw (excl. archive), compiled, and archived files. Omit if all three are zero and the directories are missing. If the operator explicitly asked to check or lint knowledge (phrasing like "check knowledge", "lint knowledge", "knowledge health"), also run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/knowledge-lint.ts .claude-code-hermit` and relay its findings verbatim (grouped by type with file paths, ages, and actionable advice) beneath the counts. The script is strictly read-only.

**Channel availability:** From `config.json.channels`, for each configured channel, check whether `dm_channel_id` is set. Report "ready" or "not yet paired (no dm_channel_id — send a message first)".

**Fragile zones:** From the last 5 session reports, gather the `tags` array from sessions with `status: partial` or `status: blocked`. Also gather `tags` from proposals with `status: dismissed` or `status: blocked`. Surface the top 2–3 tag clusters that appear repeatedly across fragile outcomes. If no blocked/partial sessions exist: "No fragile zones detected."

**Stale proposals:** From proposals, find those with `status: accepted` and `resolved_date` absent or `null`. Sort by `accepted_date` ascending (oldest first). Show up to 3. Compute days open = today minus `accepted_date`. If none: "No accepted proposals awaiting resolution."

**Recent learnings:** From `reflection-state.json`, read `queue` entries with `status: accepted` or `status: pending` and surface the most recent 3 question/observation fields. If the queue is empty or absent, scan the current SHELL.md Progress Log for notable Findings entries (lines beginning with `-` under `## Findings`). Surface top 3. If nothing: "No recent learnings — reflect hasn't run yet."

## Output

Reply in ≤1500 chars. Use exactly this section structure:

```
### Alerts
- N active (oldest: [type] Xd ago) [or "No active alerts"]
(or: Alerts — alert-state.json not found (hermit not yet initialized).)

### Proposal queue
- N proposed (pending review), N accepted (in flight), N in_progress
(or: Queue empty.)

### Routine engagement
- [id]: enabled, schedule [cron], [last ran Xh ago | N runs, N empty | output: N proposals, N micro | since YYYY-MM-DD] [suppress mix suffix if applicable]
- [id]: disabled
(or: Routine engagement — config.json not found.)

### Micro
- N pending decision
(omit section entirely if zero pending)

### Knowledge
- N raw, N compiled, N archived

### Channel availability
- [channel]: ready (dm_channel_id set) [or "not yet paired"]
(or: No channels configured — run /claude-code-hermit:channel-setup.)

### Fragile zones
- [tag or theme]: [one-line reason]
(or: No fragile zones detected — no blocked/partial sessions yet.)

### Stale proposals
- PROP-NNN: [title] (accepted N days ago)
(or: No accepted proposals awaiting resolution.)

### Recent learnings
- [learning]
(or: No recent learnings — reflect hasn't run yet.)
```

Omit sections that have no data rather than showing a heading with an empty body. Keep each bullet to one line. If the assembled report would exceed 1500 chars, keep Alerts, Proposal queue, and Fragile zones in full and truncate the longer lists (Routine engagement, Recent learnings) to their top 2 entries.
