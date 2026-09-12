# Hermit Scribe

Public issue and comment filing through a configured GitHub App bot identity.

- Preserve the sequence in `skills/hermit-scribe/SKILL.md`: prepare content, run the privacy sanitizer, show the final content, obtain operator approval, then publish. A successful sanitizer pass does not authorize posting.
- `agents/issue-sanitizer.md` has no tools. Pass the actual draft text, not a file path or an identifier; it must not reconstruct private context.
- `skills/hermit-scribe/file-issue.ts` owns App authentication, classification, dedup lookup, and filing. Preserve the configured `HERMIT_GH_REPO` target and bot identity rather than substituting the maintainer's ambient `gh` login.
- Title and body are file inputs, read directly by the script. Keep shell interpolation out of their handling and retain the automatic `hermit-filed` label. Credentials and private keys stay outside the plugin tree.
- The complete test runner invokes each test file directly. Configuration and manual smoke instructions belong in [README.md](README.md).

Keep the `--publish` and `--comment` verbs aligned with the rules in `state-templates/native-permissions.json`, installed into project settings by `scripts/native-permissions.ts`.
