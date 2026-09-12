---
name: spawn-session
description: Spawn a background Claude Code helper in its own git worktree, watch it until idle, and relay its report to the operator. Use when the operator says "spawn a helper", "spawn-session", "run this in a background session", or names `/spawn-session`.
---
# Spawn Session

Launch a background Claude Code session in its own git worktree, subscribe to
its idle notice, and relay the report through `/claude-code-hermit:watch`.

## Usage

```
/claude-code-hermit:spawn-session <prompt-or-/skill> [--name <n>] [--model <m>] [--effort <e>]
```

From `<abs>`, the project root, that composes:

```
claude --bg --worktree <n> --name <n> [--permission-mode <p>] [--remote-control <n>] [--model <m>] [--effort <e>] '<prompt>'
```

`--remote-control <n>` is present when `config.json`'s `remote` is `true` and
absent otherwise; `--model` and `--effort` only when the operator passed them.
Four limits sit on that command:

- The helper's worktree `.claude-code-hermit/` is a projection (`OPERATOR.md`,
  `config.json`, `compiled/` only). Any file the helper must Read is passed as
  an absolute path in the prompt.
- A worktree carries no `.claude/settings.local.json` (it is gitignored, so
  nothing checks it out), so the helper inherits none of this hermit's
  permission rules. `--permission-mode <p>` from `config.json`'s
  `permission_mode` is what keeps it in this session's permission class, which
  is also what lets its idle notice reach here rather than being held for an
  operator who is not watching. `config.json` accepts one value the CLI has no
  choice for, `default`, so it and `null` and an absent key all mean: leave the
  flag off entirely and let the helper take the box default.
  `scripts/hermit-start.ts` resolves `default` and `null` the same way;
  match that rather than inventing a second answer. It does not agree on an
  absent key, which it reads as `auto` rather than as no flag.
  `bypassPermissions` is the one value that does not pass through: it
  becomes `--permission-mode auto` because a helper has no approval
  surface of its own, and `auto` is the only mode that stays unattended
  behind a gate.
- The prompt is one single-quoted argument. An apostrophe in it ends the quote,
  so replace every `'` with `'\''` before composing. Anything after the closing
  quote is a second command the operator never asked for.
- The launch is not pre-approved, and what the operator sees depends on the
  mode they run in. On `auto`, the shipped default, the classifier decides and
  no prompt reaches them on any channel. On `acceptEdits` or `manual` the native
  approval is relayed to their DM and is allow-once, so every spawn asks again.
  On `bypassPermissions` there is none. Say what is about to be spawned before
  running it either way: it is the only thing that makes the launch legible
  when an approval does arrive, and the only record when none does.

Use only the launch options documented here. Never add bypass flags, tool
preapprovals, or settings overrides to widen the helper's permissions. If launch
or execution is blocked, report the blocker; do not retry through a script,
alternate invocation, or weaker permission mode.

## Plan

1. Parse `--name`, `--model`, and `--effort` from the invocation.
   Remaining text is the prompt. Empty prompt: stop with a one-line ask for
   the work to run.

   - When `--name` is omitted, derive `<n>` from the prompt: drop a leading `/`
     and any `<plugin>:` namespace, lowercase, replace every non-`[a-z0-9]` run
     with `-`, keep the first five nonempty tokens joined by `-`, cap the slug
     at 40 characters, trim any leading or trailing `-`, then append `-` plus
     the full epoch (`date +%s`). The trim is what keeps a prompt like
     `#220 fix the parser` from producing a name the launch command reads as a
     flag. The epoch is not truncated because `claude --worktree <n>` silently
     reuses an existing `.claude/worktrees/<n>`, its branch and uncommitted
     state included, and those directories are never pruned, so a repeated
     name is a wrong-branch start with no error. If no token survives the slug
     is `session`, which is what makes the fallback `session-<epoch>`.
     Example: `/tackle-issue PROP #220` becomes
     `tackle-issue-prop-220-1788889689`.
   - `<m>` / `<e>` are omitted when the operator does not name them, so the
     helper takes the box defaults.

2. Resolve `<abs>` with `git rev-parse --show-toplevel` rather than reading the
   Bash tool's working directory, which persists across calls and can sit in a
   subdirectory. Read `<p>` from `<abs>/.claude-code-hermit/config.json`
   (`permission_mode`), dropping the flag for `default`, `null` or an absent
   key, mapping `bypassPermissions` to `auto` (Four limits), and passing
   every other value through unchanged. Read `remote` from the same config
   and include `--remote-control <n>` only when the key is present and
   `true`; `false`, `null` and an absent key all leave the flag off, which
   is the resident session's own answer for that config. Append this
   sentence to the operator's prompt:

   `The hermit project is at <abs>; its state lives in <abs>/.claude-code-hermit/. Resolve any project-relative .claude-code-hermit/ reads/writes against <abs>; pass the absolute <abs>/.claude-code-hermit path to any hermit script rather than relying on your cwd.`

3. `cd <abs>` as its own Bash call, then run the command in Usage as the next
   one, so the launch stands alone in the transcript and in any approval that
   does reach the operator. Print the returned bg id and `claude logs <id>`,
   `claude attach <id>`, `claude stop <id>` hints. If the spawn is declined or
   fails, stop; do not watch.

4. Invoke `/claude-code-hermit:watch session <n> "<first 40 chars of the operator prompt>"`.
   That skill owns the subscription (`### Starting a session watch`) and the
   idle-notice relay (`### Handling idle notices`); do not re-implement either.
   When it declines the subscription, the helper is still running: say so, and
   give the `claude logs <id>` id as the way to check on it.

## Stuck helper

`claude logs <id>`, `claude stop <id>`, and the watch expiry notice. Never tmux.
