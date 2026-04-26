// Append-only JSONL helper — appends one line and exits.
// Zero npm dependencies, Node stdlib only.
// Usage: node append-metrics.js <jsonl-file-path> '<json-event-object>'

'use strict';

const fs = require('fs');

const filePath = process.argv[2];
const eventJson = process.argv[3];

if (!filePath || !eventJson) {
  console.error('Usage: node append-metrics.js <jsonl-file-path> \'<json-event-object>\'');
  process.exit(1);
}

// Validate JSON before appending
try {
  JSON.parse(eventJson);
} catch (err) {
  console.error(`Invalid JSON: ${err.message}`);
  process.exit(1);
}

fs.appendFileSync(filePath, eventJson + '\n', 'utf-8');
