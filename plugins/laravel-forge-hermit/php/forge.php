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
use Laravel\Forge\Exceptions\NotFoundException;

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
require_once __DIR__ . '/forge-operation.php';

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

/**
 * Print an SDK return value, scrubbed. Every generic result reaches the operator's
 * transcript through here — including free-form log strings, which is why the
 * scrubber sits at the output boundary rather than in the method-name policy.
 */
function printResult(mixed $result): void {
    // A CursorPaginator iterates page 1 only; ->lazy() walks every page, which is
    // what the curated read commands already do. Without this a `call servers` on
    // an estate larger than one page silently reports a truncated list.
    if ($result instanceof \Laravel\Forge\CursorPaginator) {
        $result = $result->lazy();
    }
    if (is_iterable($result)) {
        $rows = [];
        foreach ($result as $item) {
            $rows[] = is_object($item) && method_exists($item, 'toArray') ? $item->toArray() : (array) $item;
        }
        $out = json_encode($rows, JSON_PRETTY_PRINT);
    } elseif (is_object($result)) {
        $out = json_encode(method_exists($result, 'toArray') ? $result->toArray() : (array) $result, JSON_PRETTY_PRINT);
    } else {
        $out = json_encode($result, JSON_PRETTY_PRINT);
    }
    echo scrubSecrets((string) $out) . "\n";
}

/**
 * The method's real parameter list, minus the org slug (which generic dispatch
 * prepends). Printed on an argument mismatch so a caller can correct its JSON
 * without going and reading the vendored SDK.
 */
function signatureHint(string $method): string {
    $params = (new \ReflectionMethod(Forge::class, $method))->getParameters();
    if (takesOrgFirst($method)) {
        array_shift($params);   // the org slug is not part of the stdin array
    }
    $shown = array_map(function (\ReflectionParameter $p): string {
        $type = $p->getType() instanceof \ReflectionNamedType ? $p->getType()->getName() : 'mixed';
        return $type . ' $' . $p->getName() . ($p->isOptional() ? ' (optional)' : '');
    }, $params);

    return "Expected stdin JSON array: [" . implode(', ', $shown) . "]\n"
         . "The org slug is prepended automatically — do not include it.\n";
}

/**
 * Read the JSON argument array from stdin.
 *
 * Whitespace-only stdin means "no arguments", not an error — `echo | forge.php
 * call servers` sends a bare newline, and a caller who piped nothing meant to
 * pass nothing. A method that genuinely needed an argument then fails at the
 * capture with signatureHint(), which is a more useful message than a complaint
 * about stdin.
 */
function stdinArgs(): array {
    $stdin = stream_get_contents(STDIN);
    $decoded = ($stdin !== false && trim($stdin) !== '') ? json_decode(trim($stdin), true) : [];
    if (!is_array($decoded)) {
        // Catches both decode failure (null) and valid-but-non-array JSON
        // (a bare string/number would crash the ...spread at the call site).
        fwrite(STDERR, "stdin must be a JSON array of arguments (e.g. '[12]').\n");
        exit(1);
    }
    return $decoded;
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
    $ttl = intdiv(PLAN_TTL_SECONDS, 60);
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
      server-log <server> <key>   Read a server log by key (keys are hyphenated: nginx-error, nginx-access; 'php' auto-resolves to php-<major>.<minor>)
      site-log <server> <site> <type>  Read a site log (type: application, nginx-access, nginx-error)
      background-process-log <server> <process-id>  Fetch a background process's log output
      deploy-history <server> <site>          List recent deployments
      deploy-log <server> <site> <deploy-id>  Fetch a specific deployment log
      deploy-status <server-id> <site-id> <deploy-id>  Print a deployment's status (raw IDs)
      deploy-watch <server-id> <site-id> <deploy-id>   Poll a deployment until terminal; emits a single TERMINAL line

    Preview commands (read-only, never mutate):
      preview-deploy <server> <site>  Show canonical target before deploying
      preview-reboot <server>         Show canonical target before rebooting

    Write commands (require --confirm):
      deploy <server> <site>      Trigger deployment (fire-and-return; watch via deploy-watch)
      server-reboot <server>      Reboot server

    Estate scan:
      failed-deploys [--json]     Find sites with a failed latest deployment

    Generic dispatch (JSON args on stdin, org slug prepended automatically):
      policy                      Show what is reachable and what is denied (no credentials needed)
      call <sdk-method>           Any SDK read the policy allows
      preview <sdk-method>        Capture the exact request a write would send, store a single-use plan
      execute <plan-id>           Run an operator-approved plan, if it still hashes to what was approved

    A write is never executed from a flag. `preview` shows the real HTTP request and
    stores it under a hash; `execute` re-derives that request and refuses unless it
    still matches. Plans are single use and expire after {$ttl} minutes.

    USAGE;
    exit(1);
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
if ($cmd === 'check') {
    // Report any active policy lift alongside the credential state, so the hatch
    // and the doctor can see that this install has widened its own reach.
    $lifts = loadPolicy($projectRoot);
    if ($lifts['tiers_lifted'] !== [] || $lifts['methods_lifted'] !== []) {
        echo 'policy-lift: ' . implode(' ', array_merge(
            array_map(fn($t) => "tier:$t", $lifts['tiers_lifted']),
            array_map(fn($m) => "method:$m", $lifts['methods_lifted']),
        )) . "\n";
    }

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

// ---------------------------------------------------------------------------
// policy  (no credentials, no network — the whole point is that an agent can
// read the boundary it is operating under before it tries anything)
// ---------------------------------------------------------------------------
if ($cmd === 'policy') {
    $policy = loadPolicy($projectRoot);

    $reachable = count(array_filter(
        array_map(fn($m) => $m->getName(), (new \ReflectionClass(Forge::class))->getMethods(\ReflectionMethod::IS_PUBLIC)),
        'isEndpointMethod'
    ));

    $lifted = fn(string $tier) => in_array($tier, $policy['tiers_lifted'], true) ? 'LIFTED ' : 'DENIED ';

    echo "Every SDK endpoint method is reachable ($reachable installed) except the tiers below.\n";
    echo "Reads go through `call`. Writes require `preview` then `execute <plan-id>`.\n\n";

    echo "Shipped tiers\n";
    echo '  ' . $lifted('secrets') . " secrets      " . implode(', ', SECRET_METHODS) . "\n";
    echo "                        plus any method returning " . implode(' / ',
        array_map(fn($t) => substr((string) strrchr($t, '\\'), 1), SECRET_RETURN_TYPES)) . "\n";
    echo '  ' . $lifted('destructive') . " destructive  any operation whose captured HTTP verb is "
        . implode('/', DESTRUCTIVE_VERBS) . "\n\n";

    echo "Operator lifts in .env (the real boundary — the agent cannot edit .env)\n";
    echo '  FORGE_POLICY_ALLOW_TIERS  ' . ($policy['tiers_lifted'] === [] ? '(not set)' : implode(', ', $policy['tiers_lifted'])) . "\n";
    echo '  FORGE_POLICY_ALLOW        ' . ($policy['methods_lifted'] === [] ? '(not set)' : implode(', ', $policy['methods_lifted'])) . "\n\n";

    echo "Project denials in .claude-code-hermit/forge-policy.json\n";
    echo "  A reminder, not a boundary: the agent is allowed to edit this file.\n";
    echo '  ' . ($policy['project_deny'] === [] ? '(none)' : implode(', ', $policy['project_deny'])) . "\n";

    if ($policy['warnings'] !== []) {
        echo "\nWarnings\n";
        foreach ($policy['warnings'] as $w) echo "  $w\n";
    }
    exit(0);
}

// All other commands require a valid token.
requireToken($token);
$forge = new Forge($token);

// Org resolution can cost an API call, and 19 endpoint methods take no org slug
// at all, so it stays lazy for generic dispatch. `execute` never needs it: the
// plan froze the full argument list at preview time.
$resolveOrg = function () use (&$org, $forge): string {
    return $org = requireOrg($org, $forge);
};

// ---------------------------------------------------------------------------
// call <method>     generic read dispatch
// preview <method>  capture the exact request a write would send, store a plan
//
// Both start the same way: resolve the method, capture what it WOULD send
// without sending it, and apply the policy to that captured request. Nothing
// here predicts what a method does — the transport already knows.
// ---------------------------------------------------------------------------
if ($cmd === 'call' || $cmd === 'preview') {
    $method = $positional[0] ?? '';
    check($method !== '', "$cmd requires a method name. Usage: forge.php $cmd <method>");

    if (!isEndpointMethod($method)) {
        fwrite(STDERR, "'$method' is not a Forge API operation. Run forge.php policy to see what is reachable.\n");
        exit(1);
    }

    $callArgs = stdinArgs();
    if (takesOrgFirst($method)) {
        array_unshift($callArgs, $resolveOrg());
    }

    try {
        $captured = captureRequest($method, $callArgs);
    } catch (\TypeError $e) {
        // With 271 methods reachable, a wrong argument shape is the likely
        // mistake — print the real signature instead of an SDK stack trace.
        fwrite(STDERR, "Argument mismatch for '$method'.\n" . signatureHint($method));
        exit(1);
    }

    $isRead = $captured->getMethod() === 'GET';
    if ($cmd === 'call' && !$isRead) {
        fwrite(STDERR, "'$method' is a write ({$captured->getMethod()}). Use: forge.php preview $method\n");
        exit(1);
    }
    if ($cmd === 'preview' && $isRead) {
        fwrite(STDERR, "'$method' is a read. Use: forge.php call $method\n");
        exit(1);
    }

    $refusal = policyRefusal($method, $captured, loadPolicy($projectRoot));
    if ($refusal !== null) {
        fwrite(STDERR, $refusal . "\n");
        exit(1);
    }

    if ($cmd === 'call') {
        try {
            printResult($forge->$method(...$callArgs));
        } catch (\Throwable $e) {
            fwrite(STDERR, formatSdkError($e));
            exit(1);
        }
        exit(0);
    }

    // --- preview: show the operator the real request, then store it under a hash
    $path = canonicalPath($captured);

    echo "--- $method preview (no action taken) ---\n";
    // The canonical target comes from the CAPTURED URI, so it is right for every
    // method rather than for the ones whose signature we happened to know.
    //
    // This lookup is decoration, not the preview: the request is already captured
    // and its id is printed on the next line. resolveServer() exits on a miss and
    // lets SDK errors escape, so it is deliberately NOT reused here — an expired
    // token, a rate limit or a server absent from the listing must not abort a
    // preview with an uncaught fatal.
    if (preg_match('#/servers/(\d+)#', $path, $m) === 1) {
        try {
            $match = matchServer(iterator_to_array($forge->servers($resolveOrg())->lazy()), $m[1]);
            if ($match !== []) printCanonicalServer($match[0]);
        } catch (\Throwable $e) {
            fwrite(STDERR, "Note: could not resolve server {$m[1]} for display: {$e->getMessage()}\n");
        }
    }
    echo "{$captured->getMethod()} $path\n";

    $body = (string) $captured->getBody();
    if ($body !== '') {
        $pretty = json_encode(json_decode($body, true), JSON_PRETTY_PRINT);
        echo scrubSecrets($pretty === false ? $body : $pretty) . "\n";
    }

    $stateDir = $projectRoot . '/.claude-code-hermit';
    purgeExpiredPlans($stateDir);
    $planId = storePlan($stateDir, [
        'method' => $method,
        'args'   => $callArgs,
        'verb'   => $captured->getMethod(),
        'path'   => $path,
        'body'   => $body,
        'hash'   => planHash($captured),
    ]);

    $mins = intdiv(PLAN_TTL_SECONDS, 60);
    echo "Plan: $planId   expires " . gmdate('H:i', time() + PLAN_TTL_SECONDS) . " UTC ($mins min, single use)\n";
    echo "Relay the target and payload above, wait for the operator's approval, then run:\n";
    echo "  forge.php execute $planId\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// execute <plan-id>
//
// The only path that mutates through generic dispatch. It re-derives the request
// from the stored plan and refuses unless it still hashes to what was approved,
// so an edited payload, an expired window, or a reused plan sends nothing.
// ---------------------------------------------------------------------------
if ($cmd === 'execute') {
    $planId = $positional[0] ?? '';
    check($planId !== '', "execute requires a plan id. Usage: forge.php execute <plan-id>");

    try {
        printResult(executePlan($projectRoot . '/.claude-code-hermit', $planId, $forge, loadPolicy($projectRoot)));
    } catch (PlanRefusal $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        exit(1);
    } catch (\Throwable $e) {
        fwrite(STDERR, formatSdkError($e));
        exit(1);
    }
    exit(0);
}

// Everything below this line is a curated command, and all of them are
// org-scoped, so the lazy resolution above is settled once here.
$resolveOrg();

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
    $key    = $positional[1];

    if ($key === 'php') {
        $detail   = $forge->server($org, $server->id);
        $resolved = phpLogKey($detail->phpVersion ?? '');
        if ($resolved !== null) {
            $key = $resolved;
        }
    }

    try {
        $log = $forge->serverLog($org, $server->id, $key);
    } catch (NotFoundException $e) {
        fwrite(STDERR, "No log found for key '$key' on server {$server->name}. Either this key is wrong, or Forge doesn't track a log path for this service (common on servers with a custom, non-Forge-provisioned install of it). Check the server's installed services.\n");
        exit(1);
    }
    echo $log . "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// site-log <server> <site> <type>
// ---------------------------------------------------------------------------
if ($cmd === 'site-log') {
    check(isset($positional[2]), "Usage: forge.php site-log <server> <site> <application|nginx-access|nginx-error>");

    $methods = [
        'application'  => 'siteApplicationLog',
        'nginx-access' => 'siteNginxAccessLog',
        'nginx-error'  => 'siteNginxErrorLog',
    ];
    $type = $positional[2];
    if (!isset($methods[$type])) {
        fwrite(STDERR, "Unknown log type '$type'. Valid types: " . implode(', ', array_keys($methods)) . "\n");
        exit(1);
    }

    $server = resolveServer($forge, $org, $positional[0]);
    $site   = resolveSite($forge, $org, $server, $positional[1]);

    try {
        $log = $forge->{$methods[$type]}($org, $server->id, $site->id);
    } catch (NotFoundException $e) {
        fwrite(STDERR, "No $type log found for site {$site->name} on server {$server->name}.\n");
        exit(1);
    }
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
// background-process-log <server> <process-id>
// ---------------------------------------------------------------------------
if ($cmd === 'background-process-log') {
    check(isset($positional[1]), "Usage: forge.php background-process-log <server> <process-id>");
    $server    = resolveServer($forge, $org, $positional[0]);
    $processId = (int)$positional[1];   // SDK param is int; argv gives a string under strict_types
    try {
        $log = $forge->backgroundProcessLog($org, $server->id, $processId);
    } catch (NotFoundException $e) {
        fwrite(STDERR, "No background process $processId on server {$server->name}. List processes with: echo '[{$server->id}]' | forge.php call backgroundProcesses\n");
        exit(1);
    }
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
// Watching is decoupled: the forge-deploy skill arms a CC Monitor that runs
// `deploy-watch` until terminal, so a long deploy never blocks a foreground
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
    echo "Watch with: forge.php deploy-watch {$server->id} {$site->id} {$deployment->id}\n";
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
// deploy-watch <server-id> <site-id> <deploy-id>
//
// Polls deployment status until terminal or timeout (180 x 5s ~= 15 min),
// echoing only on change. Emits one TERMINAL line and exits 0. The TERMINAL
// line carries only numeric IDs — Forge server names can contain spaces,
// which would break the space-delimited fields.
// ---------------------------------------------------------------------------
if ($cmd === 'deploy-watch') {
    check(isset($positional[2]), "Usage: forge.php deploy-watch <server-id> <site-id> <deploy-id>");
    [$serverId, $siteId, $deployId] = $positional;
    $prev    = null;
    $prevErr = null;
    for ($n = 0; $n < 180; $n++) {
        try {
            $d  = $forge->deployment($org, (int)$serverId, (int)$siteId, (int)$deployId);
            $st = $d->status ?? 'unknown';
        } catch (\Throwable $e) {
            $st = null; // transient API error — keep polling
            // A permanent error (bad IDs, revoked token) would otherwise surface
            // only as an opaque `status=timeout` 15 minutes on. The watcher's
            // notification stream is stdout, so the signal goes there — but as
            // the exception class alone, holding the metadata-only contract
            // (messages can carry response bodies). The message goes to stderr,
            // which reaches the monitor's output file, never a notification.
            if (get_class($e) !== $prevErr) {
                $prevErr = get_class($e);
                echo "deploy {$deployId}: poll error ({$prevErr})\n";
                fwrite(STDERR, "deploy {$deployId}: poll error: {$e->getMessage()}\n");
            }
        }
        if ($st !== null) {
            if ($st !== $prev) {
                echo "deploy {$deployId}: {$st}\n";
            }
            if (isTerminalStatus($st)) {
                echo "TERMINAL deploy={$deployId} server-id={$serverId} site-id={$siteId} status={$st}\n";
                exit(0);
            }
        }
        $prev = $st;
        sleep(5);
    }
    echo "TERMINAL deploy={$deployId} server-id={$serverId} site-id={$siteId} status=timeout\n";
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
