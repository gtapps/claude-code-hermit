# Recommended Plugins

The `/hermitd-dev:hatch` wizard offers this during setup — an official plugin from `claude-plugins-official`.

> **Note:** `/code-review` is built into Claude Code since v2.1.150. No plugin install needed — invoke it directly for PR-level review with git-blame context. Guided codebase exploration and architecture design are also native now, via the built-in `Plan`/`Explore` agents — no plugin install needed there either.

---

## context7

GitHub: [upstash/context7](https://github.com/upstash/context7)

```bash
claude plugin install context7@claude-plugins-official --scope project
```

Live documentation lookup for framework APIs. Instead of relying on training data (which may be outdated), context7 fetches current docs for libraries like React, Next.js, Django, Express, etc. Useful when the agent is working with frameworks whose API details change between versions.
