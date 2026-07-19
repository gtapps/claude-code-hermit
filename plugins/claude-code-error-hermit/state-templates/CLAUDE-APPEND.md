<!-- claude-code-error-hermit: Error Watch -->

## Production Error Watch

This project uses `claude-code-error-hermit` to watch a Sentry/GlitchTip project: triage new error groups against a noise ledger, correlate regressions with releases, and (in later phases) reproduce, bisect, and draft fixes on a branch.

**Scope boundary.** Reacting to a single error event is GitHub Actions territory. This hermit earns its keep on the *stateful* work: the new-vs-regression-vs-noise ledger, cursor-based watch, local repro/bisect, and draft-fix-with-failing-test.

---

### Safety rule — resolve/mute are surface-then-approve

Never resolve or mute an issue in the tracker autonomously. The write path is:

1. Surface the target issue (shortId, title, count) to the operator.
2. Wait for explicit approval.
3. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts resolve <id> --confirm` (or `mute`).

The `write-confirm-gate.ts` hook and the in-CLI `--confirm` refusal enforce this at two layers — neither is bypassable.

---

### Tools

Read commands are unrestricted:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts check                 # connectivity
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts issues --json         # list groups
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts issue <id> --json     # group detail
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts latest-event <id> --json  # stack + release
```

---

### Credentials

`ERROR_HERMIT_TOKEN` lives in the gitignored `.env` at the project root.

- **Never `cat`, `echo`, `grep`, or Read `.env`** to inspect the token — run `error-api.ts check` instead. It self-reports `ok`/`invalid`/`unreachable`/`missing` without revealing the value.
- `TOKEN` appears in the key name: the base hermit's deny-pattern hook blocks any Bash arg containing the literal string `TOKEN`.

---

### Secret hygiene

Error events and stack traces may contain request bodies, headers, and env values. This applies to **channel relay AND persistence**:

- Never paste raw event payloads into a channel message.
- Never write raw event content to `compiled/` or `raw/`.
- Scrub credential-pattern lines to `[REDACTED]` before sharing or persisting.

---

### Proposal categories

| Prefix | Meaning |
|---|---|
| `[regression]` | error group correlated with a recent release |
| `[noise]` | recurring known-noise pattern worth muting or ledgering |
| `[reliability]` | systemic failure pattern across error groups |

---

<!-- /claude-code-error-hermit: Error Watch -->
