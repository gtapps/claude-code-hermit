// Unit tests for the shared {{PLACEHOLDER}} substitution engine.
//
// Usage: bun test tests/render-template.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import { renderTemplate } from '../scripts/lib/render-template';

describe('renderTemplate', () => {
  test('substitutes a single placeholder', () => {
    expect(renderTemplate('hello {{NAME}}', { NAME: 'world' })).toBe('hello world');
  });

  test('substitutes every occurrence of a placeholder', () => {
    expect(renderTemplate('{{X}}-{{X}}', { X: 'a' })).toBe('a-a');
  });

  test('empty-string value collapses the placeholder', () => {
    expect(renderTemplate('a{{GAP}}b', { GAP: '' })).toBe('ab');
  });

  test('multi-line values are inserted verbatim', () => {
    expect(renderTemplate('[{{BLOCK}}]', { BLOCK: 'l1\nl2' })).toBe('[l1\nl2]');
  });

  test('throws when an UPPER_SNAKE placeholder is left unsubstituted', () => {
    expect(() => renderTemplate('{{FOO}} {{BAR}}', { FOO: 'x' })).toThrow(/BAR/);
  });

  test('does not throw on literal {{...}} documentation prose (not a placeholder)', () => {
    expect(renderTemplate('marked {{...}} here', {})).toBe('marked {{...}} here');
  });

  test('does not treat lowercase {{tokens}} as placeholders', () => {
    expect(renderTemplate('{{lower}}', {})).toBe('{{lower}}');
  });
});
