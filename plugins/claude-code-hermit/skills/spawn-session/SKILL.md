---
name: spawn-session
description: Spawn a background Claude Code helper in its own git worktree, watch it until idle, and relay its report to the operator. Use when the operator says "spawn a helper", "spawn-session", "run this in a background session", or names `/spawn-session`.
---
# Spawn Session

Launch a background Claude Code session in its own git worktree, subscribe to
its idle notice, and relay the report through `/claude-code-hermit:watch`.

## Usage

```
/claude-code-hermit:spawn-session <prompt-or-/skill> [--name <n>] [--model <m>] [--effort <e>] [--rc]
```

From `<abs>`, the project root, that composes:

```
claude --bg --worktree <n> --name <n> [--permission-mode <p>] [--remote-control <n>] [--model <m>] [--effort <e>] '<prompt>'
```

`--remote-control <n>` is present only with `--rc`; `--model` and `--effort`
only when the operator passed them. Five limits sit on that command:

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
  `scripts/hermit-start.ts` resolves the same value the same way; match it
  rather than inventing a second answer. Every other value passes through
  unchanged, `bypassPermissions` included.
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
- `--rc` needs `/login` credentials on this box. Detect with
  `claude auth status --json`: `authMethod` other than `claude.ai` means no
  `/login` credential. Refuse with one line, do not retry, do not spawn.

## Plan

1. Parse `--name`, `--model`, `--effort`, and `--rc` from the invocation.
   Remaining text is the prompt. Empty prompt: stop with a one-line ask for
   the work to run.

   - `<n>` defaults to `session-<epoch>` (`date +%s`) when `--name` is omitted.
   - `<m>` / `<e>` are omitted when the operator does not name them, so the
     helper takes the box defaults.

2. On `--rc`, run `claude auth status --json` and read `authMethod`. If it is
   not `claude.ai`, refuse with one line and stop. That is final: no retry, no
   workaround.

3. Resolve `<abs>` with `git rev-parse --show-toplevel` rather than reading the
   Bash tool's working directory, which persists across calls and can sit in a
   subdirectory. Read `<p>` from `<abs>/.claude-code-hermit/config.json`
   (`permission_mode`), dropping the flag for `default`, `null` or an absent
   key. Append this sentence to the operator's prompt:

   `The hermit project is at <abs>; its state lives in <abs>/.claude-code-hermit/. Resolve any project-relative .claude-code-hermit/ reads/writes against <abs>; pass the absolute <abs>/.claude-code-hermit path to any hermit script rather than relying on your cwd.`

4. `cd <abs>` as its own Bash call, then run the command in Usage as the next
   one, so the launch stands alone in the transcript and in any approval that
   does reach the operator. Print the returned bg id and `claude logs <id>`,
   `claude attach <id>`, `claude stop <id>` hints. If the spawn is declined or
   fails, stop; do not watch.

5. Invoke `/claude-code-hermit:watch session <n> "<first 40 chars of the operator prompt>"`.
   That skill owns the subscription (`### Starting a session watch`) and the
   idle-notice relay (`### Handling idle notices`); do not re-implement either.
   When it declines the subscription, the helper is still running: say so, and
   give the `claude logs <id>` id as the way to check on it.

## Stuck helper

`claude logs <id>`, `claude stop <id>`, and the watch expiry notice. Never tmux.
