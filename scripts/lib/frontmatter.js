// Shared helpers for reading YAML frontmatter from markdown files
// and listing files by pattern. Zero npm dependencies.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns an object of key-value pairs, or null if no frontmatter found.
 * Arrays like [a, b, c] are parsed; null is preserved; inline comments stripped.
 */
function readFrontmatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.startsWith('---')) return null;
    const end = content.indexOf('\n---', 3);
    if (end === -1) return null;
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
    return result;
  } catch {
    return null;
  }
}

/**
 * List files in a directory matching a regex pattern.
 * Returns full paths sorted by name.
 */
function globDir(dir, pattern) {
  try {
    return fs.readdirSync(dir)
      .filter(f => pattern.test(f))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

module.exports = { readFrontmatter, globDir };
