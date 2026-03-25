// scripts/session-diff.js — Stop hook (standard+ profile)
// Auto-populates the ## Changed section in SHELL.md with git diff stats.
//
// WORKTREE LIMITATION:
// Changes made in git worktrees (e.g., by the dev hermit's implementer agent)
// are only visible to git diff in the main worktree after the feature branch
// is merged back. If a session closes mid-implementation while changes are
// still on a worktree branch, this script will see an empty diff.
//
// This is by design — the dev hermit's implementer bridge (GAP-19) writes
// the file list from the agent's structured output during the session,
// before this Stop hook runs. Since this script checks "skip if ## Changed
// already has content," the implementer bridge has priority for dev sessions.
//
// This script serves as the fallback for:
// - Non-dev sessions (HA, DevOps, etc.) where changes are made directly
// - Dev sessions where the implementer wasn't used (direct edits)
// - Any session where the subagent didn't populate ## Changed

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MAX_STDIN = 1024 * 1024; // 1MB safety limit
const SHELL_SESSION = path.resolve(
  ".claude/.claude-code-hermit/sessions/SHELL.md",
);

function populateChanged() {
  // Only run if SHELL.md exists
  if (!fs.existsSync(SHELL_SESSION)) {
    return;
  }

  const original = fs.readFileSync(SHELL_SESSION, "utf-8");
  let content = original;

  // Skip if ## Changed already has non-comment content
  const changedMatch = content.match(/## Changed\n([\s\S]*?)(?=\n## |$)/);
  if (changedMatch) {
    const sectionContent = changedMatch[1].trim();
    if (sectionContent && !sectionContent.startsWith("<!--")) {
      // Already populated — don't overwrite manual or subagent entries
      return;
    }
  }

  // Get changed files since session start
  let diff = "";
  try {
    // Files changed in working tree + staged
    diff = execSync("git diff --name-status HEAD 2>/dev/null || true", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    // Also include committed-but-not-pushed changes if available
    const committed = execSync(
      "git diff --name-status @{upstream}..HEAD 2>/dev/null || true",
      { encoding: "utf-8", timeout: 5000 },
    ).trim();

    if (committed && !diff) {
      diff = committed;
    } else if (committed && diff) {
      // Merge both, deduplicate by filename
      const seen = new Set();
      const lines = [];
      for (const line of [...diff.split("\n"), ...committed.split("\n")]) {
        const file = line.split("\t").pop();
        if (file && !seen.has(file)) {
          seen.add(file);
          lines.push(line);
        }
      }
      diff = lines.join("\n");
    }
  } catch {
    // Not a git repo or git not available — fail silently
    return;
  }

  if (!diff) {
    return;
  }

  const STATUS_LABELS = { A: "added", M: "modified", D: "deleted" };

  const fileList = diff
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...fileParts] = line.split("\t");
      const file = fileParts.join("\t");
      const label = STATUS_LABELS[status]
        || (status.startsWith("R") ? "renamed" : "changed");
      return `- \`${file}\` (${label})`;
    })
    .join("\n");

  // Replace the ## Changed section
  const replacement = `## Changed\n${fileList}\n`;
  if (changedMatch) {
    content = content.replace(/## Changed\n[\s\S]*?(?=\n## |$)/, replacement);
  } else {
    // Append before ## Cost if it exists, otherwise at end
    const costIdx = content.indexOf("## Cost");
    if (costIdx !== -1) {
      content =
        content.slice(0, costIdx) + replacement + "\n" + content.slice(costIdx);
    } else {
      content += "\n" + replacement;
    }
  }

  if (content !== original) {
    fs.writeFileSync(SHELL_SESSION, content, "utf-8");
  }
}

async function main() {
  // Consume stdin to avoid broken pipe (content not used for diff)
  let totalSize = 0;
  for await (const chunk of process.stdin) {
    totalSize += chunk.length;
    if (totalSize > MAX_STDIN) break;
  }

  populateChanged();
}

main().catch(() => process.exit(0));
