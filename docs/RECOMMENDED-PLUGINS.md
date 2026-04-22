# Recommended Plugins

The `/claude-code-dev-hermit:hatch` wizard offers these during setup. All are official plugins from `claude-plugins-official` — install individually or accept them all at once.

---

## code-review

GitHub: [anthropics/code-review](https://github.com/anthropics/claude-code/tree/main/plugins/code-review)

```bash
claude plugin install code-review@claude-plugins-official --scope project
```

Official Anthropic plugin — code review for PRs and changed files.

**Optional.** `dev-quality` no longer calls this by default: `/simplify` already runs parallel reuse/quality/efficiency review agents on the changed files, which covers the quality bar for typical solo work. Install `code-review` if you want a heavier second-pass harness (git blame context, prior PR comments, inline GitHub comments) for reviewing someone else's PR, security-sensitive changes, or large refactors where history matters — then invoke `/code-review` explicitly when the stakes warrant it.

---

## feature-dev

GitHub: [anthropic/feature-dev](https://github.com/anthropics/claude-code/tree/main/plugins/feature-dev)

```bash
claude plugin install feature-dev@claude-plugins-official --scope project
```

Official Anthropic plugin - Guided feature development with codebase understanding. Useful when you want a structured approach to building a new feature — it analyzes the existing codebase, designs an architecture, and walks through implementation.

Works independently from the dev hermit workflow. Use it when you want more guidance on _what_ to build before the hermit builds it.

---

## context7

GitHub: [upstash/context7](https://github.com/upstash/context7)

```bash
claude plugin install context7@claude-plugins-official --scope project
```

Live documentation lookup for framework APIs. Instead of relying on training data (which may be outdated), context7 fetches current docs for libraries like React, Next.js, Django, Express, etc.

Useful when the implementer agent or you are working with frameworks where API details change between versions.

---

## Plugin Health Checks

When you accept plugins during `/claude-code-dev-hermit:hatch`, they're registered in `scheduled_checks` in `.claude-code-hermit/config.json`. Core's reflect and heartbeat skills periodically verify that installed plugins are still loadable:

| Plugin | Trigger | Interval |
|--------|---------|----------|
| code-review | — | not checked (optional, not in default flow) |
| feature-dev | interval | 7 days |
| context7 | — | not checked (MCP server) |

If you installed companion plugins manually (before running hatch or without it), rerun `/claude-code-dev-hermit:hatch` to register their health checks.

---

## Docker Auto-Install

Accepted plugins are also added to `docker.recommended_plugins` in `.claude-code-hermit/config.json`. The `/docker-setup` skill reads this list and includes them in the generated Docker configuration — so your always-on hermit gets the same plugins without manual setup.
