#!/usr/bin/env bash
set -euo pipefail
exec php "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/../php/forge.php" "$@"
