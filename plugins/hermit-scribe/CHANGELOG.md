# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Added
- **`hatch` skill (first for this plugin)** — appends an Issue Filing block to the operator's `CLAUDE.md`/`CLAUDE.local.md` and seeds an `autoMode.environment` entry naming `api.github.com`, scoped to `HERMIT_GH_REPO`, as a service hermit-scribe posts to only with in-session operator confirmation. Context for Claude Code's auto-mode classifier, not a standing permission grant — filing still goes through the skill's own preview/confirm gate every time.

## [0.0.6] - 2026-07-03

### Changed

- **hermit-scribe: fold issue classifier into `file-issue.ts`** — type/scope/label derivation and the Conventional-Commits title line moved out of SKILL.md prose into a deterministic, unit-tested `classify` subcommand (emits `{type, scope, labels, title_line}`), so filing no longer relies on model-derived labels.

## [0.0.5] - 2026-06-12

### Added

- **hermit-scribe: auto-derive issue labels** — type label from proposal `category` (`bug`/`chore`/`enhancement`) and plugin-scope label when a single scope resolves, on top of the always-present `hermit-filed`.

### Changed

- **bun runtime; file-issue is TypeScript** — `file-issue.js` → `file-issue.ts` (typed ESM, run with bun; usage strings and SKILL/docs updated), tests renamed and run via `bun` (bun migration, core #18).

### Files affected

| File | Change |
|------|--------|
| `skills/hermit-scribe/file-issue.ts` | Renamed from `file-issue.js`; added auto-label logic and TypeScript types |
| `skills/hermit-scribe/SKILL.md` | Updated runtime references and label preview wording |
| `CLAUDE.md` | Updated runtime description; smoke-test uses bun |
| `README.md` | Minor cleanup |
| `tests/cli.test.ts` | Renamed from `cli.test.js`; added `buildLabels` unit tests |
| `tests/run-all.sh` | Updated to invoke bun for test runner |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the skill** — pulls the revised `SKILL.md` and `file-issue.ts` (renamed from `file-issue.js`; now runs with `bun`).

No `config.json` changes required.

---

## [0.0.4] - 2026-05-31

### Added

- **file-issue: `--comment` mode** — `node file-issue.js --comment <issue-number> <body-file>` posts a comment on an existing issue via the same App identity, prints the comment URL on success.
- **skill: comment flow** — activation patterns "add a comment to issue #NNN", "comment on #NNN", "reply to issue #NNN"; runs sanitize → operator preview → post → report URL. No dedup check, no proposal back-write.

### Files affected

| File | Change |
|------|--------|
| `skills/hermit-scribe/file-issue.js` | Added `commentMode()` and `--comment` dispatch in `main()` |
| `skills/hermit-scribe/SKILL.md` | Added comment activation patterns and How-to-comment section |
| `CLAUDE.md` | Updated file-issue.js description to mention `--comment` |
| `README.md` | Added sandbox note for custom network profiles |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the skill** — pulls the revised `SKILL.md` with the comment activation patterns and comment flow.

No `config.json` changes required.

---

## [0.0.3] - 2026-05-14

### Changed

- **Issue title format** — switches to Conventional Commits (`feat(scope):` / `fix(scope):` / `chore(scope):`) for proposal-backed issues. Type derived from `category`; scope inferred from proposal text (plugin paths or slug vocab from `config.json`). Ad-hoc issues pass the operator's title unchanged.
- **Operator preview is single-message, body-inlined** — the confirmation prompt is now the last line the operator sees, and the body is shown in full (not "see below"). If the content exceeds the channel size limit, the prompt appears only in the final split message.
- **`edit` confirmation now defined** — replies with `edit` enter a loop: skill asks what to change, applies it, re-renders the preview, and re-asks. Previously this branch was undefined.

### Added

- **English-only at the GitHub boundary** — title/body are translated to English before filing if not already English. Technical identifiers, code, frontmatter, and proper nouns are preserved verbatim. The local proposal file is untouched; the `gh_issue:` back-write into the proposal frontmatter still runs after filing.

### Files affected

| File | Change |
|------|--------|
| `skills/hermit-scribe/SKILL.md` | CC title construction, config-derived scope vocab, EN normalization, single-message preview, edit loop |
| `README.md` | Updated docs to reflect CC title format, scope inference, EN normalization, and preview changes |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the skill** — pulls the revised `SKILL.md` with the new title format and preview flow.

No `config.json` changes required.

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
