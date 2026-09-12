import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function run(...args: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'forge-cli-'));
  roots.push(root);
  const vendor = join(root, '.claude-code-hermit/forge-runtime/vendor');
  mkdirSync(vendor, { recursive: true });
  // Replace the SDK at its installed autoload boundary. No network client exists.
  writeFileSync(join(vendor, 'autoload.php'), `<?php
namespace Laravel\\Forge;
class Forge {
  public function __construct(string $token) {}
  private function page(array $items): object {
    return new class($items) {
      public function __construct(private array $items) {}
      public function lazy(): \\Generator { yield from $this->items; }
    };
  }
  public function servers(string $org): object {
    return $this->page([(object)['id'=>12, 'name'=>'test-server', 'ipAddress'=>'192.0.2.1']]);
  }
  public function serverSites(string $org, int $server): object {
    return $this->page([(object)['id'=>34, 'name'=>'test.example', 'aliases'=>[]]]);
  }
  public function createDeployment(string $org, int $server, int $site, array $data): object {
    file_put_contents(getenv('FORGE_TEST_REQUEST'), json_encode([$org, $server, $site, $data]));
    return (object)['id'=>56, 'status'=>'pending'];
  }
  public function createServerAction(string $org, int $server, array $data): void {
    file_put_contents(getenv('FORGE_TEST_REQUEST'), json_encode([$org, $server, $data]));
  }
}
`);
  const request = join(root, 'request.json');
  const result = Bun.spawnSync(['php', join(import.meta.dir, '../php/forge.php'), ...args], {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, FORGE_API_TOKEN: 'fixture', FORGE_ORG: 'test-org', FORGE_TEST_REQUEST: request },
  });
  return { result, request };
}

test('deploy executes the resolved request without a confirmation flag', () => {
  const { result, request } = run('deploy', 'test-server', 'test.example');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('deploy-id=56 server-id=12 site-id=34');
  expect(JSON.parse(readFileSync(request, 'utf8'))).toEqual(['test-org', 12, 34, []]);
});

test('reboot executes the resolved request without a confirmation flag', () => {
  const { result, request } = run('server-reboot', 'test-server');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(request, 'utf8'))).toEqual(['test-org', 12, { action: 'reboot' }]);
});

test('preview remains read-only and prints the flag-free command', () => {
  const { result, request } = run('preview-deploy', 'test-server', 'test.example');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('Run: forge.php deploy test-server test.example');
  expect(() => readFileSync(request)).toThrow();
});

test('invalid targets still fail before dispatch', () => {
  const { result, request } = run('server-reboot', 'missing-server');
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('No server matching');
  expect(() => readFileSync(request)).toThrow();
});
