'use strict';

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { raw: m[1], fields, body: text.slice(m[0].length) };
}

function makeReporter() {
  let passed = 0;
  let failed = 0;
  function ok(name, cond, detail) {
    if (cond) {
      console.log(`  ✓ ${name}`);
      passed += 1;
    } else {
      console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
      failed += 1;
    }
  }
  function summary() {
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    return failed;
  }
  return { ok, summary };
}

module.exports = { parseFrontmatter, makeReporter };
