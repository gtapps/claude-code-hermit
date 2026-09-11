#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
rc=0

bun "$SCRIPT_DIR/cli.test.ts" || rc=$?
bun "$SCRIPT_DIR/hatch-skill.test.ts" || rc=$?
bun "$SCRIPT_DIR/scribe-skill.test.ts" || rc=$?
bun test "$SCRIPT_DIR/native-permissions.test.ts" || rc=$?

exit $rc
