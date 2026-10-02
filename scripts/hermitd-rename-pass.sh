#!/usr/bin/env bash
# Rerunnable, index-free distribution rename for the release branch.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

move() {
  if [ -e "$1" ]; then
    [ ! -e "$2" ] || { echo "Both rename paths exist: $1, $2" >&2; return 1; }
    mv "$1" "$2"
  fi
}
move plugins/claude-code-hermit plugins/hermitd
move plugins/claude-code-dev-hermit plugins/hermitd-dev
move plugins/claude-code-homeassistant-hermit plugins/hermitd-homeassistant
move plugins/claude-code-fitness-hermit plugins/hermitd-fitness
move plugins/feed-hermit plugins/hermitd-feed
move plugins/laravel-forge-hermit plugins/hermitd-laravel-forge
move plugins/hermit-scribe plugins/hermitd-scribe
for verb in attach docker pause run start status stop update watchdog; do
  move "plugins/hermitd/state-templates/bin/hermit-$verb" "plugins/hermitd/state-templates/bin/hermitd-$verb"
done
move plugins/hermitd/state-templates/host/hermit plugins/hermitd/state-templates/host/hermitd
for verb in cli docker exec pause start status stop update watchdog watchdog-install; do
  for file in plugins/hermitd/scripts/hermit-"$verb".*; do
    [ -e "$file" ] || continue
    move "$file" "${file%/*}/hermitd-${file##*/hermit-}"
  done
done
for verb in attach cli docker exec pause run start status stop update watchdog watchdog-install; do
  for file in plugins/hermitd/tests/hermit-"$verb".*; do
    [ -e "$file" ] || continue
    move "$file" "${file%/*}/hermitd-${file##*/hermit-}"
  done
done

python3 - <<'PY'
import pathlib
import re
import subprocess

excluded = {
    'scripts/hermitd-rename-pass.sh', 'scripts/migrate.sh',
    'tests/lib/migrate.test.ts', '.gitignore', '.worktreeinclude',
    # Hand-written migration content: old names are intentional, a rerun after merging main must leave them.
    'README.md', 'plugins/hermitd/scripts/settings-edit.ts', 'plugins/hermitd/tests/settings-edit.test.ts',
    'plugins/hermitd-homeassistant/tests/gate-corpus.test.ts',
}
names = {
    'claude-code-dev-hermit': 'hermitd-dev',
    'claude-code-homeassistant-hermit': 'hermitd-homeassistant',
    'claude-code-fitness-hermit': 'hermitd-fitness',
    'feed-hermit': 'hermitd-feed',
    'laravel-forge-hermit': 'hermitd-laravel-forge',
}
files = subprocess.check_output(['git', 'ls-files', '-co', '--exclude-standard', '-z']).decode().split('\0')
for name in sorted(set(files)):
    p = pathlib.Path(name)
    if (not name or not p.is_file() or p.is_symlink() or name in excluded
        or p.name == 'CHANGELOG.md' or p.suffix == '.legacy'
        or any(part in ('graphify-out', 'node_modules', 'vendor') for part in p.parts)
        or name.startswith('.claude-code-hermit/')
        or 'migrate-from-claude-code-hermit' in name
        or name.endswith('/scripts/apply-settings.ts')
        or re.search(r'/tests/apply-settings[^/]*\.test\.ts$', name)):
        continue
    try:
        old = p.read_text()
    except UnicodeDecodeError:
        continue
    lines = []
    for line in old.splitlines(keepends=True):
        if (name == 'CLAUDE.md' and 'Old standalone' in line) or 'migrate-from-claude-code-hermit' in line:
            lines.append(line)
            continue
        for source, target in names.items():
            line = line.replace(source, target)
        for source, target in (
            ('plugins/hermit-scribe', 'plugins/hermitd-scribe'),
            ('hermit-scribe:', 'hermitd-scribe:'),
            ('hermit-scribe@', 'hermitd-scribe@'),
            ('hermit-scribe--v', 'hermitd-scribe--v'),
        ):
            line = line.replace(source, target)
        if p.name in ('plugin.json', 'marketplace.json'):
            line = re.sub(r'("name"\s*:\s*)"hermit-scribe"', r'\1"hermitd-scribe"', line)
        for source, target in (
            ('gtapps/claude-code-hermit', 'gtapps/hermitd'),
            ('gtapps.github.io/claude-code-hermit', 'gtapps.github.io/hermitd'),
            ('@claude-code-hermit', '@hermitd'),
            ('claude-code-hermit:', 'hermitd:'),
            ('.claude-code-hermit', '.hermit'),
            ('claude-code-hermit', 'hermitd'),
        ):
            line = line.replace(source, target)
        line = re.sub(r'(?<!lib/)hermit-(attach|docker|pause|run|start|status|stop|update|watchdog|cli|exec)(?![\w-]|@)', r'hermitd-\1', line)
        line = line.replace('hermit-watchdog-install', 'hermitd-watchdog-install')
        line = re.sub(r'\bhermit (list|status|start|stop|restart|attach|update|prune|docker|pause|watchdog|run|install|register)\b', r'hermitd \1', line)
        lines.append(line)
    new = ''.join(lines)
    if new != old:
        p.write_text(new)
PY
