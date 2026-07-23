# Changelog

## [0.1.0] - 2026-07-06

### Added
- First `hatch` skill appends an Issue Filing block to `CLAUDE.md` or `CLAUDE.local.md` and scopes `api.github.com` to `HERMIT_GH_REPO` in `autoMode.environment`.
  Filing still requires the skill's in-session preview and confirmation gate.

## [0.0.6] - 2026-07-03

### Changed

- Issue type, scope, labels, and Conventional Commits title derivation now run through the deterministic, unit-tested `file-issue.ts classify` subcommand instead of `SKILL.md` prose.

## [0.0.5] - 2026-06-12

### Added

- Issue labels now derive from proposal `category` (`bug`, `chore`, or `enhancement`) and a resolved single-plugin scope, alongside the existing `hermit-filed` label.

### Changed

- `file-issue.js` became typed ESM in `file-issue.ts`, run with Bun; related usage, skill, documentation, and test references now use Bun.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the skill** — pulls the revised `SKILL.md` and `file-issue.ts` (renamed from `file-issue.js`; now runs with `bun`).

No `config.json` changes required.

---

## [0.0.4] - 2026-05-31

### Added

- `node file-issue.js --comment <issue-number> <body-file>` posts through the same App identity and prints the comment URL on success.
- Comment requests now sanitize content, show an operator preview, post, and report the URL; they skip deduplication and proposal back-writes.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the skill** — pulls the revised `SKILL.md` with the comment activation patterns and comment flow.

No `config.json` changes required.

---

## [0.0.3] - 2026-05-14

### Changed

- Proposal-backed issues now use Conventional Commits titles (`feat(scope):`, `fix(scope):`, or `chore(scope):`) derived from `category` and inferred scope; ad-hoc titles remain unchanged.
- Operator previews now inline the full body and end with the confirmation prompt, including when content requires split messages.
- `edit` confirmations now enter a loop that applies requested changes, re-renders the preview, and asks again.

### Added

- Issue titles and bodies are translated to English before filing while preserving technical identifiers, code, frontmatter, and proper nouns; local proposals remain untouched.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the skill** — pulls the revised `SKILL.md` with the new title format and preview flow.

No `config.json` changes required.

---

## [0.0.2] - 2026-05-14

### Fixed

- Invalid `HERMIT_GH_APP_KEY_FILE` paths now produce a labeled, actionable error instead of a raw JWT-signing `ENOENT`.

### Added

- `file-issue.js --check <proposal-id>` now finds open `hermit-filed` issues by their `proposal={id}` footer before filing, returning `0` and a URL when found or `2` otherwise.
- The `issue-sanitizer` agent now redacts personal and project-specific content, secrets, `.env` data, connection strings, internal hosts, and private URLs before filing, using `haiku` with low effort and two turns.
- Filing now shows the sanitized title and body for the operator to confirm, edit, or cancel.
- Successful filings now write `gh_issue: <url>` into proposal frontmatter for `/proposal-list` and cortex views.
- `hermit-meta.json` and `plugin.json` now declare the required `claude-code-hermit ^1.0.38` core dependency.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No config.json changes required.

---

## [0.0.1] - 2026-05-13

### Added

- Initial public release.

### Upgrade Instructions

No previous version; first install. See README for GitHub App setup prerequisites.
