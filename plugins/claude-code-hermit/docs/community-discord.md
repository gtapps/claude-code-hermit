# Community Discord

Use this checklist to launch the public `claude-code-hermit` dev-community
space. This is for humans discussing the plugin, not the per-project Discord
channel that a hermit uses for operator DMs.

Live invite: <https://discord.gg/54sJqAxhUh>

## Recommended Shape

Start with one public forum channel if the Discord server supports forums:

- **Name:** `claude-code-hermit`
- **Topic:** `Dev community for claude-code-hermit: install help, always-on ops, plugin authoring, bug triage, and proposal/design discussion. Do not post secrets, tokens, or private logs.`
- **Forum tags:** `install-help`, `always-on`, `docker`, `plugin-dev`, `bug`, `proposal`, `showcase`

If forums are unavailable, create one text channel named
`#claude-code-hermit` and enable public threads. Keep the same topic and ask
members to open a thread per install issue or design question.

## Channel Settings

Recommended permissions for `@everyone`:

- View Channel: allowed
- Send Messages / Create Public Threads: allowed after server membership
  screening
- Embed Links / Attach Files: allowed
- Mention `@everyone`, `@here`, and roles: denied
- Manage Messages / Manage Threads / Manage Webhooks: denied

Recommended maintainer permissions:

- Manage Messages and Threads
- Pin Messages
- Use private maintainer thread or channel for moderation notes

## Pinned Starter Message

```text
Welcome to the claude-code-hermit dev channel.

Use this space for install help, always-on setup, plugin development, proposal
feedback, and showing what your hermit is doing.

For help, include:
- OS and runtime mode: Docker, tmux, or interactive
- Claude Code version
- claude-code-hermit version
- Command or skill you ran
- Sanitized error output

Do not post API keys, Discord/Telegram tokens, private repo URLs, `.env`
contents, or raw logs that contain secrets. For security reports, use the
repository security guidance instead of public Discord.
```

## Starter Threads

Create these initial threads or forum posts:

- `Read this first` — link to the README, Getting Started, FAQ, and Security
  docs.
- `Install help` — pinned template for OS, Claude Code version, plugin version,
  command, and sanitized error.
- `Always-on setups` — Docker/tmux operational questions and examples.
- `Plugin development` — domain hermits, skills, agents, hooks, and marketplace
  packaging.
- `Proposals and roadmap` — design discussion before opening a GitHub issue or
  PR.
- `Show your hermit` — examples, screenshots, and working patterns.

## Invite Publishing Checklist

After the Discord channel exists:

1. Create a non-expiring invite scoped to the channel or server.
2. Capture the invite URL and server ID.
3. Add a Discord badge/link to the root README and plugin README badge rows.
4. Add the invite link near the Quick Start or Documentation section.
5. If GitHub Discussions or Issues remain the canonical support path, say so
   next to the Discord link.
6. Do not publish the invite until moderation roles, membership screening, and
   the pinned starter message are in place.

Badge snippet:

```html
<a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join%20community-5865F2?logo=discord&logoColor=white" alt="Join the Discord community" /></a>
```

## Moderation Notes

- Remove secrets immediately and ask the poster to rotate them.
- Move reproducible bugs to GitHub Issues once the report has enough detail.
- Keep roadmap decisions in GitHub issues or PRs after discussion, so they are
  searchable and reviewable.
- Keep support answers short and link back to docs where possible. If the same
  question repeats, update the FAQ.
