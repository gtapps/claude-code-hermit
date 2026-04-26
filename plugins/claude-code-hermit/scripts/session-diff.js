// scripts/session-diff.js — Stop hook (standard+ profile)
// Captures git diff stats and writes to state/session-diff.json (sidecar file).
// session-mgr merges this into SHELL.md ## Changed during lifecycle transitions.
//
// This script does NOT write to SHELL.md — that eliminates the read-modify-write
// race between hooks and Claude editing SHELL.md.
//
// WORKTREE LIMITATION:
// Changes made in git worktrees are only visible to git diff in the main
// worktree after the feature branch is merged back. If a session closes
// mid-implementation while changes are still on a worktree branch, this
// script will see an empty diff. session-mgr handles merge from this sidecar.

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MAX_STDIN = 1024 * 1024; // 1MB safety limit
const SIDECAR_PATH = path.resolve(".claude-code-hermit/state/session-diff.json");
const SIDECAR_TMP = path.resolve(".claude-code-hermit/state/.session-diff.json.tmp");

const STATUS_LABELS = { A: "added", M: "modified", D: "deleted" };

function captureDiff() {
  let diff = "";
  try {
    // Files changed in working tree + staged
    diff = execSync("git diff --name-status HEAD", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // Not a git repo or git not available
    return null;
  }

  try {
    // Also include committed-but-not-pushed changes if available
    const committed = execSync(
      "git diff --name-status @{upstream}..HEAD",
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
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
    // No upstream configured or git error — use working-tree diff only
  }

  if (!diff) {
    return null;
  }

  const changedFiles = diff
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...fileParts] = line.split("\t");
      const file = fileParts.join("\t").replace(/[`\n\r]/g, "_");
      const label = STATUS_LABELS[status]
        || (status.startsWith("R") ? "renamed" : "changed");
      return { file, status: label };
    });

  return changedFiles;
}

function writeSidecar(changedFiles) {
  const data = {
    changed_files: changedFiles,
    captured_at: new Date().toISOString(),
  };

  // Atomic write: write to tmp, then rename
  fs.writeFileSync(SIDECAR_TMP, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(SIDECAR_TMP, SIDECAR_PATH);
}

const RUNTIME_JSON = path.resolve(".claude-code-hermit/state/runtime.json");
const DEBOUNCE_MS = 60 * 1000; // 60 seconds

// Exported run() function for use by stop-pipeline.js.
// Includes state-aware debounce: skips when in_progress and sidecar is fresh.
// Forces refresh when session state is not in_progress (archive is imminent).
// process.exit() calls become returns so the pipeline is not killed.
async function run(_payload) {
  // Profile gating — run on "standard" and "strict" only
  const profile = (process.env.AGENT_HOOK_PROFILE || "standard").trim().toLowerCase();
  if (profile === "minimal") {
    return;
  }

  // State-aware debounce
  let forceRefresh = false;
  try {
    const runtime = JSON.parse(fs.readFileSync(RUNTIME_JSON, "utf-8"));
    // Force refresh when not in_progress — session close/idle transition reads the sidecar
    if (runtime.session_state !== "in_progress") {
      forceRefresh = true;
    }
  } catch {
    // runtime.json missing — force refresh to be safe
    forceRefresh = true;
  }

  if (!forceRefresh) {
    try {
      const stat = fs.statSync(SIDECAR_PATH);
      if (Date.now() - stat.mtimeMs < DEBOUNCE_MS) {
        return; // sidecar is fresh enough during active work
      }
    } catch {
      // sidecar doesn't exist — run to create it
    }
  }

  const changedFiles = captureDiff();
  if (changedFiles && changedFiles.length > 0) {
    writeSidecar(changedFiles);
  }
}

module.exports = { run };

if (require.main === module) {
  (async () => {
    // Consume stdin to avoid broken pipe (content not used for diff)
    let totalSize = 0;
    for await (const chunk of process.stdin) {
      totalSize += chunk.length;
      if (totalSize > MAX_STDIN) break;
    }

    // Profile gating — run on "standard" and "strict" only
    const profile = (process.env.AGENT_HOOK_PROFILE || "standard").trim().toLowerCase();
    if (profile === "minimal") {
      process.exit(0);
    }

    const changedFiles = captureDiff();
    if (changedFiles && changedFiles.length > 0) {
      writeSidecar(changedFiles);
    }
  })().catch(() => process.exit(0));
}
