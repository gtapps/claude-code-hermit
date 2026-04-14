---
name: channel-responder
description: Handles inbound messages from Claude Code Channels (Telegram, Discord, webhooks) with session context awareness.
---

# Channel Responder

When a message arrives via a channel:

## 1. Load Context

Read `.claude-code-hermit/sessions/SHELL.md` for current task context.
Read `state/runtime.json` for lifecycle state (`session_state` is the source of truth — never parse SHELL.md `Status:` for decisions).

## 1b. Check Session State

If runtime.json `session_state` is `idle` (no active task):

- The agent is between tasks, waiting for work
- Adjust classification: "New instruction" messages become **task assignment** (see below)
- Status requests should report idle state with session summary

If runtime.json `session_state` is `waiting` (alive but blocked on input):

- **Status request** → respond with current context, stay `waiting`
- **New instruction or answer to a question** → update runtime.json `session_state` to `in_progress`, update SHELL.md Status to `in_progress` (cosmetic), resume work
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

## 1d. Persist Chat ID

After authorization passes, store the inbound `chat_id` to `config.json` → `channels.<channel>.dm_channel_id` (e.g. `channels.discord.dm_channel_id`) if it differs from the currently stored value or hasn't been stored yet.

This is how the agent learns the DM channel ID for proactive outbound notifications. In Discord, the DM channel ID differs from the user ID and is only discoverable from an inbound message. Write back to `config.json` only when the value has changed to avoid unnecessary writes.

## 2. Classify the Message

- **Status request** ("what are you working on?", "status", "progress")
  - If Status is `idle`: respond with session summary — tasks completed, cumulative cost, "ready for what's next"
  - If Status is `in_progress`: respond with a concise summary of SHELL.md: task, current step, blockers
  - Keep it short — channel messages should be brief

- **Task assignment** (only when Status is `idle`: "work on X", "next task: Z", "start Y", or any message describing work to be done)
  - Invoke `/claude-code-hermit:session-start` to begin the new task (idle → in_progress)
  - The session-start skill handles filling Task and setting Status; plan items are created as native Tasks
  - Confirm via channel: "On it: [summary]."

- **Micro-approval response** ("yes", "no", or similar while a pending micro-proposal exists)
  - Read `state/micro-proposals.json`. If `active` is not null and `status` is `pending`:
    - **"yes"** on tier 1 → execute the change at next idle, log outcome in SHELL.md, set `status: "approved"`, clear `active` to null. Append `micro-resolved` event via `append-metrics.js`: `{"ts":"<now ISO>","type":"micro-resolved","micro_id":"<id>","action":"approved"}`
    - **"yes"** on tier 2 → create PROP-NNN via `/claude-code-hermit:proposal-create`, queue for next idle, set `status: "approved"`, clear `active` to null. Append `micro-resolved` event.
    - **"no"** → set `status: "rejected"`, clear `active` to null. Append `micro-resolved` event with `"action":"rejected"`.
    - **Ambiguous response** → ask for clarification once, do not resolve yet.
  - If no pending micro-proposal: classify as normal message (fall through to categories below).

- **Proposal approval** ("accept PROP-", "go ahead with PROP-", "approve PROP-", or referencing proposal numbers)
  - Route through `/claude-code-hermit:proposal-act accept PROP-NNN` for each referenced proposal
  - If the operator uses informal numbers (#1, #2): run `/claude-code-hermit:proposal-list` to resolve to PROP-NNN IDs. If no match, tell the operator.

- **New instruction** ("work on X", "switch to Y", "prioritize Z")
  - If Status is `idle`: treat as **Task assignment** (above)
  - If compatible with current task: update SHELL.md and confirm
  - If it would replace the current task: confirm with the operator before switching
  - Never silently abandon work in progress

- **Question** ("why did you...", "what about...", "how does X work?")
  - Answer in the context of the current session
  - Reference specific files or decisions from SHELL.md when relevant

- **Emergency** ("stop", "abort", "revert", "rollback")
  - Halt current work immediately
  - Update SHELL.md with status `blocked` and reason
  - Confirm the halt and ask for next steps

## 3. Response Guidelines

- Keep responses concise — one short paragraph max for channels
- Always reference the current task so the operator knows you're oriented
- If you can't handle the request, say so clearly and suggest what the operator should do

## Note

This skill is a stub for the Channels research preview (Claude Code v2.1.98+). As Channels matures, extend this skill with:

- Platform-specific formatting (Telegram markdown vs Discord markdown)
- Rich responses (buttons, inline keyboards)
- File/image sharing capabilities
