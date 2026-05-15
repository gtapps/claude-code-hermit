---
name: channel-responder
description: Handles inbound messages from Claude Code Channels (Telegram, Discord, webhooks) with session context awareness.
---

# Channel Responder

When a message arrives via a channel:

## 1. Load Context

Read `.claude-code-hermit/sessions/SHELL.md` for current focus context (read `## Focus`, `## Progress Log`, `## Findings`).
Read `state/runtime.json` for lifecycle state (`session_state` is the source of truth).

## 1b. Check Session State

If runtime.json `session_state` is `idle` (no active focus):
- The agent is between focuses, waiting for work.
- Adjust classification: "New instruction" messages become **task assignment** (see below).
- Status requests should report idle state with the last Recent Activity entry.

If runtime.json `session_state` is `waiting` (alive but blocked on input):

Check SHELL.md `## Findings` for a `<!-- pending-recovery: ... -->` marker:
- If present AND the inbound message matches `^[12]$`: this is a recovery reply. (1) = drop the in-flight focus and start fresh; (2) = resume as-is. Use `claude-code-hermit:focus-mgr` to apply the decision and clear the marker. focus-mgr also clears `runtime.shutdown_requested_at` and sets `session_state` to `idle` or `in_progress` accordingly.
- Otherwise:
  - **Status request** → respond with current context, stay `waiting`.
  - **New instruction or answer to a question** → update `session_state` to `in_progress`, resume work.
  - **Anything else** → respond, stay `waiting`.

Tolerate retired enum values silently: if `session_state == "dead_process"` is seen (old runtime.json from a pre-v1.1.0 hermit), treat it the same as `waiting` and the next runtime write narrows it.

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

- **Slash command** (message starts with `/`, e.g. `/simplify`, `/plugin:command`)
  - Invoke the matching skill, slash command, or subagent via the appropriate tool. Pass any remaining text as arguments/prompt.
  - If nothing matches, say so briefly.

- **Status request** ("what are you working on?", "status", "progress")
  - If state is `idle`: respond with the latest Recent Activity entry + cumulative cost + "ready for what's next."
  - If state is `in_progress`: respond with a concise summary of SHELL.md — current focus, current step, blockers.
  - Keep it short — channel messages should be brief.

- **Task assignment** (only when state is `idle`: "work on X", "next task: Z", "start Y", or any message describing work to be done)
  - Invoke `/claude-code-hermit:steer '<text>'` to set the new focus (idle → in_progress).
  - Plan items are created as native Tasks via `TaskCreate`.
  - Confirm via channel: "On it: [summary]."

- **Micro-approval response** ("yes", "no", "MP-… yes/no", or similar while any pending micro-proposal exists)
  - Read `state/micro-proposals.json → pending`. Filter to `status: "pending"` entries.
  - **Resolve which entry the response targets:**
    - If the message includes an ID prefix (`MP-YYYYMMDD-N yes`): match that entry by id.
    - If bare `yes`/`no` and exactly one pending entry: apply to that entry.
    - If bare `yes`/`no` and multiple pending entries: reply listing the pending IDs and ask the operator to specify (e.g. `"MP-20260422-0 yes"`). Do not resolve yet.
  - **On resolved entry:**
    - Read `question` from the entry before modifying.
    - **"yes"** on tier 1 → execute the change at next idle, log outcome in SHELL.md, set `status: "approved"`. Append `micro-resolved` event via `append-metrics.js`: `{"ts":"<now ISO>","type":"micro-resolved","micro_id":"<id>","action":"approved","question":"<question>"}`
    - **"yes"** on tier 2 → create PROP-NNN via `/claude-code-hermit:proposal-create`, queue for next idle, set `status: "approved"`. Append `micro-resolved` event with `"action":"approved"`.
    - **"no"** → set `status: "rejected"`. Append `micro-resolved` event with `"action":"rejected","question":"<question>"`.
    - Remove the resolved entry from `pending`. Write the file.
    - **Ambiguous response** → ask for clarification once, do not resolve yet.
  - If no pending micro-proposals: classify as normal message (fall through to categories below).

- **Proposal approval** ("accept PROP-", "go ahead with PROP-", "approve PROP-", or referencing proposal numbers)
  - Route through `/claude-code-hermit:proposal-act accept PROP-NNN` for each referenced proposal
  - If the operator uses informal numbers (#1, #2): run `/claude-code-hermit:proposal-list` to resolve to PROP-NNN IDs. If no match, tell the operator.

- **New instruction** ("work on X", "switch to Y", "prioritize Z")
  - If state is `idle`: treat as **Task assignment** (above).
  - If compatible with current focus: update SHELL.md and confirm.
  - If it would replace the current focus: confirm with the operator before switching (the in-flight focus content disappears on `/done`).
  - Never silently abandon work in progress.

- **Question** ("why did you...", "what about...", "how does X work?")
  - Answer in the context of the current focus.
  - Reference specific files or decisions from SHELL.md when relevant.

- **Emergency** ("stop", "abort", "revert", "rollback")
  - Halt current work immediately.
  - Append a `Blocked: <reason>` line to SHELL.md `## Blockers` (or `## Findings` if Blockers section is absent).
  - Confirm the halt and ask for next steps.

## 3. Response Guidelines

- Keep responses concise — one short paragraph max for channels
- Always reference the current task so the operator knows you're oriented
- If you can't handle the request, say so clearly and suggest what the operator should do

## Note

This skill is a stub for the Channels research preview (Claude Code v2.1.110+). As Channels matures, extend this skill with:

- Platform-specific formatting (Telegram markdown vs Discord markdown)
- Rich responses (buttons, inline keyboards)
- File/image sharing capabilities
