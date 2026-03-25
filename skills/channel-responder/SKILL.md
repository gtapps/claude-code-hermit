---
name: channel-responder
description: Handles inbound messages from Claude Code Channels (Telegram, Discord, webhooks) with session context awareness. Responds in the context of the current mission.
---
# Channel Responder

When a message arrives via a channel:

## 1. Load Context
Read `.claude/.claude-code-hermit/sessions/ACTIVE.md` for current mission context.

## 1b. Check Session State

If ACTIVE.md has Status `idle` (no active mission):
- The agent is between missions, waiting for work
- Adjust classification: "New instruction" messages become **mission assignment** (see below)
- Status requests should report idle state with session summary

## 2. Classify the Message

- **Status request** ("what are you working on?", "status", "progress")
  - If Status is `idle`: respond with session summary — missions completed, cumulative cost, "waiting for next mission"
  - If Status is `in_progress`: respond with a concise summary of ACTIVE.md: mission, current step, blockers
  - Keep it short — channel messages should be brief

- **Mission assignment** (only when Status is `idle`: "work on X", "next mission: Z", "start Y", or any message describing work to be done)
  - Invoke `/claude-code-hermit:session-start` to begin the new mission (idle → in_progress)
  - The session-start skill handles filling Mission, Steps, and setting Status
  - Confirm via channel: "Starting mission: [summary]. Working on it."

- **New instruction** ("work on X", "switch to Y", "prioritize Z")
  - If Status is `idle`: treat as **Mission assignment** (above)
  - If compatible with current mission: update ACTIVE.md and confirm
  - If it would replace the current mission: confirm with the operator before switching
  - Never silently abandon work in progress

- **Question** ("why did you...", "what about...", "how does X work?")
  - Answer in the context of the current session
  - Reference specific files or decisions from ACTIVE.md when relevant

- **Emergency** ("stop", "abort", "revert", "rollback")
  - Halt current work immediately
  - Update ACTIVE.md with status `blocked` and reason
  - Confirm the halt and ask for next steps

## 3. Response Guidelines
- Keep responses concise — one short paragraph max for channels
- Always reference the current mission so the operator knows you're oriented
- If you can't handle the request, say so clearly and suggest what the operator should do

## Note
This skill is a stub for the Channels research preview (Claude Code v2.1.80+). As Channels matures, extend this skill with:
- Platform-specific formatting (Telegram markdown vs Discord markdown)
- Rich responses (buttons, inline keyboards)
- File/image sharing capabilities
