#!/usr/bin/env bun
/**
 * Expiry probe for core's own setup-token credential, declared in
 * .claude-plugin/hermit-meta.json and run by doctor's credential-expiry check.
 *
 * Protocol (doctor-check.ts runExpiryProbe): exactly one line of stdout —
 * OK | EXPIRED | EXPIRES:<iso8601>.
 *
 * A hermit not using token auth has no record and prints OK: there is nothing
 * to check, which is materially different from "expired". Note this probe never
 * reads the token file itself — expiry lives entirely in the record.
 *
 * Usage: bun scripts/setup-token-probe.ts [hermitDir]
 */

import { readTokenRecord } from './lib/setup-token';

const hermitDir = process.argv[2] || '.claude-code-hermit';

try {
  const record = readTokenRecord(hermitDir);
  if (!record) {
    console.log('OK');
  } else {
    console.log(`EXPIRES:${record.expires_at}`);
  }
} catch {
  // Never let a probe failure read as a credential problem; doctor reports an
  // unparseable line as "probe failed" on its own.
  console.log('OK');
}
