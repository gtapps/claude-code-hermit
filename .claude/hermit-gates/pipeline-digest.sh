#!/usr/bin/env bash
# Wake gate for the pipeline-digest routine. Read-only: digest.ts only writes under `commit`.
out=$(bun .claude/skills/pipeline-digest/scripts/digest.ts "${HERMIT_DIR:-.hermit}" 2>/dev/null | head -1)
[ "$out" = "NOCHANGE" ] && echo SKIP || echo WAKE
exit 0
