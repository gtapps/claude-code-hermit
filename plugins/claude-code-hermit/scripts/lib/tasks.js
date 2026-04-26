// Shared helper for reading native Claude Code task files.
// Claude Code stores tasks as JSON at ~/.claude/tasks/{list-id}/{n}.json.
// The task list ID comes from CLAUDE_CODE_TASK_LIST_ID env var.
//
// This is the ONLY place in the codebase that reads the task file format.
// If Claude Code changes the format, update here.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Read all non-deleted tasks from the active task list.
 * Returns an empty array if no task list is configured or no tasks exist.
 */
function readTasks() {
  const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
  if (!taskListId) return [];

  const taskDir = path.join(os.homedir(), '.claude', 'tasks', taskListId);
  const tasks = [];
  try {
    const files = fs.readdirSync(taskDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf-8'));
        if (task.status !== 'deleted') tasks.push(task);
      } catch {}
    }
  } catch {}

  tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  return tasks;
}

/**
 * Compute progress counts from a task array.
 */
function taskProgress(tasks) {
  const done = tasks.filter(t => t.status === 'completed').length;
  return { done, total: tasks.length };
}

module.exports = { readTasks, taskProgress };
