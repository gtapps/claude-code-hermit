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
channel's MCP server, named `mcp__plugin_<source>_<source>__reply` where
`<source>` is the value of the `source` attribute on the inbound `<channel>`
tag. Pass the inbound `chat_id` back. Optionally pass `reply_to` (the inbound
`message_id`) to thread under the operator's message.

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
- `"unclean_shutdown"` or `"dead_process"` → operator reply is an archive/resume choice: `(1)` = archive as partial and start fresh, `(2)` = resume as-is. Handle accordingly via `claude-code-hermit:session-mgr` — session-mgr owns the full state transition including clearing `waiting_reason`.
- `"operator_input"`, `"conservative_pickup"`, or null → treat as normal task resumption.

- **Status request** → respond with current context, stay `waiting`
- **New instruction or answer to a question** → update runtime.json `session_state` to `in_progress`, clear `waiting_reason` to `null`, resume work
- **Anything else** → respond, stay `waiting`

## 1c. Check Authorization

Read `config.json` → `channels.<channel>.allowed_users` for the inbound channel:

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

This writes `state/last-operator-action.json` with the current timestamp, resetting the AUTO_CLOSE quiet window (used by both the 12h-inactivity trigger and the daily-midnight lull drain). The `UserPromptSubmit` hook deliberately skips `<channel` prompts (it can't see the allowlist); this step is the authorized write site.

## 1e. Persist Chat ID

After authorization passes, store the inbound `chat_id` to `config.json` → `channels.<channel>.dm_channel_id` (e.g. `channels.discord.dm_channel_id`) if it differs from the currently stored value or hasn't been stored yet.

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

- **Task assignment** (only when `session_state` is `idle`: "work on X", "next task: Z", "start Y", or any message describing work to be done)
  - Invoke `/claude-code-hermit:session-start` to begin the new task (idle → in_progress)
  - The session-start skill handles filling Task and setting `session_state`; plan items are created as native Tasks
  - Confirm via channel: "On it: [summary]."

- **Micro-approval response** ("yes", "no", "MP-… yes/no", or similar while any pending micro-proposal exists)
  - Read `state/micro-proposals.json → pending`. Filter to `status: "pending"` entries.
  - **Resolve which entry the response targets:**
    - If the message includes an ID prefix (`MP-YYYYMMDD-N yes`): match that entry by id.
    - If bare `yes`/`no` and exactly one pending entry: apply to that entry.
    - If bare `yes`/`no` and multiple pending entries: reply listing the pending IDs and ask the operator to specify (e.g. `"MP-20260422-0 yes"`). Do not resolve yet.
  - **On resolved entry:**
    - Read `question` from the entry before modifying.
    - **"yes"** on tier 1 → execute the change at next idle, log outcome in SHELL.md, set `status: "approved"`. Append `micro-resolved` event via `append-metrics.ts`: `{"ts":"<now ISO>","type":"micro-resolved","micro_id":"<id>","action":"approved","question":"<question>"}`
    - **"yes"** on tier 2 → create PROP-NNN via `/claude-code-hermit:proposal-create`, queue for next idle, set `status: "approved"`. Append `micro-resolved` event with `"action":"approved"`.
    - **"no"** → set `status: "rejected"`. Append `micro-resolved` event with `"action":"rejected","question":"<question>"`.
    - Remove the resolved entry from `pending`. Write the file.
    - **Ambiguous response** → ask for clarification once, do not resolve yet.
  - If no pending micro-proposals: classify as normal message (fall through to categories below).

- **Proposal approval** ("accept PROP-", "go ahead with PROP-", "approve PROP-", or referencing proposal numbers)
  - Route through `/claude-code-hermit:proposal-act accept PROP-NNN` for each referenced proposal
  - If the operator uses informal numbers (#1, #2): run `/claude-code-hermit:proposal-list` to resolve to PROP-NNN IDs. If no match, tell the operator.

- **New instruction** ("work on X", "switch to Y", "prioritize Z")
  - If `session_state` is `idle`: treat as **Task assignment** (above)
  - If compatible with current task: update SHELL.md and confirm
  - If it would replace the current task: confirm with the operator before switching
  - Never silently abandon work in progress

- **Question** ("why did you...", "what about...", "how does X work?")
  - Answer in the context of the current session
  - Reference specific files or decisions from SHELL.md when relevant

- **Emergency** ("stop", "abort", "revert", "rollback")
  - Halt current work immediately
  - Set `runtime.json` `session_state` to `waiting` (`waiting_reason: "operator_input"`) and note the halt reason in SHELL.md `## Blockers`
  - Confirm the halt and ask for next steps

## 3. Response Guidelines

- Keep responses concise — one short paragraph max for channels
- Always reference the current task so the operator knows you're oriented
- If you can't handle the request, say so clearly and suggest what the operator should do

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

## Note

This skill is a stub for the Channels research preview (Claude Code v2.1.110+). As Channels matures, extend this skill with:

- Platform-specific formatting (Telegram markdown vs Discord markdown)
- Rich responses (buttons, inline keyboards)
- File/image sharing capabilities
