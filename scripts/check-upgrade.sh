#!/usr/bin/env bash
# Check if the plugin version is newer than what the project was initialized with.
# Outputs "---Upgrade Available---" section if a gap is detected.
# Designed to be called from the SessionStart hook.
#
# Usage: bash scripts/check-upgrade.sh <plugin_root>
# Exit: always 0 (advisory only)

PLUGIN_ROOT="${1:-${CLAUDE_PLUGIN_ROOT}}"
CONFIG=".claude-code-hermit/config.json"

[ -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ] || exit 0
[ -f "$CONFIG" ] || exit 0

# Extract version from plugin.json (simple grep — avoids Python startup)
PLUGIN_VER=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$PLUGIN_ROOT/.claude-plugin/plugin.json" | head -1 | grep -o '"[^"]*"$' | tr -d '"')
# Extract config version from _hermit_versions.claude-code-hermit
CONFIG_VER=$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('_hermit_versions',{}).get('claude-code-hermit','0.0.0'))" "$CONFIG" 2>/dev/null || echo "0.0.0")

[ -z "$PLUGIN_VER" ] && exit 0
[ "$PLUGIN_VER" = "$CONFIG_VER" ] && exit 0

echo "---Upgrade Available---"
echo "Plugin v${PLUGIN_VER} ≠ config v${CONFIG_VER}. Run /claude-code-hermit:hermit-upgrade"
