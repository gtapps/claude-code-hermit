---
name: forge-sites
description: List and inspect sites on Laravel Forge servers. Triggers on "list sites", "show site", "site detail", "what sites are on server X".
---

# Forge Sites

List sites on a server or inspect a specific site.

## List sites on a server

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php sites <server>
```

`<server>` can be a server name, IP address, or numeric ID.

## Show site detail

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php site <server> <site>
```

`<site>` can be a site name, URL hostname, or numeric ID. Returns the canonical site record as JSON, including ID, name, status, and repository info.

## Notes

- Ambiguous names (multiple matches on the same server) are rejected with a list of candidates.
- For deployment history or triggering deploys, use `/laravel-forge-hermit:forge-deploy`.
- For reading site or deployment logs, use `/laravel-forge-hermit:forge-logs`.
