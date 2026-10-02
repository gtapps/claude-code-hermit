# Dev Hermit

A language-agnostic development safety and workflow layer. The operator can use any implementation agent; this plugin's safety contract lives in its hooks and rendered project instructions.

- `git-push-guard.ts` enforces only the strict `AGENT_HOOK_PROFILE`. Hatch defaults to strict and must never silently downgrade an existing strict installation. Keep the protected-branch and explicit-refspec distinctions in [Git safety](docs/GIT-SAFETY.md).
- `worktree-boundary-guard.ts` is independent of the profile and inert outside linked worktrees. Its live-state carve-out must not become a general escape into the main checkout.
- Execution checks use core's `state/execution.json`; commitments live in task records. Preserve the operator's own commit/test/PR sequence.

- `state-templates/CLAUDE-APPEND.md` supplies shared safety rules and resident dev-session discipline. Hatch and core evolve sync the block through `domain-hatch`.
- The complete test runner covers structural checks and `scripts/*.test.ts`.
