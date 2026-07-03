import fs from 'node:fs';
import path from 'node:path';

function parseFrontmatter(text: string) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { raw: m[1], fields, body: text.slice(m[0].length) };
}

function makeReporter() {
  let passed = 0;
  let failed = 0;
  function ok(name: string, cond: boolean, detail?: string) {
    if (cond) {
      console.log(`  ✓ ${name}`);
      passed += 1;
    } else {
      console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
      failed += 1;
    }
  }
  function summary(): number {
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    return failed;
  }
  return { ok, summary };
}

// Load a JSON fixture from tests/fixtures/. Shared by error-api.test.ts and
// precheck.test.ts so both spawn the CLI/precheck against identical canned
// responses.
function loadFixture<T = any>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', name), 'utf8'));
}

// Minimal JSON Response builder for the Bun.serve fixture servers in
// error-api.test.ts and precheck.test.ts.
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export { parseFrontmatter, makeReporter, loadFixture, jsonResponse };
