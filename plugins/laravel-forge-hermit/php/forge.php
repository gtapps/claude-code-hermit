#!/usr/bin/env php
<?php
declare(strict_types=1);

// ---------------------------------------------------------------------------
// Bootstrap: project root resolution (port of HA's projectRoot())
// ---------------------------------------------------------------------------
function projectRoot(): string {
    $proj = getenv('CLAUDE_PROJECT_DIR');
    if ($proj !== false && file_exists($proj . '/.claude-code-hermit')) {
        return $proj;
    }
    $dir = getcwd();
    for ($i = 0; $i < 8; $i++) {
        if (file_exists($dir . '/.claude-code-hermit/config.json')) {
            return $dir;
        }
        $parent = dirname($dir);
        if ($parent === $dir) break;
        $dir = $parent;
    }
    return getcwd();
}

// ---------------------------------------------------------------------------
// Autoload: project space (prod, hatch-installed) → local dev fallback
// ---------------------------------------------------------------------------
$projectRoot = projectRoot();
$prodAutoload = $projectRoot . '/.claude-code-hermit/forge-runtime/vendor/autoload.php';
$devAutoload  = __DIR__ . '/vendor/autoload.php';

if (file_exists($prodAutoload)) {
    require_once $prodAutoload;
} elseif (file_exists($devAutoload)) {
    require_once $devAutoload;
} else {
    fwrite(STDERR, "Forge SDK not installed. Run /laravel-forge-hermit:hatch to install it.\n");
    exit(1);
}

use Laravel\Forge\Forge;

// ---------------------------------------------------------------------------
// .env loader (project root only; getenv() takes precedence)
// ---------------------------------------------------------------------------
function loadEnv(string $root): void {
    $file = $root . '/.env';
    if (!file_exists($file)) return;
    $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        if (str_starts_with(trim($line), '#')) continue;
        if (!str_contains($line, '=')) continue;
        [$key, $val] = explode('=', $line, 2);
        $key = trim($key);
        $val = trim($val, " \t\"'");
        if ($key !== '' && getenv($key) === false) {
            putenv("$key=$val");
        }
    }
}

loadEnv($projectRoot);

// ---------------------------------------------------------------------------
// Token + org resolution
// ---------------------------------------------------------------------------
$token = getenv('FORGE_API_TOKEN') ?: '';
$org   = getenv('FORGE_ORG') ?: '';

// ---------------------------------------------------------------------------
// Shared helpers + constants — one file so the tests exercise the same code
// the CLI ships (see forge-lib.php).
// ---------------------------------------------------------------------------
require_once __DIR__ . '/forge-lib.php';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function check(bool $cond, string $msg): void {
    if (!$cond) {
        fwrite(STDERR, "Error: $msg\n");
        exit(1);
    }
}

function requireToken(string $token): void {
    check($token !== '', "FORGE_API_TOKEN is not set. Add it to .env in the project root.");
}

function requireOrg(string $org, Forge $forge): string {
    if ($org !== '') return $org;
    // Attempt to discover org from the API — only valid if there is exactly one.
    // organizations() is a CursorPaginator; materialize all pages so count()
    // reflects the true total, not just page 1.
    try {
        $orgs = iterator_to_array($forge->organizations()->lazy());
    } catch (\Throwable $e) {
        fwrite(STDERR, "Could not list organizations: " . $e->getMessage() . "\n");
        fwrite(STDERR, "Set FORGE_ORG in .env to specify your organization slug.\n");
        exit(1);
    }
    $count = count($orgs);
    if ($count === 1) return $orgs[0]->slug;
    if ($count === 0) {
        fwrite(STDERR, "No organizations found for this token. Check the token at https://forge.laravel.com/profile/api.\n");
        exit(1);
    }
    fwrite(STDERR, "Multiple organizations found. Set FORGE_ORG in .env to one of:\n");
    foreach ($orgs as $o) {
        fwrite(STDERR, "  {$o->slug}  ({$o->name})\n");
    }
    exit(1);
}

function resolveServer(Forge $forge, string $org, string $serverQuery): object {
    // servers() returns a CursorPaginator — materialize all pages to a plain
    // array so name/IP resolution sees the full estate, not just page 1.
    $servers = iterator_to_array($forge->servers($org)->lazy());
    $candidates = matchServer($servers, $serverQuery);
    if (count($candidates) === 0) {
        fwrite(STDERR, "No server matching '$serverQuery'. Available servers:\n");
        foreach ($servers as $s) {
            fwrite(STDERR, "  {$s->id}  {$s->name}  ({$s->ipAddress})\n");
        }
        exit(1);
    }
    if (count($candidates) > 1) {
        fwrite(STDERR, "Ambiguous server '$serverQuery' — multiple matches:\n");
        foreach ($candidates as $s) {
            fwrite(STDERR, "  {$s->id}  {$s->name}  ({$s->ipAddress})\n");
        }
        exit(1);
    }
    return $candidates[0];
}

function resolveSite(Forge $forge, string $org, object $server, string $siteQuery): object {
    // serverSites() returns a CursorPaginator — materialize all pages first.
    $sites = iterator_to_array($forge->serverSites($org, $server->id)->lazy());
    $candidates = matchSite($sites, $siteQuery);
    if (count($candidates) === 0) {
        fwrite(STDERR, "No site matching '$siteQuery' on server {$server->name}. Available sites:\n");
        foreach ($sites as $s) {
            fwrite(STDERR, "  {$s->id}  {$s->name}\n");
        }
        exit(1);
    }
    if (count($candidates) > 1) {
        fwrite(STDERR, "Ambiguous site '$siteQuery' on server {$server->name} — multiple matches:\n");
        foreach ($candidates as $s) {
            fwrite(STDERR, "  {$s->id}  {$s->name}\n");
        }
        exit(1);
    }
    return $candidates[0];
}

function printCanonicalServer(object $server): void {
    echo "Server: {$server->name} (ID: {$server->id}, IP: {$server->ipAddress})\n";
}

function printCanonicalSite(object $server, object $site): void {
    echo "Server: {$server->name} (ID: {$server->id}, IP: {$server->ipAddress})\n";
    echo "Site:   {$site->name} (ID: {$site->id})\n";
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
$args = array_slice($argv, 1);
$cmd  = array_shift($args) ?? '';

$hasConfirm = in_array('--confirm', $args, true);
$hasJson    = in_array('--json',    $args, true);

$positional = array_values(array_filter($args, fn($a) => !str_starts_with($a, '--')));

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
if ($cmd === '' || $cmd === '--help' || $cmd === 'help') {
    echo <<<USAGE
    Usage: forge.php <command> [args] [--confirm] [--json]

    Credential:
      check                       Report token status (missing/invalid/unreachable/ok)

    Read commands:
      servers                     List all servers
      server <server>             Show server detail
      sites <server>              List sites on a server
      site <server> <site>        Show site detail
      logs <server> <site>        Show latest deployment log for a site
      server-log <server> <key>   Read a server log by key (keys are hyphenated: nginx-error, nginx-access)
      deploy-history <server> <site>          List recent deployments
      deploy-log <server> <site> <deploy-id>  Fetch a specific deployment log
      deploy-status <server-id> <site-id> <deploy-id>  Print a deployment's status (raw IDs)

    Preview commands (read-only, never mutate):
      preview-deploy <server> <site>  Show canonical target before deploying
      preview-reboot <server>         Show canonical target before rebooting

    Write commands (require --confirm):
      deploy <server> <site>      Trigger deployment (fire-and-return; watch via deploy-status)
      server-reboot <server>      Reboot server

    Estate scan:
      failed-deploys [--json]     Find sites with a failed latest deployment

    Generic read dispatch (JSON args on stdin):
      call <sdk-method>           Call any allowlisted read SDK method

    USAGE;
    exit(1);
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
if ($cmd === 'check') {
    if ($token === '') {
        echo "missing\n";
        exit(0);
    }
    try {
        $forge = new Forge($token);
        $forge->organizations();
        echo "ok\n";
    } catch (\Throwable $e) {
        $msg = $e->getMessage();
        if (str_contains($msg, '401') || str_contains($msg, 'Unauthorized') || str_contains($msg, 'unauthenticated')) {
            echo "invalid\n";
        } else {
            echo "unreachable\n"; // network/egress error, not an auth rejection
        }
    }
    exit(0);
}

// All other commands require a valid token.
requireToken($token);
$forge = new Forge($token);
$org   = requireOrg($org, $forge);

// ---------------------------------------------------------------------------
// call <method>  (read-only generic dispatch)
// ---------------------------------------------------------------------------
if ($cmd === 'call') {
    $method = $positional[0] ?? '';
    check($method !== '', "call requires a method name. Usage: forge.php call <method>");

    // Allowlist gate (authoritative — closed set)
    if (!in_array($method, READ_ALLOWLIST, true)) {
        fwrite(STDERR, "Method '$method' is not on the read allowlist.\n");
        fwrite(STDERR, "Allowed methods: " . implode(', ', READ_ALLOWLIST) . "\n");
        exit(1);
    }
    // Defense-in-depth: also block raw transports
    if (in_array(strtolower($method), RAW_TRANSPORTS, true)) {
        fwrite(STDERR, "Raw transport '$method' is blocked.\n");
        exit(1);
    }

    check(method_exists($forge, $method), "Method '$method' does not exist on the Forge SDK.");

    $stdin = stream_get_contents(STDIN);
    $jsonArgs = ($stdin !== false && $stdin !== '') ? json_decode(trim($stdin), true) : [];
    if (!is_array($jsonArgs)) {
        // Catches both decode failure (null) and valid-but-non-array JSON
        // (a bare string/number would crash the ...spread below).
        fwrite(STDERR, "stdin must be a JSON array of arguments (e.g. '[\"server-id\"]').\n");
        exit(1);
    }
    // Prepend org slug as first argument — most SDK v4 read methods take it
    // first, but a few global ones (organizations, regions) take no org.
    if (!in_array($method, NO_ORG_METHODS, true)) {
        array_unshift($jsonArgs, $org);
    }

    try {
        $result = $forge->$method(...$jsonArgs);
        if (is_iterable($result)) {
            $rows = [];
            foreach ($result as $item) {
                $rows[] = method_exists($item, 'toArray') ? $item->toArray() : (array)$item;
            }
            echo json_encode($rows, JSON_PRETTY_PRINT) . "\n";
        } elseif (is_object($result)) {
            echo json_encode(method_exists($result, 'toArray') ? $result->toArray() : (array)$result, JSON_PRETTY_PRINT) . "\n";
        } else {
            echo json_encode($result, JSON_PRETTY_PRINT) . "\n";
        }
    } catch (\Throwable $e) {
        fwrite(STDERR, "SDK error: " . $e->getMessage() . "\n");
        exit(1);
    }
    exit(0);
}

// ---------------------------------------------------------------------------
// servers
// ---------------------------------------------------------------------------
if ($cmd === 'servers') {
    foreach ($forge->servers($org)->lazy() as $s) {
        printf("%-6s  %-30s  %s\n", $s->id, $s->name, $s->ipAddress);
    }
    exit(0);
}

// ---------------------------------------------------------------------------
// server <id>
// ---------------------------------------------------------------------------
if ($cmd === 'server') {
    check(isset($positional[0]), "Usage: forge.php server <server>");
    $server = resolveServer($forge, $org, $positional[0]);
    echo json_encode((array)$server, JSON_PRETTY_PRINT) . "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// sites <server>
// ---------------------------------------------------------------------------
if ($cmd === 'sites') {
    check(isset($positional[0]), "Usage: forge.php sites <server>");
    $server = resolveServer($forge, $org, $positional[0]);
    foreach ($forge->serverSites($org, $server->id)->lazy() as $s) {
        printf("%-6s  %s\n", $s->id, $s->name);
    }
    exit(0);
}

// ---------------------------------------------------------------------------
// site <server> <site>
// ---------------------------------------------------------------------------
if ($cmd === 'site') {
    check(isset($positional[1]), "Usage: forge.php site <server> <site>");
    $server = resolveServer($forge, $org, $positional[0]);
    $site   = resolveSite($forge, $org, $server, $positional[1]);
    echo json_encode((array)$site, JSON_PRETTY_PRINT) . "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// logs <server> <site> [--log-type deploy|site]
// ---------------------------------------------------------------------------
if ($cmd === 'logs') {
    check(isset($positional[1]), "Usage: forge.php logs <server> <site>");
    $server = resolveServer($forge, $org, $positional[0]);
    $site   = resolveSite($forge, $org, $server, $positional[1]);

    // Get the latest deployment and fetch its log.
    $deployments = $forge->deployments($org, $server->id, $site->id);
    $latest = null;
    foreach ($deployments as $d) { $latest = $d; break; }

    if ($latest === null) {
        echo "(no deployments found)\n";
        exit(0);
    }
    $log = $forge->deploymentLog($org, $server->id, $site->id, $latest->id);
    echo $log . "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// server-log <server> <key>
// ---------------------------------------------------------------------------
if ($cmd === 'server-log') {
    check(isset($positional[1]), "Usage: forge.php server-log <server> <key>");
    $server = resolveServer($forge, $org, $positional[0]);
    $log    = $forge->serverLog($org, $server->id, $positional[1]);
    echo $log . "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// deploy-history <server> <site>
// ---------------------------------------------------------------------------
if ($cmd === 'deploy-history') {
    check(isset($positional[1]), "Usage: forge.php deploy-history <server> <site>");
    $server      = resolveServer($forge, $org, $positional[0]);
    $site        = resolveSite($forge, $org, $server, $positional[1]);
    $deployments = $forge->deployments($org, $server->id, $site->id);
    foreach ($deployments as $d) {
        $commitMsg = $d->commit->message ?? '(no commit)';
        $short     = substr($commitMsg, 0, 60);
        printf("%-8s  %-12s  %s\n", $d->id, $d->status, $short);
    }
    exit(0);
}

// ---------------------------------------------------------------------------
// deploy-log <server> <site> <deploy-id>
// ---------------------------------------------------------------------------
if ($cmd === 'deploy-log') {
    check(isset($positional[2]), "Usage: forge.php deploy-log <server> <site> <deploy-id>");
    $server   = resolveServer($forge, $org, $positional[0]);
    $site     = resolveSite($forge, $org, $server, $positional[1]);
    $deployId = (int)$positional[2];   // SDK param is int; argv gives a string under strict_types
    $log      = $forge->deploymentLog($org, $server->id, $site->id, $deployId);
    echo $log . "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// preview-deploy <server> <site>  (read-only, no hook gate needed)
// ---------------------------------------------------------------------------
if ($cmd === 'preview-deploy') {
    check(isset($positional[1]), "Usage: forge.php preview-deploy <server> <site>");
    $server = resolveServer($forge, $org, $positional[0]);
    $site   = resolveSite($forge, $org, $server, $positional[1]);
    echo "--- Deploy preview (no action taken) ---\n";
    printCanonicalSite($server, $site);
    echo "Run: forge.php deploy {$positional[0]} {$positional[1]} --confirm\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// preview-reboot <server>  (read-only)
// ---------------------------------------------------------------------------
if ($cmd === 'preview-reboot') {
    check(isset($positional[0]), "Usage: forge.php preview-reboot <server>");
    $server = resolveServer($forge, $org, $positional[0]);
    echo "--- Reboot preview (no action taken) ---\n";
    printCanonicalServer($server);
    echo "Run: forge.php server-reboot {$positional[0]} --confirm\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// deploy <server> <site> --confirm   (fire-and-return)
//
// Triggers the deployment and returns immediately with the canonical IDs.
// Watching is decoupled: the forge-deploy skill arms a CC Monitor that polls
// `deploy-status` until terminal, so a long deploy never blocks a foreground
// Bash call (which the tool would kill at its timeout).
// ---------------------------------------------------------------------------
if ($cmd === 'deploy') {
    check(isset($positional[1]), "Usage: forge.php deploy <server> <site> --confirm");
    if (!$hasConfirm) {
        fwrite(STDERR, "deploy requires --confirm. Run preview-deploy first to review the target.\n");
        exit(1);
    }
    $server = resolveServer($forge, $org, $positional[0]);
    $site   = resolveSite($forge, $org, $server, $positional[1]);

    $deployment = $forge->createDeployment($org, $server->id, $site->id, []);
    echo "Deployment started: deploy-id={$deployment->id} server-id={$server->id} site-id={$site->id} status={$deployment->status}\n";
    echo "Watch with: forge.php deploy-status {$server->id} {$site->id} {$deployment->id}\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// deploy-status <server-id> <site-id> <deploy-id>
//
// Prints just the deployment status string. Takes raw numeric IDs (no
// name/IP resolution), so it is a single API call per invocation — cheap
// enough for a Monitor poll loop to call every few seconds.
// ---------------------------------------------------------------------------
if ($cmd === 'deploy-status') {
    check(isset($positional[2]), "Usage: forge.php deploy-status <server-id> <site-id> <deploy-id>");
    [$serverId, $siteId, $deployId] = $positional;
    try {
        // SDK params are int; argv gives strings and forge.php is strict_types=1.
        $d = $forge->deployment($org, (int)$serverId, (int)$siteId, (int)$deployId);
    } catch (\Throwable $e) {
        fwrite(STDERR, "Status error: " . $e->getMessage() . "\n");
        exit(1);
    }
    echo ($d->status ?? 'unknown') . "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// server-reboot <server> [--confirm]
// ---------------------------------------------------------------------------
if ($cmd === 'server-reboot') {
    check(isset($positional[0]), "Usage: forge.php server-reboot <server> [--confirm]");
    if (!$hasConfirm) {
        fwrite(STDERR, "server-reboot requires --confirm. Run preview-reboot first to review the target.\n");
        exit(1);
    }
    $server = resolveServer($forge, $org, $positional[0]);
    $forge->createServerAction($org, $server->id, ['action' => 'reboot']);
    echo "Reboot initiated for server {$server->name} (ID: {$server->id}).\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// failed-deploys [--json]
// ---------------------------------------------------------------------------
if ($cmd === 'failed-deploys') {
    $failures = [];
    $paceCount = 0;

    try {
        $sites = $forge->organizationSites($org)->lazy();
        foreach ($sites as $site) {
            // Check deployment_status field if available on the site object.
            $status = $site->deploymentStatus ?? $site->deployment_status ?? null;

            if ($status === null) {
                // No eager deployment_status — skip (scope deferred to gating).
                continue;
            }

            if (in_array($status, STATUS_FAILURE, true)) {
                // Fetch detail for this failure.
                $paceCount++;
                if ($paceCount % 10 === 0) {
                    // Conservative pacing: brief pause every 10 detail fetches.
                    sleep(2);
                }
                try {
                    $deployments = $forge->deployments($org, $site->serverId, $site->id);
                    $latest = null;
                    foreach ($deployments as $d) { $latest = $d; break; }

                    $failures[] = [
                        'site_id'    => $site->id,
                        'site_name'  => $site->name,
                        'server_id'  => $site->serverId,
                        'status'     => $status,
                        'deploy_id'  => $latest?->id,
                        'deploy_status' => $latest?->status,
                        'commit'     => $latest?->commit?->message ?? null,
                    ];
                } catch (\Throwable $e) {
                    if (str_contains($e->getMessage(), '429')) {
                        sleep(30);
                    }
                    $failures[] = [
                        'site_id'   => $site->id,
                        'site_name' => $site->name,
                        'server_id' => $site->serverId,
                        'status'    => $status,
                        'error'     => $e->getMessage(),
                    ];
                }
            }
        }
    } catch (\Throwable $e) {
        if (str_contains($e->getMessage(), '429')) {
            fwrite(STDERR, "Rate limited. Try again in a minute.\n");
            exit(1);
        }
        fwrite(STDERR, "Error scanning sites: " . $e->getMessage() . "\n");
        exit(1);
    }

    if ($hasJson) {
        echo json_encode($failures, JSON_PRETTY_PRINT) . "\n";
        exit(0);
    }

    if (count($failures) === 0) {
        echo "No failed deployments found.\n";
        exit(0);
    }

    echo count($failures) . " site(s) with failed latest deployment:\n";
    foreach ($failures as $f) {
        echo "  Site: {$f['site_name']} (ID: {$f['site_id']}, server: {$f['server_id']})\n";
        echo "    Status: {$f['status']}" . (isset($f['commit']) ? "  Commit: " . substr($f['commit'], 0, 80) : '') . "\n";
    }
    exit(0);
}

// ---------------------------------------------------------------------------
// Unknown command
// ---------------------------------------------------------------------------
fwrite(STDERR, "Unknown command '$cmd'. Run forge.php --help for usage.\n");
exit(1);
