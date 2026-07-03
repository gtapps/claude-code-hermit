# claude-code-error-hermit

A production-error watcher for [Sentry](https://sentry.io) and [GlitchTip](https://glitchtip.com), built on `claude-code-hermit`. It watches a project's error stream, classifies new groups against a known-noise ledger, correlates regressions with your releases, and — in later phases — reproduces the failure locally, bisects it against recent commits, and drafts a fix on a branch with the failing case as a test.

> **What this is not.** Reacting to a single error event — "an error fired, open an issue, run a workflow" — is [GitHub Actions](https://docs.github.com/actions) territory, and a Sentry-webhook → GitHub-issue → Actions pipeline does it well. This plugin deliberately concedes that half. It earns its place on the *stateful* work no cloud pipeline holds at once: the new-vs-regression-vs-noise ledger that remembers across weeks, a repo checkout for local repro and bisect, and a draft fix with a reproducing test — reachable from your phone via the hermit's approval channel.

## Requirements

- `claude-code-hermit` ≥ 1.2.14, installed and hatched in the project.
- A Sentry or GlitchTip auth token. GlitchTip works because it implements the Sentry `/api/0/` API; one client covers both.
- **Run it inside the repo of the application you are watching.** Phases 3–4 (repro, bisect, draft fix) operate on that repo's own git history; if the tracker project doesn't map to the current repo, those skills stop and say so.

## Install

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-error-hermit@claude-code-hermit --scope local
```

Then, in the target project:

```
/claude-code-error-hermit:hatch
```

Hatch prompts for credentials, verifies them with a live connectivity check, injects the Error Watch block into your `CLAUDE.md`, and stamps `config.json`.

## Configuration

Four values in a gitignored `.env` at the project root (copy `.env.example`):

| Variable | Meaning |
|---|---|
| `ERROR_HERMIT_TOKEN` | Sentry/GlitchTip auth token (`project:read`, `event:read`, `org:read`; `project:write` for approved resolve/mute) |
| `ERROR_HERMIT_BASE_URL` | `https://sentry.io` or your GlitchTip URL (no trailing slash) |
| `ERROR_HERMIT_ORG` | organization slug |
| `ERROR_HERMIT_PROJECT` | project slug |

## Safety

- **resolve / mute are approval-gated.** The hermit surfaces the target issue and waits for your explicit approval; the tracker is only mutated on a `--confirm` command, enforced by both an in-CLI refusal and a PreToolUse hook.
- **The hermit never pushes.** Draft fixes (Phase 3) stop at a local branch and hand off to `/claude-code-dev-hermit:dev-pr` for the sanctioned push.
- **Secrets stay out.** The token is never printed, and event payloads are scrubbed before any channel relay or file write.

## Roadmap

| Phase | Ships | Status |
|---|---|---|
| 1 | Scaffold, hatch, API client (`check` / `issues` / `issue` / `latest-event` / `resolve` / `mute`) | this release (0.0.1) |
| 2 | Watch loop: zero-cost precheck + `error-triage` skill + noise ledger | planned |
| 3 | `error-reproduce` (worktree + failing test + bisect) + `error-draft-fix` | planned |
| 4 | `error-incident-summary` + overnight `error-digest` | planned |

## GlitchTip note

GlitchTip implements a subset of the Sentry API. This plugin sticks to the core endpoints both support, and `hatch`'s live `check` probes both the org endpoint and the issues query path so a compatibility gap surfaces at setup rather than mid-watch.
