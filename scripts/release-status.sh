#!/usr/bin/env bash
# Read-only snapshot of the release pipeline — `git status` for the marketplace.
# Prints the per-plugin table, then ERROR lines, then changelog-hygiene warnings,
# then one closing line naming what is ready to ship. No mutations.
#
# Usage: bash scripts/release-status.sh   (from anywhere; resolves its own root)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# The version number inside a `<slug>--v<X.Y.Z>` tag, empty when there is no tag.
last_tag_version() { git tag --list "$1--v*" | sort -V | tail -1 | sed "s/^$1--v//"; }

# Sorts as a version, so 1.0.9 < 1.0.22 rather than the string order.
version_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

# The [Unreleased] section's body, bounded by the next `## [` heading.
unreleased_body() { awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f && NF' "$1"; }

CORE_LATEST="$(last_tag_version hermitd)"
INITIAL="$(git rev-list --max-parents=0 HEAD | tail -1)"

errors=()
warnings=()
ready=()

printf '%-34s %-9s %-10s %-6s %-14s %s\n' Plugin Version 'Last Tag' Ahead Status 'Core Req'

for manifest in plugins/*/.claude-plugin/plugin.json; do
  [ -e "$manifest" ] || continue
  slug="$(basename "$(dirname "$(dirname "$manifest")")")"
  version="$(jq -r '.version // empty' "$manifest" 2>/dev/null)"
  tag_version="$(last_tag_version "$slug")"

  if [ -z "$version" ] || [ -z "$tag_version" ]; then
    printf '%-34s %-9s %-10s %-6s %-14s %s\n' "$slug" '—' '—' '—' 'unstructured' '(skip)'
    continue
  fi

  ahead="$(git rev-list "$slug--v$tag_version..HEAD" --count -- "plugins/$slug/" 2>/dev/null || echo 0)"
  changelog="plugins/$slug/CHANGELOG.md"
  unreleased=''
  [ -f "$changelog" ] && unreleased="$(unreleased_body "$changelog")"

  if version_gt "$version" "$tag_version"; then
    status='awaiting-tag'
  elif [ -n "$unreleased" ]; then
    status='prep-needed'
  else
    status='up-to-date'
  fi
  [ "$status" = 'up-to-date' ] || ready+=("$slug")

  # Domain plugins declare a core floor; core itself has none.
  core_req='—'
  meta="plugins/$slug/.claude-plugin/hermit-meta.json"
  if [ -f "$meta" ]; then
    floor="$(jq -r '.required_core_version // empty' "$meta" 2>/dev/null | sed 's/[^0-9.]//g')"
    if [ -n "$floor" ] && [ -n "$CORE_LATEST" ]; then
      if version_gt "$floor" "$CORE_LATEST"; then
        core_req=">=$floor ✗ ERROR: unsatisfied"
        errors+=("$slug requires core >=$floor, but the latest released core is $CORE_LATEST — release core first.")
      elif [ "$floor" = "$CORE_LATEST" ]; then
        core_req=">=$floor ✓"
      else
        core_req=">=$floor ⚠ stale (core: $CORE_LATEST)"
      fi
    elif [ -n "$floor" ]; then
      core_req=">=$floor"
    fi
  fi

  printf '%-34s %-9s %-10s %-6s %-14s %s\n' "$slug" "$version" "$tag_version" "$ahead" "$status" "$core_req"

  # Hygiene: a duplicated `### ` header inside [Unreleased] is a fragmented
  # changelog, the usual residue of parallel worktree merges.
  if [ -f "$changelog" ]; then
    dupes="$(awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f && /^### /' "$changelog" | sort | uniq -d | tr '\n' ' ')"
    [ -n "$dupes" ] && warnings+=("⚠ $slug: fragmented changelog — duplicate '${dupes% }' inside [Unreleased]; consolidate (one header per section, see /commit)")
  fi

  # Hygiene: merges since the last tag that touched the plugin but left its
  # CHANGELOG alone — usually a missing [Unreleased] bullet.
  base="$slug--v$tag_version"
  [ -n "$tag_version" ] || base="$INITIAL"
  silent=''
  count=0
  while read -r merge; do
    [ -n "$merge" ] || continue
    if ! git diff --name-only "$merge^1" "$merge" -- "$changelog" | grep -q .; then
      silent="$silent, $(git log -1 --format='%h %s' "$merge")"
      count=$((count + 1))
    fi
  done < <(git log --merges --format=%H "$base..HEAD" -- "plugins/$slug/" 2>/dev/null)
  [ "$count" -gt 0 ] && warnings+=("⚠ $slug: $count merge(s) since $base touched the plugin without a CHANGELOG entry: ${silent#, } — verify each is genuinely operator-invisible (pure refactor/test-only) or backfill a bullet.")
done

for line in ${errors[@]+"${errors[@]}"}; do echo "ERROR: $line"; done
for line in ${warnings[@]+"${warnings[@]}"}; do echo "$line"; done

if [ "${#ready[@]}" -eq 0 ]; then
  echo 'Nothing ready to ship.'
else
  printf 'Ready to ship: %s\n' "$(IFS=,; echo "${ready[*]}" | sed 's/,/, /g')"
fi
