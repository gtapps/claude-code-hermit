<?php
declare(strict_types=1);

// ---------------------------------------------------------------------------
// Shared pure helpers + constants for forge.php and its test harness.
//
// No I/O, no SDK calls — safe to `require` from both the CLI dispatch script
// and php/tests/run.php. Keeping these in one place means the tests exercise
// the SAME matchers and allowlist the CLI ships, not a drifting copy.
// ---------------------------------------------------------------------------

// Read-only allowlist: closed, authoritative set of SDK read methods.
// Generic dispatch via `call <method>` only resolves names in this set.
// Every name here is a real method on Laravel\Forge\Forge v4 (verified against
// the SDK source) — `call` also guards with method_exists as a backstop.
const READ_ALLOWLIST = [
    // servers
    'servers', 'archivedServers', 'server', 'serverEvents',
    // sites (org-scoped only — the global cross-org sites() is intentionally omitted)
    'organizationSites', 'serverSites',
    // deployments + logs
    'deployments', 'deployment', 'deploymentLog', 'serverLog',
    // databases
    'databases', 'database', 'databaseUsers',
    // firewall
    'firewallRules', 'firewallRule',
    // nginx / php
    'nginxTemplates', 'nginxTemplate', 'phpVersions',
    // redirects / security
    'redirectRules', 'securityRules',
    // ssh keys
    'sshKeys', 'sshKey',
    // scheduled jobs
    'scheduledJobs', 'siteScheduledJobs',
    // domains / certificates
    'domains', 'domainCertificates', 'certificate',
    // backups
    'backups', 'backup', 'backupConfigurations',
    // monitoring
    'monitors', 'webhooks', 'backgroundProcesses', 'commands',
    // org
    'organizations',
];

// Raw transports — blocked even if somehow allowlisted (defense-in-depth).
const RAW_TRANSPORTS = ['get', 'post', 'put', 'patch', 'delete', 'request', 'retry'];

// Allowlisted read methods that take NO org slug (so `call` must not prepend one).
const NO_ORG_METHODS = ['organizations'];

// ---------------------------------------------------------------------------
// Deployment status enums.
// Terminal states are authoritative (the watch grep keys off these). The
// in-progress set is documentation only — anything not terminal is treated as
// still-running, which keeps the watch robust to undocumented states (e.g.
// 'running', seen in the SDK docs but absent from the OpenAPI enum).
// ---------------------------------------------------------------------------
const STATUS_SUCCESS     = ['finished'];
const STATUS_FAILURE     = ['failed', 'failed-build', 'cancelled'];
const STATUS_IN_PROGRESS = ['pending', 'queued', 'running', 'deploying'];

// ---------------------------------------------------------------------------
// Matchers — resolve a user-supplied query to candidate server/site records.
// Inputs are plain arrays; callers materialize the SDK's CursorPaginator with
// iterator_to_array($paginator->lazy()) before calling these.
// ---------------------------------------------------------------------------
function matchServer(array $servers, string $query): array {
    if (is_numeric($query)) {
        // No fallthrough to name/IP matching for numeric queries (F4).
        return array_values(array_filter($servers, fn($s) => (string)$s->id === $query));
    }
    return array_values(array_filter($servers, function($s) use ($query) {
        return strcasecmp($s->name, $query) === 0 || ($s->ipAddress ?? '') === $query;
    }));
}

function matchSite(array $sites, string $query): array {
    if (is_numeric($query)) {
        return array_values(array_filter($sites, fn($s) => (string)$s->id === $query));
    }
    $queryHost = strtolower(parse_url($query, PHP_URL_HOST) ?: $query);
    return array_values(array_filter($sites, function($s) use ($query, $queryHost) {
        if (strcasecmp($s->name, $query) === 0) return true;
        $siteHost = strtolower(parse_url('https://' . $s->name, PHP_URL_HOST) ?: $s->name);
        if ($siteHost === $queryHost) return true;
        if (isset($s->aliases) && is_array($s->aliases)) {
            foreach ($s->aliases as $alias) {
                if (strcasecmp($alias, $query) === 0) return true;
            }
        }
        return false;
    }));
}
