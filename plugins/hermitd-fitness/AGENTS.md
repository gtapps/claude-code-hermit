# Fitness Hermit

A Strava-backed training layer whose contracts are activity identity, bounded collection, and delivery-linked feedback.

- Keep the MCP server key `strava` and the `mcp__strava__*` namespace aligned with skill references and `state-templates/native-permissions.json`. Workflows check connectivity first. Preserve native approval for the write-class tools (`star-segment`, `connect-strava`, `disconnect-strava`).
- `agents/strava-data-cruncher.md` owns the bulk-collection contract, including its API-call cap. Reuse athlete-provided HR zones and explicit stream keys; do not hardcode zones or copy external rate-limit numbers into instructions.
- `fitness-brief` writes `state/strava-pending-rpe.json` only after confirmed channel delivery. Push fallback or log-only output must not bind an activity to a reply. Capture rechecks allowed users, enforces the 24-hour window, and consumes the pending record once. `state/activity-notes.json` is durable and keyed by Strava activity ID.
- Routines invoke domain skills directly through `config.json.routines[].skill`; keep the registered skill names and arguments aligned with `skills/`.
- `docs/knowledge-schema.md` owns artifact locations, retention, and the RPE record shapes. Preserve the distinction between ephemeral pulls, durable coaching outputs, and machine state. Persona and delivery identity come from the consumer's config.

Read [the knowledge schema](docs/knowledge-schema.md) when changing activity sync, feedback, or routine outputs.
