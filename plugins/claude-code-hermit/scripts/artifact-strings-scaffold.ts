// artifact-strings-scaffold.ts — prints the artifact-strings.json scaffold with
// every chrome key at its English default, for a language-set skill (hatch /
// hermit-settings) to translate the *values* in place and write to
// state/artifact-strings.json. Keeps DEFAULT_STRINGS the single source of keys —
// the model never hand-transcribes the key set.
// Usage: bun artifact-strings-scaffold.ts <language> [generatedISO]

import { DEFAULT_STRINGS } from './lib/artifact-strings';

const language = process.argv[2] || 'en';
const generated = process.argv[3] || '';
process.stdout.write(JSON.stringify({ language, generated, strings: DEFAULT_STRINGS }, null, 2) + '\n');
