// Shared helpers for reading YAML frontmatter from markdown files
// and listing files by pattern. Zero npm dependencies.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse YAML frontmatter from an already-read markdown string.
 * Returns { fm, end } where fm is key-value pairs (or null) and end is the
 * offset of the closing --- delimiter (-1 if no valid frontmatter found).
 * Arrays like [a, b, c] are parsed; null is preserved; inline comments stripped.
 */
function _parseFrontmatterWithEnd(content) {
  if (!content.startsWith('---')) return { fm: null, end: -1 };
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { fm: null, end: -1 };
  const yaml = content.slice(4, end);
  const result = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^(\w[\w_]*)\s*:\s*(.*)/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      result[key] = inner ? inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')) : [];
    } else if (val === 'null') {
      result[key] = null;
    } else {
      val = val.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
      result[key] = val;
    }
  }
  return { fm: result, end };
}

/**
 * Parse YAML frontmatter from an already-read markdown string.
 * Returns an object of key-value pairs, or null if no frontmatter found.
 * Arrays like [a, b, c] are parsed; null is preserved; inline comments stripped.
 */
function parseFrontmatter(content) {
  return _parseFrontmatterWithEnd(content).fm;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns an object of key-value pairs, or null if no frontmatter found.
 */
function readFrontmatter(filePath) {
  try {
    return parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a file and return both its frontmatter and body in one pass.
 * Body is the text after the closing --- delimiter, trimmed.
 * Returns { fm, body, content } or null on error.
 * fm may be null if no frontmatter; body is always the post-header text.
 */
function readFileWithFrontmatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const { fm, end } = _parseFrontmatterWithEnd(content);
    const body = end !== -1 ? content.slice(end + 4).trimStart() : content;
    return { fm, body, content };
  } catch {
    return null;
  }
}

/**
 * Given an array of artifacts with { fm } (each having fm.type and fm.created),
 * return a Map<type, artifact> keeping only the newest artifact per type.
 * Artifacts without fm or fm.created are skipped.
 */
function newestByType(artifacts) {
  const byType = new Map();
  for (const a of artifacts) {
    if (!a.fm || !a.fm.created) continue;
    const type = a.fm.type || '_untyped';
    const existing = byType.get(type);
    if (!existing || a.fm.created > existing.fm.created) {
      byType.set(type, a);
    }
  }
  return byType;
}

/**
 * List files in a directory matching a regex pattern.
 * Returns full paths sorted by name.
 */
function globDir(dir, pattern) {
  try {
    return fs.readdirSync(dir)
      .filter(f => pattern.test(f))
      .map(f => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Recursively list all .md files in a directory.
 * Returns full paths sorted by name.
 */
function globDirRecursive(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...globDirRecursive(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  } catch { /* directory doesn't exist or unreadable */ }
  return results.sort();
}

/**
 * Resolve an artifact_paths entry to a list of .md file paths.
 * Supports directories (recursive scan) and simple glob patterns (*.md, name-*.md).
 * baseDir is the project root.
 */
function resolveArtifactPath(baseDir, pathEntry) {
  const full = path.resolve(baseDir, pathEntry);
  if (!pathEntry.includes('*')) return globDirRecursive(full);
  // Glob pattern: match files in the parent directory
  const dir = path.dirname(full);
  const pattern = path.basename(full);
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  return globDir(dir, re);
}

module.exports = { parseFrontmatter, readFrontmatter, readFileWithFrontmatter, newestByType, globDir, globDirRecursive, resolveArtifactPath };
