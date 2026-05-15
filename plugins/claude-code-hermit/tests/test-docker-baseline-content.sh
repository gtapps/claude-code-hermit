#!/usr/bin/env bash
# Content-assertion tests for the Docker baseline templates.
#
# Guards against accidental removal or layer-splitting of the gh install
# added in v1.0.40 (PROP-028, GH #82). No Docker daemon required — pure
# file inspection.
#
# Usage: bash tests/test-docker-baseline-content.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== Docker baseline content tests ==="
echo ""

DOCKERFILE="$REPO_ROOT/state-templates/docker/Dockerfile.hermit.template"
COMPOSE="$REPO_ROOT/state-templates/docker/docker-compose.hermit.yml.template"

# -------------------------------------------------------
# Dockerfile: gh apt source present
# -------------------------------------------------------
run_test "Dockerfile: cli.github.com apt source present" bash -c \
  "grep -q 'cli.github.com/packages' '$DOCKERFILE'"

run_test "Dockerfile: githubcli-archive-keyring.gpg fetched" bash -c \
  "grep -q 'githubcli-archive-keyring.gpg' '$DOCKERFILE'"

run_test "Dockerfile: gh installed via apt-get" bash -c \
  "grep -qE 'apt-get install.*--no-install-recommends gh' '$DOCKERFILE'"

# -------------------------------------------------------
# Dockerfile: gh install is in the same layer as the cleanup
# (regression guard: no accidental RUN split that produces a
# dangling apt-get update without a matching rm -rf)
# -------------------------------------------------------
run_test "Dockerfile: exactly one rm -rf /var/lib/apt/lists/ in base section (no layer split)" bash -c \
  "[ \$(grep -c 'rm -rf /var/lib/apt/lists' '$DOCKERFILE') -eq 1 ]"

run_test "Dockerfile: gh line appears before rm -rf (same layer ordering)" bash -c \
  "gh_line=\$(grep -n 'apt-get install.*--no-install-recommends gh' '$DOCKERFILE' | cut -d: -f1)
   rm_line=\$(grep -n 'rm -rf /var/lib/apt/lists' '$DOCKERFILE' | cut -d: -f1)
   [ -n \"\$gh_line\" ] && [ -n \"\$rm_line\" ] && [ \"\$gh_line\" -lt \"\$rm_line\" ]"

# -------------------------------------------------------
# Compose: HERMIT_GH_TOKEN mapped to GH_TOKEN
# -------------------------------------------------------
run_test "Compose: GH_TOKEN env var present" bash -c \
  "grep -q 'GH_TOKEN=' '$COMPOSE'"

run_test "Compose: GH_TOKEN uses HERMIT_GH_TOKEN source with empty-safe default" bash -c \
  "grep -q 'GH_TOKEN=\${HERMIT_GH_TOKEN:-}' '$COMPOSE'"

run_test "Compose: GH_TOKEN entry is in the environment block (indented with spaces)" bash -c \
  "grep -qE '^      - GH_TOKEN=' '$COMPOSE'"

print_results
