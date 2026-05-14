# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Changed

- **Issue title format** — uses Conventional Commits (`feat(scope): ...` / `fix(scope): ...` / `chore(scope): ...`) instead of `[hermit/{category}] ...` for proposal-backed issues. Type maps from `category`: `bug` → `fix`, `infrastructure`/`investigation` → `chore`, everything else → `feat`. Scope is inferred from explicit target mentions in the proposal text (`plugins/<slug>/` paths or recognized plugin slugs) first; the recognized slug vocabulary is derived at runtime from the keys of `_hermit_versions` in `.claude-code-hermit/config.json`, falling back to the lone activated fleet hermit when no explicit target appears. Omitted when signals are absent or ambiguous. Ad-hoc issues pass the operator's title through unchanged.
- **Operator preview is single-message, body-inlined** — the confirmation prompt is now the last line the operator sees, and the body is shown in full (not "see below"). If the content exceeds the channel size limit, the prompt appears only in the final split message.
- **`edit` confirmation now defined** — replies with `edit` enter a loop: skill asks what to change, applies it, re-renders the preview, and re-asks. Previously this branch was undefined.

### Added

- **English-only at the GitHub boundary** — title/body are translated to English before filing if not already English. Technical identifiers, code, frontmatter, and proper nouns are preserved verbatim. The local proposal file is untouched; the `gh_issue:` back-write into the proposal frontmatter still runs after filing.

---

## [0.0.2] - 2026-05-14

### Fixed

- **file-issue.js: labeled keyfile error** — `HERMIT_GH_APP_KEY_FILE` path errors now produce `HERMIT_GH_APP_KEY_FILE='<path>' does not exist (cwd=<x>) — check .env` instead of a raw `ENOENT` originating deep in the JWT signing path.

### Added

- **file-issue.js: `--check <proposal-id>` flag** — queries open `hermit-filed` issues and matches on the `proposal={id}` footer before filing. The skill calls this automatically; exits 0 + URL if a match is found, 2 if not.
- **`issue-sanitizer` agent** — sanitizes draft issue content before filing. Strips anything personal or project-specific unless it's clearly part of an upstream hermit plugin. Always strips secrets, `.env` content, connection strings, internal hostnames/IPs, and non-public URLs even when they look technical. Single `<redacted>` placeholder. Configured with `model: haiku`, `effort: low`, `maxTurns: 2`.
- **Operator preview gate** — before filing, the skill shows the sanitized title and body and asks the operator to confirm, edit, or cancel.
- **Proposal frontmatter back-write** — on success, the skill inserts `gh_issue: <url>` into the proposal's YAML frontmatter so `/proposal-list` and cortex views can link issues without re-querying GitHub.
- **Core dependency declaration** — `hermit-meta.json` and `dependencies` added to `plugin.json` so the hermit dependency resolver knows this plugin requires `claude-code-hermit ^1.0.38`.

### Files affected

| File | Change |
|------|--------|
| `skills/hermit-scribe/file-issue.js` | labeled keyfile error, `--check` flag, `loadEnv` + `getInstallToken` helpers |
| `skills/hermit-scribe/SKILL.md` | 4-step flow expanded to 7 (dedup, sanitize, preview, back-write) |
| `agents/issue-sanitizer.md` | new Haiku subagent for privacy sanitization |
| `tests/cli.test.js` | updated keyfile test + 3 new `--check` tests (13/13 pass) |
| `.claude-plugin/hermit-meta.json` | new — declares `required_core_version: >=1.0.38` |
| `.claude-plugin/plugin.json` | added `dependencies` array |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No config.json changes required.

---

## [0.0.1] - 2026-05-13

### Added

- **Initial public release.**

### Upgrade Instructions

No previous version; first install. See README for GitHub App setup prerequisites.
