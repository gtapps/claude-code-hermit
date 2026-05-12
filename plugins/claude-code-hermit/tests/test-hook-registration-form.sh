#!/usr/bin/env bash
# Contract test: every hooks.json entry fleet-wide uses exec form or the bash -c escape hatch.
# Guards against regressions to naked shell-form ${CLAUDE_PLUGIN_ROOT} interpolation.
# Usage: bash tests/test-hook-registration-form.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

MONOREPO_ROOT="$(cd "$REPO_ROOT/../.." && pwd)"
export MONOREPO_ROOT

echo "=== hook registration form contract ==="
echo ""

_form_check="$(mktemp)"
trap "rm -f '$_form_check'" EXIT
cat > "$_form_check" <<'PYEOF'
import json, sys, glob, os
monorepo = os.environ["MONOREPO_ROOT"]
ok = True
count = 0
for path in sorted(glob.glob(os.path.join(monorepo, "plugins/*/hooks/hooks.json"))):
    doc = json.load(open(path, encoding="utf-8"))
    for event, entries in doc.get("hooks", {}).items():
        for entry in entries:
            for h in entry.get("hooks", []):
                count += 1
                cmd = h.get("command", "")
                if "args" in h:
                    if " " in cmd or "$" in cmd:
                        print(f"FAIL {path} {event}: exec-form command has shell chars: {cmd!r}")
                        ok = False
                elif cmd.startswith("bash -c "):
                    pass  # documented escape hatch for stdin/jq/pipes work
                else:
                    print(f"FAIL {path} {event}: naked shell form: {cmd!r}")
                    ok = False
if count == 0:
    print(f"FAIL: no hook entries found under {monorepo}/plugins/*/hooks/hooks.json — path resolution likely broken")
    ok = False
sys.exit(0 if ok else 1)
PYEOF

run_test "form contract: all hook entries are exec-form or bash -c" \
  python3 "$_form_check"

print_results
