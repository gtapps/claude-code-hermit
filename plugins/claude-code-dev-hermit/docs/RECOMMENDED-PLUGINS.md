# Recommended Plugins

The `/claude-code-dev-hermit:hatch` wizard offers these during setup. All are official plugins from `claude-plugins-official` — install individually or accept them all at once.

---

## code-review

GitHub: [anthropics/code-review](https://github.com/anthropics/claude-code/tree/main/plugins/code-review)

```bash
claude plugin install code-review@claude-plugins-official --scope project
```

Official Anthropic plugin — second-pass code review for PRs and changed files. Invoke `/code-review` explicitly when the stakes warrant it: someone else's PR, security-sensitive changes, large refactors where history matters. The CLAUDE-APPEND `§Tests Before PR` rule covers the lighter-weight `/simplify` pass that runs on every commit; `/code-review` is for when you want git-blame context, prior PR comments, and inline GitHub comments.

---

## feature-dev

GitHub: [anthropics/feature-dev](https://github.com/anthropics/claude-code/tree/main/plugins/feature-dev)

```bash
claude plugin install feature-dev@claude-plugins-official --scope project
```

Official Anthropic plugin — guided feature development with codebase exploration (`code-explorer`), multi-option architecture design (`code-architect`), and quality review (`code-reviewer`). Use it when the task touches unfamiliar code paths or framework internals — features, refactors, or bugfixes alike. Skip for doc/config edits, single-line fixes, and changes you already know how to make.

`feature-dev` doesn't ship a code-writing implementer of its own — it's research and planning. Pair it with the native `Agent` tool (or your own subagent) for the actual writing. Either way, the agent reads dev-hermit's CLAUDE-APPEND rules and follows them.

---

## context7

GitHub: [upstash/context7](https://github.com/upstash/context7)

```bash
claude plugin install context7@claude-plugins-official --scope project
```

Live documentation lookup for framework APIs. Instead of relying on training data (which may be outdated), context7 fetches current docs for libraries like React, Next.js, Django, Express, etc. Useful when the agent is working with frameworks whose API details change between versions.
