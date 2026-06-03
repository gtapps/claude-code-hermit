# hermit-scribe

A maintainer utility skill that files GitHub issues via a configured GitHub App bot identity. No server, no build, pure Node stdlib.

## This Repo is a Plugin

This repo is structured as a Claude Code plugin. It is NOT a standalone project; it gets installed into other projects via:

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install hermit-scribe@claude-code-hermit --scope local
```

## Plugin Structure

- `agents/issue-sanitizer.md`: subagent that sanitizes draft issue content before filing — strips anything personal or specific to the operator's machine and project unless it's clearly part of an upstream hermit plugin. Tools: none (pure text transform).
- `skills/hermit-scribe/SKILL.md`: the skill, namespaced as `/hermit-scribe:hermit-scribe`
- `skills/hermit-scribe/file-issue.js`: Node stdlib script that signs the JWT, gets an install token, and POSTs the issue. Positional args: `<title-file> <body-file> [label...]` — extra labels are appended to the always-present `hermit-filed` label and passed in the POST body. Supports `--check <proposal-id>` to query existing issues before filing, and `--comment <issue-number> <body-file>` to post a comment on an existing issue. Exports `{ buildLabels }` for unit testing.
- `.claude-plugin/plugin.json`: plugin manifest

## Required env vars

Set these in your project `.env` (loaded by Docker hermit via `env_file:`) or in `.claude/settings.local.json` `env` block for interactive sessions:

| Var | Description |
|-----|-------------|
| `HERMIT_GH_APP_ID` | GitHub App ID (shown on the App's settings page) |
| `HERMIT_GH_APP_INSTALL_ID` | Installation ID (from the App's installation page URL) |
| `HERMIT_GH_APP_KEY_FILE` | Absolute path to the `.pem` private key file |
| `HERMIT_GH_REPO` | Optional override; target `owner/repo` (default: `gtapps/claude-code-hermit`) |

Place the private key at `.claude.local/hermit-scribe-key.pem` (`.claude.local/` is gitignored).

## Manual smoke test

```bash
# Should exit non-zero with a clear error message (missing key), not a crash
HERMIT_GH_APP_ID=1 HERMIT_GH_APP_INSTALL_ID=2 HERMIT_GH_APP_KEY_FILE=/nonexistent \
  node "$CLAUDE_PLUGIN_ROOT/skills/hermit-scribe/file-issue.js" /dev/null /dev/null

# Extra label args should parse cleanly and reach token acquisition
TMP_DIR="$(mktemp -d)" && (
  trap 'rm -r "$TMP_DIR"' EXIT
  printf 't\n' > "$TMP_DIR/t" && printf 'b\n' > "$TMP_DIR/b.md" && \
  HERMIT_GH_APP_ID=1 HERMIT_GH_APP_INSTALL_ID=2 HERMIT_GH_APP_KEY_FILE=/nonexistent \
    node "$CLAUDE_PLUGIN_ROOT/skills/hermit-scribe/file-issue.js" \
    "$TMP_DIR/t" "$TMP_DIR/b.md" enhancement homeassistant-hermit
)
```

The script takes two positional file paths: title file (single line; trimmed) and body file (markdown). Both are read directly; nothing is interpolated into shell commands, so title content is safe from quoting issues.

## Development constraints

- **No npm dependencies, ever.** The script uses only Node stdlib (`crypto`, `https`, `fs`). Do not add `package.json` or `node_modules`.
- Test locally against a target project without publishing: `claude --plugin-dir /path/to/plugins/hermit-scribe`
