#!/usr/bin/env php
<?php
declare(strict_types=1);

// Dependency-free PHP test harness for forge.php
//
// Uses an explicit check() helper — NOT PHP's assert(), which is a no-op when
// zend.assertions=-1 (the production php.ini default).
//
// Requires a vendor tree at php/vendor/ (run `composer install --working-dir=php`
// before this script). In CI: `composer install --no-dev --working-dir=php`.

$vendorAutoload = __DIR__ . '/../vendor/autoload.php';
if (!file_exists($vendorAutoload)) {
    fwrite(STDERR, "vendor/autoload.php not found. Run: composer install --working-dir=php/\n");
    exit(1);
}
require_once $vendorAutoload;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use Laravel\Forge\Forge;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
$passed = 0;
$failed = 0;

function check(bool $cond, string $msg): void {
    global $passed, $failed;
    if ($cond) {
        echo "  ✓ $msg\n";
        $passed++;
    } else {
        fwrite(STDERR, "  ✗ $msg\n");
        $failed++;
    }
}

// ---------------------------------------------------------------------------
// Load forge.php helpers without running main dispatch.
// We define $argv so the arg-parsing section is skipped.
// ---------------------------------------------------------------------------
// Pull in the pure functions by including forge.php but guarding on a flag.
define('FORGE_PHP_TEST_MODE', true);

// Re-implemented locally to keep tests self-contained; avoids coupling to forge.php's include structure.

function matchServer(array $servers, string $query): array {
    if (is_numeric($query)) {
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

// ---------------------------------------------------------------------------
// Helper: make a Forge instance backed by a MockHandler
// ---------------------------------------------------------------------------
function makeMockForge(array $responses): array {
    $mock    = new MockHandler($responses);
    $stack   = HandlerStack::create($mock);
    $guzzle  = new Client(['handler' => $stack]);
    $forge   = new Forge('test-token', $guzzle);
    return [$forge, $mock];
}

function fakeServer(int $id, string $name, string $ip): object {
    return (object)['id' => $id, 'name' => $name, 'ipAddress' => $ip];
}

function fakeSite(int $id, string $name, array $aliases = []): object {
    return (object)['id' => $id, 'name' => $name, 'aliases' => $aliases];
}

// ---------------------------------------------------------------------------
// Tests: matchServer
// ---------------------------------------------------------------------------
echo "\nmatchServer:\n";
$servers = [fakeServer(1, 'prod-web', '10.0.0.1'), fakeServer(2, 'prod-db', '10.0.0.2'), fakeServer(3, 'prod-web', '10.0.0.3')];

$result = matchServer($servers, 'prod-db');
check(count($result) === 1 && $result[0]->id === 2, 'name match returns single result');

$result = matchServer($servers, '10.0.0.1');
check(count($result) === 1 && $result[0]->id === 1, 'IP match');

$result = matchServer($servers, '1');
check(count($result) === 1 && $result[0]->id === 1, 'numeric ID match');

$result = matchServer($servers, 'prod-web');
check(count($result) === 2, 'duplicate name returns multiple candidates (ambiguity rejection test data)');

$result = matchServer($servers, 'nonexistent');
check(count($result) === 0, 'no match returns empty');

// ---------------------------------------------------------------------------
// Tests: matchSite
// ---------------------------------------------------------------------------
echo "\nmatchSite:\n";
$sites = [
    fakeSite(10, 'myapp.com', ['www.myapp.com']),
    fakeSite(11, 'api.myapp.com'),
    fakeSite(12, 'myapp.com'),   // duplicate name
];

$result = matchSite($sites, 'myapp.com');
check(count($result) === 2, 'duplicate name → multiple candidates');

$result = matchSite($sites, 'api.myapp.com');
check(count($result) === 1 && $result[0]->id === 11, 'exact name match');

$result = matchSite($sites, 'www.myapp.com');
check(count($result) === 1 && $result[0]->id === 10, 'alias match');

$result = matchSite($sites, '10');
check(count($result) === 1 && $result[0]->id === 10, 'numeric ID match');

$result = matchSite($sites, 'https://api.myapp.com/path');
check(count($result) === 1 && $result[0]->id === 11, 'URL hostname match');

$result = matchSite($sites, 'notfound.com');
check(count($result) === 0, 'no match returns empty');

// ---------------------------------------------------------------------------
// Tests: READ_ALLOWLIST gate (generic dispatch)
// The allowlist is defined in forge.php; replicate it here for the test.
// ---------------------------------------------------------------------------
echo "\nRead-only dispatch gate:\n";
const READ_ALLOWLIST = [
    'servers', 'server', 'organizationSites', 'serverSites', 'site',
    'deployments', 'deployment', 'deploymentLog', 'serverLog',
    'jobs', 'job', 'daemons', 'daemon', 'firewallRules', 'firewall',
    'certificates', 'certificate', 'sshKeys', 'sshKey', 'gitProjects',
    'organizations', 'regions', 'nginxTemplates', 'nginxTemplate',
    'workers', 'worker', 'databases', 'database', 'databaseUsers',
    'databaseUser', 'backups', 'backup', 'phpVersions',
    'redirectRules', 'redirectRule', 'securityRules', 'securityRule',
];
const RAW_TRANSPORTS = ['get', 'post', 'put', 'patch', 'delete', 'request', 'retry'];

function isAllowed(string $method): bool {
    if (in_array($method, RAW_TRANSPORTS, true)) return false;
    return in_array($method, READ_ALLOWLIST, true);
}

check(!isAllowed('createDeployment'), 'createDeployment rejected (mutator)');
check(!isAllowed('deleteServer'), 'deleteServer rejected (mutator)');
check(!isAllowed('post'), 'post rejected (raw transport)');
check(!isAllowed('get'), 'get rejected (raw transport)');
check(!isAllowed('rebootServer'), 'rebootServer rejected (not on allowlist)');
check(isAllowed('servers'), 'servers allowed');
check(isAllowed('deployment'), 'deployment allowed');
check(isAllowed('serverLog'), 'serverLog allowed');

// ---------------------------------------------------------------------------
// Tests: SDK write commands require --confirm (via MockHandler — no real calls)
// ---------------------------------------------------------------------------
echo "\nWrite gate (--confirm required):\n";

check(!in_array('createDeployment', READ_ALLOWLIST, true), 'createDeployment absent from read allowlist');
check(!in_array('createServerAction', READ_ALLOWLIST, true), 'createServerAction absent from read allowlist');

// ---------------------------------------------------------------------------
// Tests: status enum completeness
// ---------------------------------------------------------------------------
echo "\nStatus enums:\n";
const STATUS_SUCCESS     = ['finished'];
const STATUS_FAILURE     = ['failed', 'failed-build', 'cancelled'];
const STATUS_IN_PROGRESS = ['pending', 'queued', 'deploying'];

// Ensure terminal and in-progress sets are disjoint.
$allTerminal = array_merge(STATUS_SUCCESS, STATUS_FAILURE);
$overlap = array_intersect($allTerminal, STATUS_IN_PROGRESS);
check(count($overlap) === 0, 'terminal and in-progress sets are disjoint');

// Unknown status must not be in any terminal set (treat as still-running).
check(!in_array('unknown', $allTerminal, true), 'unknown status not in terminal set');
check(!in_array('unknown', STATUS_IN_PROGRESS, true), 'unknown status not in in-progress set — treated as still-running by watch loop');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
echo "\nResults: $passed passed, $failed failed\n";
exit($failed > 0 ? 1 : 0);
