---
title: "Acknowledged Safety Violations"
description: "Per-automation safety carve-outs. Audit reads refs=[...] per bullet; drift outside that set re-surfaces as a finding."
type: acknowledged-violations
created: 2026-05-11T00:00:00+00:00
tags: [foundational, ha-safety, acknowledged]
automation_ids: []
---

## Rationale

(One bullet per acknowledged automation. Format:

`- \`<automation_id>\`: refs=[<entity_id_or_service>, ...]; <rationale text>`

The `refs=[...]` clause lists the sensitive entities/services this acknowledgment covers. If the automation later drifts to touch a NEW sensitive ref outside this list, the audit re-surfaces it as a finding.

An id listed in frontmatter `automation_ids` but missing a body bullet here is effectively inert: empty refs cannot cover any sensitive violation, so the audit will still flag it.)

This file does not bypass any runtime gate. `ha-apply-change` and the MCP safety hook still enforce `ha_safety_mode` exactly as configured. The file only quiets the weekly audit ledger for items the operator has consciously decided to keep.
