// Contract test for CLAUDE-APPEND.md block markers across the whole fleet.
//
// evolve-plan.ts's block-bounds heuristic (markerOnward) used to silently
// mis-slice two shipped templates: dev-hermit's marker discovery picked up
// an unrelated leading "<!-- mode:standard-only -->" comment instead of its
// own block marker, and hermitd-laravel-forge's block was truncated to 6 of
// 77 lines by the first internal standalone "---" line. Both went unnoticed
// because no test ever ran the real bounds/marker logic against the real
// templates — existing coverage used idealized single-marker fixtures.
//
// This test makes that bug class unrepeatable: every plugin's CLAUDE-APPEND
// template must have a name-anchored opening marker, a matching closing
// marker as its last non-blank line, and markerOnward must return the full
// opening-to-closing span — not a truncated prefix.
//
// Usage: bun test tests/claude-append-markers-contract.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { MONOREPO_ROOT } from './helpers/run';
import { markerOnward, extractSiblingMarker, closingMarkerFor } from '../scripts/evolve-plan';

const PLUGINS_DIR = path.join(MONOREPO_ROOT, 'plugins');

function templates(): Array<{ plugin: string; templatePath: string }> {
  const out: Array<{ plugin: string; templatePath: string }> = [];
  for (const plugin of fs.readdirSync(PLUGINS_DIR)) {
    const templatePath = path.join(PLUGINS_DIR, plugin, 'state-templates', 'CLAUDE-APPEND.md');
    if (fs.existsSync(templatePath)) out.push({ plugin, templatePath });
  }
  return out;
}

describe('CLAUDE-APPEND templates: name-anchored marker + paired closing marker', () => {
  for (const { plugin, templatePath } of templates()) {
    const text = fs.readFileSync(templatePath, 'utf8');

    test(`${plugin}: extractSiblingMarker resolves a name-anchored opening marker`, () => {
      const marker = extractSiblingMarker(text, plugin);
      expect(marker).not.toBeNull();
      expect(marker!.startsWith(`<!-- ${plugin}:`)).toBe(true);
      expect(marker!.endsWith('-->')).toBe(true);
    });

    test(`${plugin}: closing marker is present and is the last non-blank line`, () => {
      const marker = extractSiblingMarker(text, plugin);
      expect(marker).not.toBeNull();
      const closing = closingMarkerFor(marker!);
      const lines = text.split('\n');
      let lastIdx = lines.length - 1;
      while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx--;
      expect(lines[lastIdx].trim()).toBe(closing);
    });

    test(`${plugin}: markerOnward returns the full opening-to-closing span, not a truncated prefix`, () => {
      const marker = extractSiblingMarker(text, plugin);
      expect(marker).not.toBeNull();
      const closing = closingMarkerFor(marker!);
      const lines = text.split('\n');
      const startIdx = lines.findIndex(l => l.trim() === marker);
      const closeIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === closing);
      expect(closeIdx).toBeGreaterThan(startIdx);

      const block = markerOnward(text, marker!);
      expect(block).not.toBeNull();
      const expectedLineCount = closeIdx - startIdx + 1;
      expect(block!.split('\n')).toHaveLength(expectedLineCount);
      expect(block!.trim().endsWith(closing)).toBe(true);
    });
  }
});
