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

// Test against the shipped code, not a re-implementation.
require_once __DIR__ . '/../forge-lib.php';

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use Laravel\Forge\CursorPaginator;
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
// Tests: phpLogKey
// ---------------------------------------------------------------------------
echo "\nphpLogKey:\n";
check(phpLogKey('php83') === 'php-8.3', "php83 -> php-8.3");
check(phpLogKey('php74') === 'php-7.4', "php74 -> php-7.4");
check(phpLogKey('php810') === 'php-8.10', "php810 -> php-8.10 (multi-digit minor)");
check(phpLogKey('nonsense') === null, "non-matching input returns null");
check(phpLogKey('') === null, "empty input returns null");

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
// Tests: B1 regression — paginator coercion
//
// servers() returns a CursorPaginator, not an array. resolveServer() must
// materialize it with iterator_to_array($p->lazy()) before calling matchServer
// (typed `array`); under declare(strict_types=1) the raw paginator/generator
// would be a fatal TypeError. This drives the REAL SDK paginator so a reverted
// coercion is caught.
// ---------------------------------------------------------------------------
echo "\nPaginator coercion (B1):\n";

$serversBody = json_encode(['data' => [
    ['id' => 1, 'name' => 'prod-web', 'ip_address' => '10.0.0.1'],
    ['id' => 2, 'name' => 'prod-db',  'ip_address' => '10.0.0.2'],
], 'meta' => ['next_cursor' => null]]);

[$forge] = makeMockForge([new Response(200, [], $serversBody)]);
$paginator = $forge->servers('my-org');
check($paginator instanceof CursorPaginator, 'servers() returns a CursorPaginator, not an array');

$threw = false;
try {
    // @phpstan-ignore-next-line — intentionally passing a non-array to prove the gate.
    matchServer($paginator->lazy(), 'prod-db');
} catch (\TypeError $e) {
    $threw = true;
}
check($threw, 'raw paginator/generator into matchServer() throws TypeError (coercion required)');

$materialized = iterator_to_array($paginator->lazy());
check(is_array($materialized), 'iterator_to_array(->lazy()) materializes to a plain array');
$resolved = matchServer($materialized, 'prod-db');
check(count($resolved) === 1 && $resolved[0]->id === 2, 'coerced paginator resolves through matchServer');

// ---------------------------------------------------------------------------
// Tests: READ_ALLOWLIST gate (generic dispatch) — constants from forge-lib.php
// ---------------------------------------------------------------------------
echo "\nRead-only dispatch gate:\n";

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
// Tests: NO_ORG_METHODS — org slug must not be prepended for global methods
// ---------------------------------------------------------------------------
echo "\nNo-org methods:\n";
check(in_array('organizations', NO_ORG_METHODS, true), 'organizations is org-less');
check(!in_array('servers', NO_ORG_METHODS, true), 'servers takes an org slug');
check(!in_array('organizationSites', NO_ORG_METHODS, true), 'organizationSites takes an org slug');

// ---------------------------------------------------------------------------
// Tests: SDK write commands are absent from the read allowlist
// ---------------------------------------------------------------------------
echo "\nWrite gate (--confirm required):\n";

check(!in_array('createDeployment', READ_ALLOWLIST, true), 'createDeployment absent from read allowlist');
check(!in_array('createServerAction', READ_ALLOWLIST, true), 'createServerAction absent from read allowlist');

// ---------------------------------------------------------------------------
// Tests: status enum completeness — constants from forge-lib.php
// ---------------------------------------------------------------------------
echo "\nStatus enums:\n";

// Ensure terminal and in-progress sets are disjoint.
$allTerminal = array_merge(STATUS_SUCCESS, STATUS_FAILURE);
$overlap = array_intersect($allTerminal, STATUS_IN_PROGRESS);
check(count($overlap) === 0, 'terminal and in-progress sets are disjoint');

// Unknown status must not be in any terminal set (treat as still-running).
check(!in_array('unknown', $allTerminal, true), 'unknown status not in terminal set');
check(!in_array('unknown', STATUS_IN_PROGRESS, true), 'unknown status not in in-progress set — treated as still-running by watch');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
echo "\nResults: $passed passed, $failed failed\n";
exit($failed > 0 ? 1 : 0);
