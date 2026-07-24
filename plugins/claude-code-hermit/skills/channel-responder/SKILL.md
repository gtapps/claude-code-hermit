---
name: channel-responder
description: Handles inbound messages from Claude Code Channels (Telegram, Discord, webhooks) with session context awareness.
---

# Channel Responder

When a message arrives via a channel:

## 0. Reply via the channel

ALL responses to messages wrapped in `<channel source="..." chat_id="..." ...>`
MUST be delivered via the channel's reply tool, not the terminal/transcript.
Terminal output is invisible to the operator: they read Discord, Telegram, or
the configured channel, never the raw transcript.

For each channel plugin, the reply tool is the `reply` action exposed by the
channel's MCP server, named `mcp__plugin_<plugin-name>_<server-name>__reply` —
the two segments are exactly the plugin name and server name the harness puts in
the plugin-qualified source on the wire (`source="plugin:<plugin-name>:<server-name>"`).
For the built-in channels the two coincide (e.g. `plugin:discord:discord` →
`mcp__plugin_discord_discord__reply`), but a custom channel plugin whose names
differ fills each slot from its own wire segment (e.g. `plugin:acme-crm:crm` →
`mcp__plugin_acme-crm_crm__reply`) — build the tool name from the raw `source`,
not by doubling one segment. Every `config.channels` key below instead uses the
normalized bare server name (`discord`, not the qualified string — see
`lib/channel-envelope.ts`'s `normalizeChannelSource`). Pass the
inbound `chat_id` back. Optionally pass `reply_to` (the inbound `message_id`)
to thread under the operator's message.

Terminal output is acceptable as a SECONDARY surface (tool-call narration,
status visible only to a maintainer at the box). The substantive response,
the one the operator needs to see, must go through the channel.

## 1. Load Context

Read `.claude-code-hermit/sessions/SHELL.md` for current task context.
Read `state/runtime.json` for lifecycle state (`session_state` is the source of truth — never parse SHELL.md `Status:` for decisions).

## 1b. Check Session State

If runtime.json `session_state` is `idle` (no active task):

- The agent is between tasks, waiting for work
- Adjust classification: "New instruction" messages become **task assignment** (see below)
- Status requests should report idle state with session summary

If runtime.json `session_state` is `waiting` (alive but blocked on input):

Read `waiting_reason` from runtime.json to understand why:
- `"unclean_shutdown"` or `"dead_process"` → operator reply is an archive/resume choice:
  - `(1)` archive as partial and start fresh: pipe `Status: partial\nBlockers: none\nClosed Via: operator\n` on stdin to `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts archive --mode=close --state-dir=.claude-code-hermit`. On `ok === true`, clear `waiting_reason` and `last_error` in runtime.json.
  - `(2)` resume as-is: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts open --state-dir=.claude-code-hermit` with an empty `Task:` payload (SHELL.md's existing Task is left untouched) to set `session_state` back to `in_progress`; then clear `waiting_reason` and `last_error` in runtime.json.
  - Either branch: if the script returns `ok === false`, surface the `reason` to the operator rather than silently proceeding as if the transition completed.
- `"operator_input"`, `"conservative_pickup"`, or null → treat as normal task resumption.

- **Status request** → respond with current context, stay `waiting`
- **New instruction or answer to a question** → update runtime.json `session_state` to `in_progress`, clear `waiting_reason` to `null`, resume work
- **Anything else** → respond, stay `waiting`

If a shutdown is pending (`shutdown_requested_at` set, `shutdown_completed_at` null) and the shutdown-gate hook did not already intercept, reply that shutdown is in progress and start no new work.

## 1c. Check Authorization

Read `config.json` → `channels.<channel>.allowed_users` for the inbound channel
(`<channel>` is the normalized bare key per §0 — e.g. `discord`, not
`plugin:discord:discord`):

- Extract the sender's platform user ID from the message metadata
- If the sender is not in the `allowed_users` list: ignore the message silently — do not respond, do not log. Applies to ALL message types including status requests.
- If `allowed_users` is absent for this channel: accept all messages (backwards compatible)
- If `allowed_users` is an empty array `[]`: accept from no one (explicit lockdown)

The allowlist is per-channel inside the `channels` object in config.json:

```json
{
  "channels": {
    "discord": { "enabled": true, "allowed_users": ["user-id-1"] },
    "telegram": { "enabled": true, "allowed_users": ["user-id-1"] }
  }
}
```

## 1d. Record Operator Activity

After authorization passes, run:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/record-operator-action.ts --force
```

This writes `state/last-operator-action.json` with the current timestamp, resetting the AUTO_CLOSE quiet window (used by both the 12h-inactivity trigger and the daily-midnight lull drain). It also opens `state/operator-turn-open.json`, which defers monitor-mode routines for the rest of this exchange (cleared at Stop). The `UserPromptSubmit` hook deliberately skips `<channel` prompts (it can't see the allowlist); this step is the authorized write site for both. Run it as early as authorization allows — a routine due before it lands can interject mid-exchange.

## 1e. Persist Chat ID

After authorization passes, store the inbound `chat_id` to `config.json` → `channels.<channel>.dm_channel_id` (e.g. `channels.discord.dm_channel_id` — the normalized bare key per §0, never the raw qualified source) if it differs from the currently stored value or hasn't been stored yet.

This is how the agent learns the DM channel ID for proactive outbound notifications. In Discord, the DM channel ID differs from the user ID and is only discoverable from an inbound message. Write back to `config.json` only when the value has changed to avoid unnecessary writes.

## 2. Classify the Message

Before running any heavy sub-step — an archive traversal, a multi-file search, or a delegated execution step — apply the **Context-hygiene & delegation** rule: delegate when its criteria hold and keep only the verdict.

- **Slash command** (message starts with `/`, e.g. `/claude-code-hermit:simplify`, `/plugin:command`)
  - Invoke the matching skill, slash command, or subagent via the appropriate tool. Pass any remaining text as arguments/prompt.
  - If nothing matches, say so briefly.

- **Status request** ("what are you working on?", "status", "progress")
  - If `session_state` (runtime.json) is `idle`: respond with session summary — tasks completed, cumulative cost, "ready for what's next"
  - If `session_state` is `in_progress`: respond with a concise summary of SHELL.md: task, current step, blockers
  - Keep it short — channel messages should be brief

- **Spend request** ("how much have I spent", "why is my bill high", "cost breakdown", "what's my spend", or any variant asking about spend/cost/billing, in any language)
  - **If `config.operator_profile === 'non-technical'`:** do not invoke cost-reflect or surface figures. Reply in the client chat with a localized plain deflection: en "Day-to-day costs are handled by your provider — anything else I can help with?" / pt-PT "Os custos do dia a dia são geridos pelo seu fornecedor — posso ajudar com mais alguma coisa?" (spend figures stay available maintainer-side: terminal, maintainer chat, weekly review).
  - Otherwise invoke `/claude-code-hermit:cost-reflect`. Its own Step 0/1 already detect the channel-tagged turn and run the plain-language `--plain` mode — do not run the raw token-category breakdown here.

- **Task assignment** (only when `session_state` is `idle`: "work on X", "next task: Z", "start Y", or any message describing work to be done)
  - Invoke `/claude-code-hermit:session-start` to begin the new task (idle → in_progress)
  - The session-start skill handles filling Task and setting `session_state`; plan items are created as native Tasks
  - Confirm via channel: "On it: [summary]."

- **Micro-approval response** ("yes", "no", "MP-… yes/no", "MP-… <number>", "MP-… <label>", a bare number, or a bare label while any pending micro-proposal exists)
  - Read `state/micro-proposals.json → pending`. Filter to `status: "pending"` entries.
  - **Resolve which entry the response targets:**
    - If the message includes an ID prefix (`MP-YYYYMMDD-N yes` / `MP-YYYYMMDD-N 2` / `MP-YYYYMMDD-N <label>`): match that entry by id.
    - If a bare answer (yes/no, a number, or a label) and exactly one pending entry: apply to that entry.
    - If a bare answer and multiple pending entries: reply listing the pending IDs (with their `options`, if any) and ask the operator to specify (e.g. `"MP-20260422-0 yes"` or `"MP-20260422-0 2"`). Do not resolve yet.
  - **Parsing the answer against the target entry:**
    - Entry has no `options` (plain yes/no entry): the answer must be `yes` or `no` (case-insensitive). Anything else on this entry → ambiguous, ask for clarification once, do not resolve.
    - Entry has `options` (2-4 labels): a bare number `k` within range (1 through the option count) selects `options[k-1]`; a number outside that range is ambiguous. Otherwise, case-insensitive prefix match the answer against the labels; a unique match resolves, no match or a multi-label prefix match is ambiguous. A bare `yes`/`no` against an options entry is ambiguous — reply with the numbered options and ask once, do not resolve.
  - **Suggestion escape hatch:** when a bare `yes`/`no`/`later` can't be cleanly resolved here (ambiguous against an options entry, or multiple pending entries), run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposals-index.ts .claude-code-hermit` (validates the index against disk — one bounded output line) and check the refreshed `state/proposals-index.json`. If it has a `status: "proposed"` proposal, append to the clarification reply: "…or reply 'YES #N' to act on an open suggestion instead." Precedence is unchanged — this only hands a bare reply meant for a Suggestion card a way out of the micro-proposal loop.
  - **On resolved entry:**
    - Read `question` from the entry before modifying.
    - **Entry has `on_resolve`** → **resolve the entry on disk FIRST, then invoke.** Set `status: "approved"`, remove the entry from `pending`, write the file, and append the `micro-resolved` event below — all *before* invoking the command. The `on_resolve` command can run a long implementation (e.g. `proposal-act … --answer "implement now"` runs the falsification gate + full implementation); if the durable-queue removal were left until after that, a crash or compaction mid-implementation would leave the entry `status: "pending"` and heartbeat would keep re-nudging a question already acted on. Append `micro-resolved` event via stdin heredoc (question/answer are operator text and may contain apostrophes):
      ```bash
      bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/proposal-metrics.jsonl <<'HERMIT_METRICS_JSON'
      {"ts":"<now ISO>","type":"micro-resolved","micro_id":"<id>","action":"answered","answer":"<selected label>","question":"<question>"}
      HERMIT_METRICS_JSON
      ```
      Then substitute the selected label into the `on_resolve` `{answer}` placeholder — **wrap it in double quotes** so a multi-word label (e.g. `session task`) stays a single `--answer` argument — and invoke the resulting skill command. This is how a channel-bridged ask (e.g. a 3-option proposal-act entry) re-enters the asking skill at the right branch — the invoked command itself detects it's a re-entry and skips straight to acting on the answer. The `answered` event is audit-only (neither an approval nor a rejection, so it's outside the micro approval-rate metrics). See § Channel-safe ask bridge below. Because this branch already removed the entry and wrote the file, skip the shared "Remove the resolved entry" step below.
    - **No `on_resolve`, "yes" on tier 1** → execute the change at next idle, log outcome in SHELL.md, set `status: "approved"`. Append `micro-resolved` event via stdin heredoc (question is operator text and may contain apostrophes):
      ```bash
      bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/proposal-metrics.jsonl <<'HERMIT_METRICS_JSON'
      {"ts":"<now ISO>","type":"micro-resolved","micro_id":"<id>","action":"approved","question":"<question>"}
      HERMIT_METRICS_JSON
      ```
    - **No `on_resolve`, "yes" on tier 2** → create PROP-NNN via `/claude-code-hermit:proposal-create`, queue for next idle, set `status: "approved"`. Append `micro-resolved` event (same stdin heredoc form, `"action":"approved"`).
    - **No `on_resolve`, "no"** → set `status: "rejected"`. Append `micro-resolved` event (stdin heredoc, `"action":"rejected","question":"<question>"`).

    - **(yes/no branches only)** Remove the resolved entry from `pending`. Write the file. (The `on_resolve` branch already did this above, before invoking the command.)
  - If no pending micro-proposals: classify as normal message (fall through to categories below).

- **Proposal approval** ("accept PROP-", "go ahead with PROP-", "approve PROP-", referencing proposal numbers, `#N`, or a bare/`#N`-qualified `YES`/`LATER`/`NO` reply to a Suggestion card — only when no pending micro-proposal claimed the reply first, per Micro-approval response above)
  - **Map the reply to an action** (case-insensitive): `YES` / "go ahead" / "accept" → `accept`; `LATER` / "hold" / "defer" → `defer`; `NO` / "drop" / "dismiss" → `dismiss`. `accept PROP-`/`approve PROP-` phrasing maps to `accept` directly; the operator can also spell the action out instead of YES/LATER/NO.
  - **Resolve the target proposal:** first run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposals-index.ts .claude-code-hermit` to validate the index against disk (one bounded output line — catches out-of-band file renames/moves that never went through Write/Edit). Then, for an explicit `#N` or `PROP-NNN` reference — confirm it matches a proposal in the refreshed `state/proposals-index.json`; if it doesn't, reply in plain voice ("I don't see a Suggestion #N — reply with one of the open numbers") rather than routing to `proposal-act` (whose no-match error is terminal-voice and names a slash command). On a match, route through `/claude-code-hermit:proposal-act <action> PROP-N` (`proposal-act` zero-pads the integer itself). A bare `YES`/`LATER`/`NO` with no `#N`: read the refreshed `state/proposals-index.json`, filter to `status: "proposed"`. Exactly one → apply to it. Zero or 2+ → reply listing the open Suggestion numbers and ask the operator to specify (e.g. "Reply 'YES #14'").
  - Never surface internal proposal fields back to the channel (the exact list and `#N` derivation are canonical in `proposal-list` §4a) — confirm using the Suggestion number (see `proposal-act`'s channel-tagged notify).

- **New instruction** ("work on X", "switch to Y", "prioritize Z")
  - If `session_state` is `idle`: treat as **Task assignment** (above)
  - If compatible with current task: update SHELL.md and confirm
  - If it would replace the current task: confirm with the operator before switching
  - Never silently abandon work in progress

- **Question** ("why did you...", "what about...", "how does X work?")
  - Answer in the context of the current session
  - Reference specific files or decisions from SHELL.md when relevant

- **Pause / resume / snooze** (bare, exact-match "pause", "stop", "resume", or "snooze <duration>")
  - These exact messages are intercepted by the `pause-keyword.ts` `UserPromptSubmit` hook (PROP-015) **before this skill ever runs** — `state/pause.json` is already set or cleared by the time you see the prompt. There is nothing left for you to do for the state change itself; if you want to acknowledge it, reply via the channel.
  - A sentence that merely mentions "pause" or "stop" (not an exact match) is not intercepted — classify it under Emergency below instead.
  - **Never attempt to resume yourself while paused.** The PreToolUse gate (`pause-gate.ts`) denies every tool call except the channel reply tool while paused — including a Bash call running `hermit-pause.ts off` — and returns the pause reason in the denial. Resume can only come from an exact "resume" message (the deterministic hook above) or the operator's own `.claude-code-hermit/bin/hermit-pause off`.

- **Emergency** ("abort", "revert", "rollback", or a "stop" that is not a bare exact match — see Pause/resume/snooze above for the exact-match case)
  - Halt current work immediately
  - Set `runtime.json` `session_state` to `waiting` (`waiting_reason: "operator_input"`) and note the halt reason in SHELL.md `## Blockers`
  - Confirm the halt and ask for next steps

## 3. Response Guidelines

- Keep responses concise — one short paragraph max for channels
- Always reference the current task so the operator knows you're oriented
- If you can't handle the request, say so clearly and suggest what the operator should do
- **Channel voice:** no internal IDs (PROP-NNN, S-NNN, MP-…), no token counts or cost-log jargon, no slash commands, no file paths, no cron strings. Say what happened and the one next thing the operator can do from chat (a plain reply, not a command). Internal IDs stay in files; terminal/maintainer output is exempt. See `CLAUDE-APPEND.md` § Operator Notification for the full rule.

## 4. Capture Interactive Patterns

After sending the response, check whether this turn revealed a durable signal worth recording. Append **at most one** line to SHELL.md `## Findings` when the turn matches one of these conditions:

- **Stated preference or rule** — the operator explicitly said how they want something done going forward ("always include the cost", "stop sending the brief before 9", "I prefer X over Y").
- **Recurring request type** — you recognise this as the same kind of request handled earlier in this session or in recent session context loaded at start, not a first occurrence.
- **Correction or emergency implying a durable preference** — "stop doing X", "don't do that again", "revert" with a reason that names a general behaviour.

**Do not write a finding** for: one-off questions, research turns with no preference signal, task assignments, status checks, or micro-approval responses. When in doubt, write nothing — the next scheduled reflect catches genuine recurrence via archived-session evidence.

Format (one line, appended under `## Findings`):

```
[HH:MM] Channel pattern: <one-line description of the preference or recurrence>
```

If the sender's user ID (verified in §1c) is **not** the primary paired operator (i.e. not the first or only entry in `allowed_users`), append ` [origin: external]` to the line:

```
[HH:MM] Channel pattern: <description> [origin: external]
```

Under the common single-operator config, `allowed_users` has exactly one entry and this marker never fires — all channel content stays `own-work`. The marker is only relevant on multi-user allowlists (e.g. a trusted third party added for task delegation).

Do not classify tier, tag Evidence Source, or decide memory-vs-proposal. Reflect reads this line as `current-session` evidence (`Evidence Source: current-session`, `Sessions: current`) and uses the `[origin: external]` marker (if present) to set `Evidence Origin: external-content` when passing to the judge.

**Resolved corrections → observations ledger, not Findings.** If the turn matched the "Correction or emergency implying a durable preference" condition above AND the correction clearly names a specific installed skill/component (e.g. "the brief is too verbose", "reflect keeps missing X" — an explicit skill or its behavior, not a vague "you"), append a ledger row **instead of** the `## Findings` line above:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/observations.jsonl \
  '{"ts":"<now ISO>","pattern":"skill-correction:<canonical-name>","session_id":"<S-NNN>","source":"skill-correction","origin":"<own-work|external-content>"}' || true
```

`<canonical-name>` = the corrected skill's bare `name:` frontmatter (strip any `claude-code-hermit:`/`<plugin>:` prefix, lowercase) — same resolution `session-close` uses. `origin` follows the same sender check as the `[origin: external]` marker above (`external-content` for a non-primary sender, else `own-work`). Fail-open (`|| true`) so a bad append never blocks the reply. At most one row per turn, same as the Findings cap.

If the correction is a stated preference/recurrence with **no** clearly named skill, keep writing the `## Findings` line as before — do not guess a `<name>` and do not ask the operator to disambiguate mid-reply.

## 5. Outbound notification protocol

Canonical protocol for proactively notifying the operator (referenced from `CLAUDE-APPEND.md` § Operator Notification). Main owns the outbound send and any `AskUserQuestion`; a delegated sub-step returns the message and main runs this protocol.

- **If no channel is enabled** (channels block absent, `channels === {}`, or every channel-config entry has `enabled === false` — exclude the `primary` string pointer when iterating):
  - If `push_notifications === true` in `config.json`, fire `PushNotification(message="<condensed one-line ≤200 chars, no markdown, actionable detail first>", status="proactive")`. Push is best-effort; do not retry on failure and do not log a `channel-send-unavailable` issue for this branch — the operator's empty-channels config is intentional.
  - Respond in conversation either way (the conversation response is the durable record).
- **If at least one channel is enabled**, resolve the outbound target by running:
  ```
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-outbound-channel.ts .claude-code-hermit
  ```
  Parse stdout as JSON. A channel is eligible if `enabled !== false`, `allowed_users` is not `[]`, and `dm_channel_id` is set. Resolution order: `channels.primary` (if set and eligible), then the first eligible entry in `channels` (operator's config order — no hardcoded slug list, so newly added channel plugins are picked up automatically).
  - **On success** (`"id"` and `"chat_id"` in result): call `mcp__plugin_<id>_<id>__reply` with `{ chat_id, text: <message> }`. When the result also carries a `"language"` field, compose `<message>` in that language. If the reply call itself fails (token expired, plugin crashed, network blip) and `push_notifications === true`, fire `PushNotification(message="<...>", status="proactive")` as a last-resort signal, then log + dedup as below.
  - **On miss** (non-zero exit or `{"error":"no_reachable_channel"}` — a channel is configured but unreachable: missing `dm_channel_id`, empty `allowed_users`, or `config_read_failed`): if `push_notifications === true`, fire `PushNotification(message="<...>", status="proactive")`. Then log the unsent content to SHELL.md Findings and record a deduped `channel-send-unavailable` issue regardless of push state — the configured channel is broken and the operator should see the signal. Do not use the user ID as a substitute (it will fail for Discord DMs).
- If outbound send fails after a successful resolve (covered above): log + dedup; do not retry.

## 6. Channel-safe ask bridge

Canonical dual-delivery rule for any skill that hits a decision point on a channel-tagged turn (inbound prompt contains a `<channel source="...">` tag) — referenced from `proposal-act` and `hermit-settings` (and any future skill that needs to ask a bounded question over a channel).

- **(a) Conversational side**: send the question via the channel reply tool, same as any other response — the operator is usually right there.
- **(b) Durable side, bounded asks only**: a bounded ask (2-4 discrete options, including plain yes/no) ALSO gets queued as a pending entry via `queue-micro-proposal.ts` (see reflect's § Micro-approval queuing) — `options` set to the labels (omit for plain yes/no), `tier: 1`, and `on_resolve` set to the skill invocation that should run once an answer is picked, with `{answer}` as the placeholder for the selected label. Free-form asks (no bounded set of answers) are reply-tool only — no entry is queued for those.
- **Whichever surface answers first resolves it.** If the operator answers in the same live turn (interactive-style, still within the asking skill's own flow), the asking skill acts on it directly AND resolves the MP entry itself — remove it from `pending`, write the file, and append the same `micro-resolved` `"action":"answered"` event as § Micro-approval response above — so the entry doesn't dangle waiting for a reply that already happened. If the operator answers later (new turn, possibly a new session), the § Micro-approval response resolver above handles it via `on_resolve`.
- **Never call `AskUserQuestion` on a channel-tagged turn.** It renders in the terminal/transcript, which is invisible to a remote operator — exactly the strand this bridge exists to prevent.

## Note

This skill is a stub for the Channels research preview (Claude Code v2.1.110+). As Channels matures, extend this skill with:

- Platform-specific formatting (Telegram markdown vs Discord markdown)
- Rich responses (buttons, inline keyboards)
- File/image sharing capabilities
