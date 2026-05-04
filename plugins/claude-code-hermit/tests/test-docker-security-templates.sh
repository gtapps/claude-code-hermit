#!/usr/bin/env bash
# Contract tests for the docker-security templates.
#
# These bugs (1.0.27 → 1.0.28) escaped because template content has no
# automated assertions: tee-vs-dnsmasq PID capture, missing capabilities,
# host bind mount under rootless Docker, slow healthcheck. This suite
# pattern-matches the templates and SKILL.md to lock those regressions
# down. No Docker daemon required — pure file inspection.
#
# Usage: bash tests/test-docker-security-templates.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== docker-security Template Contract Tests ==="
echo ""

ENTRYPOINT="$REPO_ROOT/state-templates/docker/security/netguard-entrypoint.sh.template"
SKILL="$REPO_ROOT/skills/docker-security/SKILL.md"

# -------------------------------------------------------
# Entrypoint: no tee-piping, no DNSMASQ_PID=$! capture
# -------------------------------------------------------
run_test "entrypoint: no 'tee -a' (regression: bug #1 + #2 cascade)" bash -c \
  "! grep -q 'tee -a' '$ENTRYPOINT'"

run_test "entrypoint: no 'DNSMASQ_PID=' assignment (regression: \$! captures tee)" bash -c \
  "! grep -q 'DNSMASQ_PID=' '$ENTRYPOINT'"

run_test "entrypoint: no '/var/log/netguard' references (regression: rootless bind mount)" bash -c \
  "! grep -q '/var/log/netguard' '$ENTRYPOINT'"

# -------------------------------------------------------
# Entrypoint: positive assertions
# -------------------------------------------------------
run_test "entrypoint: --log-facility=- on log-only dnsmasq line" bash -c \
  "grep -E 'dnsmasq -k --log-queries --log-facility=-' '$ENTRYPOINT'"

run_test "entrypoint: --log-facility=- on enforce dnsmasq line" bash -c \
  "grep -E 'dnsmasq -k --log-facility=- --conf-file' '$ENTRYPOINT'"

run_test "entrypoint: pgrep dnsmasq used for liveness check" bash -c \
  "grep -q 'pgrep dnsmasq' '$ENTRYPOINT'"

# -------------------------------------------------------
# SKILL.md: cap_add list (exact match — fails loud if any cap is missing,
# reordered, or extras are added without test coverage)
# -------------------------------------------------------
run_test "SKILL.md: cap_add list is [NET_ADMIN, NET_BIND_SERVICE, SETUID, SETGID]" bash -c \
  "grep -qF 'cap_add: [NET_ADMIN, NET_BIND_SERVICE, SETUID, SETGID]' '$SKILL'"

# -------------------------------------------------------
# SKILL.md: healthcheck has start_period
# -------------------------------------------------------
run_test "SKILL.md: healthcheck has start_period" bash -c \
  "grep -q 'start_period:' '$SKILL'"

# -------------------------------------------------------
# SKILL.md: no rootless-hostile bind mount
# -------------------------------------------------------
run_test "SKILL.md: no 'state:/var/log/netguard' bind mount (regression: rootless)" bash -c \
  "! grep -q 'state:/var/log/netguard' '$SKILL'"

print_results
