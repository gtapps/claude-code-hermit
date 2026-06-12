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

# Extract version from plugin.json (simple grep — avoids interpreter startup)
PLUGIN_VER=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$PLUGIN_ROOT/.claude-plugin/plugin.json" | head -1 | grep -o '"[^"]*"$' | tr -d '"')
# Extract config version + always_on from config.json (two lines: version, then true|false)
# try/catch inside the snippet: bun exits 0 on uncaught fs errors, so a shell `||` fallback alone is not enough
CONFIG_OUT=$(bun -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log((c._hermit_versions ?? {})["claude-code-hermit"] ?? "0.0.0"); console.log(c.always_on === true ? "true" : "false"); } catch { console.log("0.0.0"); console.log("false"); }' "$CONFIG" 2>/dev/null || printf '0.0.0\nfalse\n')
CONFIG_VER=$(printf '%s\n' "$CONFIG_OUT" | sed -n '1p')
ALWAYS_ON=$(printf '%s\n' "$CONFIG_OUT" | sed -n '2p')

[ -z "$PLUGIN_VER" ] && exit 0
[ "$PLUGIN_VER" = "$CONFIG_VER" ] && exit 0

echo "---Upgrade Available---"
if [ "$ALWAYS_ON" = "true" ]; then
  echo "Plugin v${PLUGIN_VER} ≠ config v${CONFIG_VER}. REQUIRED: run /claude-code-hermit:hermit-evolve unattended NOW, before any other work this session."
else
  echo "Plugin v${PLUGIN_VER} ≠ config v${CONFIG_VER}. Run /claude-code-hermit:hermit-evolve"
fi
