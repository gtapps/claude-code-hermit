---
name: hermit-health
description: "Show alert state, proposal queue depth, routine engagement, knowledge state, and channel availability. Activates on messages like 'health check', 'how's the hermit', 'is anything broken', 'hermit health', 'system health', 'anything wrong', 'hermit status', 'are routines running'."
---
# Hermit Health

Synthesize a compact infrastructure snapshot: active alerts, proposal queue, routine engagement, knowledge state, and whether channels are ready for outbound sends.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation.

## Scope

Read the following (gracefully skip any file that doesn't exist):

1. `.claude-code-hermit/state/alert-state.json` — `active` array and `suppressed` array; each entry has `type`, `timestamp`, `message`.
2. `.claude-code-hermit/state/runtime.json` — `last_activity`, `session_id`.
3. `.claude-code-hermit/state/reflection-state.json` — `last_reflection` timestamp and `counters` (including `judge_suppress_by_code` map and run/output fields).
4. `.claude-code-hermit/config.json` — `routines` array (id, schedule, enabled); `channels` object (each channel's `dm_channel_id`).
5. `.claude-code-hermit/proposals/PROP-*.md` — glob; count by `status` frontmatter field.
6. `.claude-code-hermit/state/micro-proposals.json` — count entries with `status: "pending"`.
7. Glob counts: `.claude-code-hermit/raw/**` (excluding `.archive/`), `.claude-code-hermit/compiled/**`, `.claude-code-hermit/raw/.archive/**`.

## Analysis

**Alerts:** Count entries in `alert-state.json → active`. For each, compute age from `timestamp`. Show oldest. If none: "No active alerts."

**Proposal queue:** Count proposals with `status: proposed` (pending operator review), `status: accepted` (in flight, not yet resolved), and `status: in_progress`. If all zero: "Queue empty."

**Routine engagement:** From `config.json.routines`, list each routine and its schedule. For the `reflect` routine, use `reflection-state.json → last_reflection` to show when it last ran; also append counter info from `reflection-state.json → counters`: apply the reflect-line rules below, then append the suppress-mix suffix if any `judge_suppress_by_code` code has a non-zero count: `suppress mix — no-evidence:N, covered-by-memory:N, no-sessions:N` (omit codes with count 0; omit the suffix entirely when all counts are 0 or the map is absent). For other routines, report schedule and enabled state — per-routine last-run tracking is not yet available.

**Reflect-line rules** (applied to the reflect routine bullet):
- If `counters` is absent: omit the counter clause entirely
- If `total_runs` is 0: show `no runs yet (since YYYY-MM-DD)` where the date is `counters.since`
- Otherwise: `N runs, N empty | output: N proposals, N micro | since YYYY-MM-DD` where the date is `counters.since` — omit `| output: ...` if both `proposals_created` and `micro_proposals_queued` are 0

**Micro:** Count entries with `status: "pending"` in `micro-proposals.json`. Omit this section entirely if count is zero.

**Knowledge:** Report glob counts for raw (excl. archive), compiled, and archived files. Omit if all three are zero and the directories are missing.

**Channel availability:** From `config.json.channels`, for each configured channel, check whether `dm_channel_id` is set. Report "ready" or "not yet paired (no dm_channel_id — send a message first)".

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
```

Omit sections that have no data rather than showing a heading with an empty body. Keep each bullet to one line.
