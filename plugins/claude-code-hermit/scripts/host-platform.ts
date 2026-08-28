#!/usr/bin/env bun
/**
 * CLI wrapper for the host platform probe (scripts/lib/platform.ts).
 *
 * `hatch` Step 1.5 calls this once and keeps the result for its deployment
 * question. Prints a single JSON object and always exits 0 — callers inspect
 * fields, not the exit code.
 *
 * Usage: bun host-platform.ts
 *   { "platform": "linux" | "macos" | "wsl2",
 *     "docker": true, "systemd": true, "launchd": false }
 */

import { detectPlatform } from './lib/platform';

if (import.meta.main) {
  console.log(JSON.stringify(detectPlatform()));
  process.exit(0);
}
