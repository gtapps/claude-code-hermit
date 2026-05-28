---
name: hermit-health
description: "Show alert state, proposal queue depth, routine engagement, and channel availability. Activates on messages like 'health check', 'how's the hermit', 'is anything broken', 'hermit health', 'system health', 'anything wrong', 'hermit status', 'are routines running'."
---
# Hermit Health

Synthesize a compact infrastructure snapshot: active alerts, proposal queue, routine engagement, and whether channels are ready for outbound sends.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation.

## Scope

Read the following (gracefully skip any file that doesn't exist):

1. `.claude-code-hermit/state/alert-state.json` — `active` array and `suppressed` array; each entry has `type`, `timestamp`, `message`.
2. `.claude-code-hermit/state/runtime.json` — `last_activity`, `session_id`.
3. `.claude-code-hermit/state/reflection-state.json` — `last_reflection` timestamp and `counters.judge_suppress_by_code` map.
4. `.claude-code-hermit/config.json` — `routines` array (id, schedule, enabled); `channels` object (each channel's `dm_channel_id`).
5. `.claude-code-hermit/proposals/PROP-*.md` — glob; count by `status` frontmatter field.

## Analysis

**Alerts:** Count entries in `alert-state.json → active`. For each, compute age from `timestamp`. Show oldest. If none: "No active alerts."

**Proposal queue:** Count proposals with `status: proposed` (pending operator review) and `status: accepted` (in flight, not yet resolved). If both zero: "Queue empty."

**Routine engagement:** From `config.json.routines`, list each routine with `enabled: true` and its schedule. For the `reflect` routine, use `reflection-state.json → last_reflection` to show when it last ran; also check `counters.judge_suppress_by_code` — if any code has a non-zero count, append a compact suppress-mix suffix on the same bullet: `suppress mix — no-evidence:N, covered-by-memory:N, no-sessions:N` (omit codes with count 0; omit the suffix entirely when all counts are 0 or the map is absent). For other routines, report schedule and enabled state — per-routine last-run tracking is not yet available.

**Channel availability:** From `config.json.channels`, for each configured channel, check whether `dm_channel_id` is set. Report "ready" or "not yet paired (no dm_channel_id — send a message first)".

## Output

Reply in ≤1500 chars. Use exactly this section structure:

```
### Alerts
- N active (oldest: [type] Xd ago) [or "No active alerts"]
(or: Alerts — alert-state.json not found (hermit not yet initialized).)

### Proposal queue
- N proposed (pending review), N accepted (in flight)
(or: Queue empty.)

### Routine engagement
- [id]: enabled, schedule [cron], [last run or "no run data"] [suppress mix suffix if applicable]
- [id]: disabled
(or: Routine engagement — config.json not found.)

### Channel availability
- [channel]: ready (dm_channel_id set) [or "not yet paired"]
(or: No channels configured — run /claude-code-hermit:channel-setup.)
```

Omit sections that have no data rather than showing a heading with an empty body. Keep each bullet to one line.
