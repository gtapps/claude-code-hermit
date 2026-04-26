# claude-code-hermit (monorepo)

This repository hosts the **hermit fleet** — autonomous personal assistants that live inside Claude Code projects.

```
claude plugin marketplace add gtapps/claude-code-hermit
```

Then install whichever plugins you want:

```
claude plugin install claude-code-hermit@claude-code-hermit          # core
claude plugin install claude-code-dev-hermit@claude-code-hermit      # dev hermit (depends on core)
claude plugin install claude-code-homeassistant-hermit@claude-code-hermit  # HA hermit (depends on core)
```

## Plugins in this fleet

| Plugin | Path | Purpose |
|---|---|---|
| `claude-code-hermit` | [`plugins/claude-code-hermit/`](plugins/claude-code-hermit/README.md) | Core runtime — memory, rhythm, idle agency, session hygiene |
| `claude-code-dev-hermit` | [`plugins/claude-code-dev-hermit/`](plugins/claude-code-dev-hermit/README.md) | Git safety + dev workflow conventions |
| `claude-code-homeassistant-hermit` | [`plugins/claude-code-homeassistant-hermit/`](plugins/claude-code-homeassistant-hermit/README.md) | Home Assistant integration |

Each plugin's own README is the canonical entry point for its features, configuration, and operator guidance.

## A note on naming

The repo, the marketplace, and the core plugin all happen to share the name `claude-code-hermit`. Claude Code treats them as three distinct identifiers — there is no conflict. The convention mirrors `anthropics/claude-code` containing the `claude-code-plugins` marketplace.

## Layout

```
claude-code-hermit/
├── .claude-plugin/marketplace.json      # fleet catalog
├── plugins/
│   ├── claude-code-hermit/              # core
│   ├── claude-code-dev-hermit/          # dev
│   └── claude-code-homeassistant-hermit/ # HA
├── LICENSE
└── README.md                            # this file
```

Domain hermits depend on core via the `required_core_version` field in their `plugin.json`, which the core hermit's preflight checks at runtime.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Each plugin in the fleet is independently versioned; releases are scoped to one plugin at a time.
